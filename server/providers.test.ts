import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import {
  existsSync,
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  listResources,
  openTerminal,
  installCanvasHelper,
  nativeSocketForSource,
  prepareOpenBridge,
  writeRemoteBridgeRegistry,
  closeProviderConnections,
  parseSshTarget,
  shellQuote,
  sourcePythonCommand,
  type Source,
} from "./providers.ts";

test("SSH arguments reject credentials, options and shell metacharacters", () => {
  assert.deepEqual(parseSshTarget("ssh://alice@example.test:2222"), {
    destination: "alice@example.test",
    port: "2222",
  });
  assert.deepEqual(parseSshTarget("workbox"), {
    destination: "workbox",
  });
  assert.equal(parseSshTarget("ssh://[::1]:2200").destination, "[::1]");
  for (const target of [
    "-oProxyCommand=x",
    "host;touch-file",
    "ssh://a:EXAMPLE@host",
    "ssh://host/path",
    "ssh://host?x",
    "ssh://host#x",
    "ssh://-host",
    "ssh://a%0ab@host",
  ]) {
    assert.throws(() => parseSshTarget(target), Error, target);
  }
  const value = "a'; $(touch /tmp/not-executed) `whoami`\n";
  assert.equal(
    execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], {
      encoding: "utf8",
    }),
    value,
  );
});

test("SSH file commands preserve exact arguments without allocating a terminal", () => {
  const source: Source = { id: "python-command", name: "Files", transport: "ssh", target: "ssh://alice@example.test:2222" };
  const values = ["quoted ' folder", "literal $HOME and `text`", "line\nnext", "中文", ""];
  const command = sourcePythonCommand(source, "import json,sys; print(json.dumps(sys.argv[1:]))", values);
  assert.equal(command.file, "ssh");
  assert.equal(command.args[0], "-T");
  assert(command.args.includes("StrictHostKeyChecking=yes"));
  assert.deepEqual(command.args.slice(-3, -1), ["--", "alice@example.test"]);
  assert.deepEqual(JSON.parse(execFileSync("/bin/sh", ["-c", command.args.at(-1)!], {
    encoding: "utf8", env: { PATH: process.env.PATH },
  })), values);
});

test("Canvas helper installation is atomic, idempotent, upgrades its managed version and preserves unrelated commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-helper-install-")), previousHome = process.env.HOME;
  process.env.HOME = root;
  const source: Source = { id: "helper-install", name: "Helper", transport: "local" };
  const helper = Buffer.from("#!/bin/sh\nprintf 'canvas helper\\n'\n");
  const target = join(root, ".local", "bin", "canvas");
  try {
    await installCanvasHelper(source, helper);
    assert.deepEqual(readFileSync(target), helper);
    assert.equal(statSync(target).mode & 0o777, 0o755);
    await installCanvasHelper(source, helper);
    assert.deepEqual(readFileSync(target), helper);
    const upgraded = Buffer.from("#!/bin/sh\nprintf 'updated helper\\n'\n");
    await installCanvasHelper(source, upgraded);
    assert.deepEqual(readFileSync(target), upgraded);
    assert.equal(statSync(target).mode & 0o777, 0o755);
    const otherHome = join(root, "other-home"); mkdirSync(otherHome);
    const previousHome = process.env.HOME; process.env.HOME = otherHome;
    try {
      mkdirSync(join(otherHome, ".local/bin"), { recursive: true });
      writeFileSync(join(otherHome, ".local/bin/canvas"), "unrelated command");
      await assert.rejects(installCanvasHelper(source, helper), /refusing to overwrite/u);
      assert.equal(readFileSync(join(otherHome, ".local/bin/canvas"), "utf8"), "unrelated command");
    } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; }
    await assert.rejects(installCanvasHelper(source, Buffer.alloc(8 * 1024 * 1024 + 1)), /size is invalid/u);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Canvas helper installers serialize concurrent installs and reject an older managed version", async () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-helper-concurrent-")), previousHome = process.env.HOME;
  process.env.HOME = root;
  const source: Source = { id: "helper-concurrent", name: "Helper", transport: "local" };
  const initial = Buffer.from("#!/bin/sh\nprintf initial\n"), upgraded = Buffer.from("#!/bin/sh\nprintf upgraded\n");
  const target = join(root, ".local/bin/canvas"), marker = join(root, ".local/bin/.canvas-managed-sha256");
  try {
    await Promise.all(Array.from({ length: 12 }, () => installCanvasHelper(source, initial)));
    assert.deepEqual(readFileSync(target), initial);
    await Promise.all(Array.from({ length: 12 }, () => installCanvasHelper(source, upgraded)));
    assert.deepEqual(readFileSync(target), upgraded);
    await assert.rejects(installCanvasHelper(source, initial), /previously replaced/u);
    assert.deepEqual(readFileSync(target), upgraded);
    const record = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(record.current, createHash("sha256").update(upgraded).digest("hex"));
    assert.equal(record.pending, undefined);
    assert.equal(statSync(join(root, ".local/state/canvas/helper-install.lock")).mode & 0o777, 0o600);
    assert(readdirSync(join(root, ".local/bin")).every(name => !name.endsWith(".tmp")));
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Canvas helper installation preserves a command created while waiting for its lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-helper-lock-")), previousHome = process.env.HOME;
  process.env.HOME = root;
  const source: Source = { id: "helper-lock", name: "Helper", transport: "local" };
  const state = join(root, ".local/state/canvas"), bin = join(root, ".local/bin");
  mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(bin, { mode: 0o700 });
  const locker = spawn("python3", ["-u", "-c", "import fcntl,os,sys; fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); fcntl.flock(fd,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()", join(state, "helper-install.lock")], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    await new Promise<void>((resolve, reject) => { locker.once("error", reject); locker.stdout.once("data", () => resolve()); });
    const result = installCanvasHelper(source, Buffer.from("#!/bin/sh\nprintf canvas\n"));
    // This write is independent of Canvas. A queued installer must read it only
    // after obtaining the lock and may never replace the new user command.
    writeFileSync(join(bin, "canvas"), "unrelated concurrently created command", { mode: 0o755 });
    locker.stdin.end();
    await assert.rejects(result, /refusing to overwrite/u);
    assert.equal(readFileSync(join(bin, "canvas"), "utf8"), "unrelated concurrently created command");
  } finally {
    locker.kill();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Canvas helper installation recovers pending installation journal crash points", async () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-helper-recovery-")), previousHome = process.env.HOME;
  const source: Source = { id: "helper-recovery", name: "Helper", transport: "local" };
  const before = Buffer.from("#!/bin/sh\nprintf before\n"), after = Buffer.from("#!/bin/sh\nprintf after\n");
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  try {
    for (const point of ["before-target", "after-target", "initial-link"]) {
      const home = join(root, point); mkdirSync(home); process.env.HOME = home;
      const bin = join(home, ".local/bin"); mkdirSync(bin, { recursive: true, mode: 0o700 });
      writeFileSync(join(bin, "canvas"), point === "after-target" || point === "initial-link" ? after : before, { mode: 0o755 });
      if (point === "initial-link") linkSync(join(bin, "canvas"), join(bin, ".canvas.interrupted.tmp"));
      writeFileSync(join(bin, ".canvas-managed-sha256"), JSON.stringify({ version: 1, current: point === "initial-link" ? null : hash(before), pending: hash(after), history: [] }), { mode: 0o600 });
      await installCanvasHelper(source, after);
      assert.deepEqual(readFileSync(join(bin, "canvas")), after);
      const record = JSON.parse(readFileSync(join(bin, ".canvas-managed-sha256"), "utf8"));
      assert.equal(record.current, hash(after)); assert.equal(record.pending, undefined);
      if (point !== "initial-link") assert(record.history.includes(hash(before)));
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Canvas helper installation uses the same managed transaction over SSH", async () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-helper-ssh-")), previousHome = process.env.HOME, previousPath = process.env.PATH;
  const home = join(root, "home ' with spaces"), path = join(root, "tools"); mkdirSync(home); mkdirSync(path);
  process.env.HOME = home; process.env.PATH = `${path}:${previousPath || "/usr/bin:/bin"}`;
  // Execute the exact generated remote shell command in an isolated local home.
  // No SSH connection, agent configuration or login rc is involved in this test.
  writeFileSync(join(path, "ssh"), '#!/bin/sh\nfor argument do command=$argument; done\nexec /bin/sh -c "$command"\n', { mode: 0o755 });
  const source: Source = { id: "helper-ssh", name: "Helper", transport: "ssh", target: "fixture.invalid" };
  const before = Buffer.from("#!/bin/sh\nprintf before\n"), after = Buffer.from("#!/bin/sh\nprintf after\n");
  try {
    await installCanvasHelper(source, before);
    await installCanvasHelper(source, after);
    assert.deepEqual(readFileSync(join(home, ".local/bin/canvas")), after);
    await assert.rejects(installCanvasHelper(source, before), /previously replaced/u);
    writeFileSync(join(home, ".local/bin/canvas"), "user edit");
    await assert.rejects(installCanvasHelper(source, after), /refusing to overwrite/u);
    assert.equal(readFileSync(join(home, ".local/bin/canvas"), "utf8"), "user edit");
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Canvas helper installation rejects changed helpers, unsafe modes and symlinked paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-helper-protection-")), previousHome = process.env.HOME;
  const source: Source = { id: "helper-protection", name: "Helper", transport: "local" };
  const before = Buffer.from("#!/bin/sh\nprintf before\n"), after = Buffer.from("#!/bin/sh\nprintf after\n");
  try {
    for (const attack of ["modified", "target-link", "marker-link", "lock-link", "directory-link", "writable-bin", "writable-target", "writable-marker"]) {
      const home = join(root, attack); mkdirSync(home); process.env.HOME = home;
      await installCanvasHelper(source, before);
      const bin = join(home, ".local/bin"), target = join(bin, "canvas"), marker = join(bin, ".canvas-managed-sha256"), victim = join(home, "untouched");
      writeFileSync(victim, "untouched", { mode: 0o600 });
      if (attack === "modified") writeFileSync(target, "my modified command");
      if (attack === "target-link" || attack === "marker-link" || attack === "lock-link") {
        const path = attack === "target-link" ? target : attack === "marker-link" ? marker : join(home, ".local/state/canvas/helper-install.lock");
        rmSync(path); symlinkSync(victim, path);
      }
      if (attack === "directory-link") { rmSync(bin, { recursive: true }); mkdirSync(join(home, "other-bin")); symlinkSync(join(home, "other-bin"), bin); }
      if (attack === "writable-bin") chmodSync(bin, 0o777);
      if (attack === "writable-target") chmodSync(target, 0o777);
      if (attack === "writable-marker") chmodSync(marker, 0o644);
      await assert.rejects(installCanvasHelper(source, after));
      assert.equal(readFileSync(victim, "utf8"), "untouched");
      if (attack === "modified") assert.equal(readFileSync(target, "utf8"), "my modified command");
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Canvas helper accepts owner-managed group-writable parent directories without changing their permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-helper-parent-mode-")), previousHome = process.env.HOME;
  process.env.HOME = root;
  const parents = [join(root, ".local"), join(root, ".local/bin"), join(root, ".local/state")];
  try {
    for (const directory of parents) { mkdirSync(directory, { recursive: true }); chmodSync(directory, 0o775); }
    await installCanvasHelper({ id: "parent-mode", name: "Fixture", transport: "local" }, Buffer.from("#!/bin/sh\nexit 0\n"));
    for (const directory of parents) assert.equal(statSync(directory).mode & 0o777, 0o775);
    assert.equal(statSync(join(root, ".local/state/canvas")).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, ".local/bin/canvas")).mode & 0o777, 0o755);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("SSH herdr discovers native sockets and shares direct API forwarding without a herdr executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-herdr-ssh-"));
  const remoteDir = join(root, "remote ' session");
  const requests = join(root, "requests");
  const forwards = join(root, "forwards");
  const previousPath = process.env.PATH;
  const source: Source = {
    id: "remote-local-client",
    name: "Remote",
    transport: "ssh",
    target: "ssh://alice@example.test",
    herdrSession: "work",
    herdrSocket: join(remoteDir, "herdr.sock"),
  };
  const remote = createServer((socket) =>
    socket.on("data", (data) => socket.write(data)),
  );
  const api = createServer(socket => {
    let input = "";
    socket.on("data", data => {
      input += data.toString(); if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!);
      assert.equal(request.method, "session.snapshot");
      socket.end(JSON.stringify({ id: request.id, result: { snapshot: { workspaces: [{ workspace_id: "space", label: "Space" }], tabs: [{ workspace_id: "space", tab_id: "tab", label: "Window" }],
        panes: [{ pane_id: "pane", tab_id: "tab", terminal_title_stripped: " \x1b\x07" + "中🙂".repeat(600) + "\x9f " }] } } }) + "\n");
    });
  });
  let first: Awaited<ReturnType<typeof openTerminal>> | undefined;
  let second: Awaited<ReturnType<typeof openTerminal>> | undefined;
  try {
    mkdirSync(remoteDir);
    await Promise.all([
      new Promise<void>((resolve) =>
        remote.listen(join(remoteDir, "herdr-client.sock"), resolve),
      ),
      new Promise<void>((resolve) =>
        api.listen(join(remoteDir, "herdr.sock"), resolve),
      ),
    ]);
    writeFileSync(
      join(root, "ssh"),
      `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('-O')) process.exit(0);
if (!args.includes('-N')) {
  const remoteCommand=args.at(-1), input=remoteCommand.startsWith('python3 -c ')?fs.readFileSync(0):undefined;
  const result = cp.spawnSync('/bin/sh', ['-c', remoteCommand], {
    encoding:'utf8', input, env:{PATH:${JSON.stringify(root)},HOME:${JSON.stringify(root)}}
  });
  if(result.status) process.stderr.write('synthetic remote command failed ('+result.status+'): '+result.stderr+' '+result.stdout);
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status || 0);
}
fs.appendFileSync(${JSON.stringify(forwards)}, String(process.pid) + '\\n');
const sockets = new Set();
const reverseListeners = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '-L') continue;
  const value=args[++index], split=value.indexOf(':');
  net.createServer((incoming)=>{
    const outgoing=net.createConnection(value.slice(split+1));
    sockets.add(incoming); sockets.add(outgoing);
    incoming.pipe(outgoing); outgoing.pipe(incoming);
    incoming.on('error',()=>outgoing.destroy()); outgoing.on('error',()=>incoming.destroy());
    incoming.on('close',()=>sockets.delete(incoming)); outgoing.on('close',()=>sockets.delete(outgoing));
  }).listen(value.slice(0,split));
}
for (let index=0; index<args.length; index++) {
  if(args[index]!=='-R') continue;
  const value=args[++index], split=value.indexOf(':'), remote=value.slice(0,split), local=value.slice(split+1);
  const listener=net.createServer(incoming=>{
    const outgoing=net.createConnection(local); sockets.add(incoming);sockets.add(outgoing);
    incoming.pipe(outgoing);outgoing.pipe(incoming);
    incoming.on('error',()=>outgoing.destroy());outgoing.on('error',()=>incoming.destroy());
    incoming.on('close',()=>sockets.delete(incoming));outgoing.on('close',()=>sockets.delete(outgoing));
  });
  listener.listen(remote);reverseListeners.push(listener);
}
process.on('SIGTERM',()=>{ for(const socket of sockets) socket.destroy(); for(const listener of reverseListeners) listener.close(); process.exit(0); });
`,
      { mode: 0o700 },
    );
    symlinkSync("/usr/bin/env", join(root, "env"));
    symlinkSync("/bin/sh", join(root, "sh"));
    for (const [name, binary] of [["realpath", "/usr/bin/realpath"], ["mkdir", "/bin/mkdir"], ["rmdir", "/bin/rmdir"], ["sleep", "/bin/sleep"], ["python3", "/usr/bin/python3"]])
      symlinkSync(binary, join(root, name));
    writeFileSync(join(root, "herdr"), `#!/bin/sh\nprintf forbidden >> ${shellQuote(requests)}\nexit 97\n`, { mode: 0o700 });
    process.env.PATH = root;
    const nativeSocket = await nativeSocketForSource(source);
    assert.equal(nativeSocket, execFileSync("realpath", [join(remoteDir, "herdr.sock")], { encoding: "utf8" }).trim());
    [first, second] = await Promise.all([
      openTerminal(source, "space", "tab"),
      openTerminal(source, "space", "tab"),
    ]);
    assert.equal(typeof first.connect, "function");
    assert.equal(readFileSync(forwards, "utf8").trim().split("\n").length, 1);
    const window = (await listResources(source)).spaces[0]!.windows[0]!;
    assert.equal(window.id, "tab");
    assert.equal(window.panes[0]?.terminalTitle, "中🙂".repeat(512), "pane title strips controls and bounds Unicode codepoints without splitting emoji");
    await second.cleanup(); second = undefined;
    assert.equal((await listResources(source)).status, "online");
    assert.equal(readFileSync(forwards, "utf8").trim().split("\n").length, 1, "one native handle keeps both forwards alive");
    await first.cleanup(); await first.cleanup(); first = undefined;
    const forwardingCount = () => readFileSync(forwards, "utf8").trim().split("\n").length;
    await assert.rejects(openTerminal(source, "space", "missing"), /no longer belongs/u);
    assert.equal(forwardingCount(), 2, "failed preparation can open a fresh discovery tunnel");
    first = await openTerminal(source, "space", "tab");
    assert.equal(forwardingCount(), 3, "failed preparation releases its tunnel before the next attach");
    await first.cleanup(); first = undefined;
    assert.equal(existsSync(requests), false, "neither discovery nor API calls execute herdr");

    const localBridgeSocket = join(root, "open.sock"), bridgeServer = createServer(socket => socket.on("data", data => socket.write(Buffer.concat([Buffer.from("download:"), Buffer.isBuffer(data) ? data : Buffer.from(data)]))));
    await new Promise<void>(resolve => bridgeServer.listen(localBridgeSocket, resolve));
    const bridge = await prepareOpenBridge(source, localBridgeSocket);
    assert.equal(bridge.nativeSocket, nativeSocket);
    assert.ok(bridge.remoteSocket?.startsWith("/tmp/canvas-bridge-"));
    await closeProviderConnections(source.id);
    assert.equal(bridge.remoteSocket && existsSync(dirname(bridge.remoteSocket)), true, "idle provider cleanup keeps the Canvas download forward alive");
    const fetched = await new Promise<string>((resolve, reject) => {
      const connection = createConnection(bridge.remoteSocket!);
      connection.once("connect", () => connection.write("ticket"));
      connection.once("data", data => { connection.destroy(); resolve(data.toString()); });
      connection.once("error", reject);
    });
    assert.equal(fetched, "download:ticket");
    const record = { version: 1 as const, nativeSocket, socket: bridge.remoteSocket!, secret: randomUUID().replaceAll("-", "").repeat(2) };
    const removeRecord = await writeRemoteBridgeRegistry(source, record);
    const registryDirectory = join(root, ".local/state/canvas/bridges"), registryName = readdirSync(registryDirectory)[0]!;
    assert.equal(statSync(join(registryDirectory, registryName)).mode & 0o777, 0o600);
    await removeRecord();
    assert.equal(readdirSync(registryDirectory).length, 0);
    await bridge.cleanup();
    assert.equal(existsSync(dirname(bridge.remoteSocket!)), false);
    await new Promise<void>(resolve => bridgeServer.close(() => resolve()));
  } finally {
    await first?.cleanup();
    await second?.cleanup();
    await closeProviderConnections(source.id);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await Promise.all(
      [remote, api].map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    rmSync(root, { recursive: true, force: true });
  }
});
