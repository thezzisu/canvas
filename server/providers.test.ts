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
import * as pty from "node-pty";
import {
  createSpace,
  createWindow,
  closeSpace,
  closeWindow,
  listResources,
  openTerminal,
  installCanvasHelper,
  nativeSocketForSource,
  prepareOpenBridge,
  writeRemoteBridgeRegistry,
  closeProviderConnections,
  NativeGeometryConflictError,
  parseSshTarget,
  renameSpace,
  renameWindow,
  shellQuote,
  sourceCommand,
  type Source,
} from "./providers.ts";

test("SSH arguments reject credentials, options and shell metacharacters", () => {
  assert.deepEqual(parseSshTarget("ssh://alice@example.test:2222"), {
    destination: "alice@example.test",
    host: "example.test:2222",
    port: "2222",
  });
  assert.deepEqual(parseSshTarget("workbox"), {
    destination: "workbox",
    host: "workbox",
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

test("native socket discovery returns tmux's canonical socket path", async (t) => {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); }
  catch { t.skip("tmux is not installed"); return; }
  const root = mkdtempSync(join(tmpdir(), "canvas-native-socket-"));
  const socket = join(root, "tmux.sock");
  const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
  const source: Source = { id: "native-socket", name: "Socket", type: "tmux", transport: "local", tmuxSocket: socket };
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "socket-test");
    const expected = execFileSync("realpath", [socket], { encoding: "utf8" }).trim();
    assert.equal(await nativeSocketForSource(source), expected);
    assert.equal(await nativeSocketForSource({ ...source, id: "alias" }), expected);
  } finally {
    try { tmux("kill-server"); } catch { /* fixture already stopped */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Canvas helper installation is atomic, idempotent, upgrades its managed version and preserves unrelated commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-helper-install-")), previousHome = process.env.HOME;
  process.env.HOME = root;
  const source: Source = { id: "helper-install", name: "Helper", type: "tmux", transport: "local" };
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
  const source: Source = { id: "helper-concurrent", name: "Helper", type: "tmux", transport: "local" };
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
  const source: Source = { id: "helper-lock", name: "Helper", type: "tmux", transport: "local" };
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
  const source: Source = { id: "helper-recovery", name: "Helper", type: "tmux", transport: "local" };
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
  const source: Source = { id: "helper-ssh", name: "Helper", type: "tmux", transport: "ssh", target: "fixture.invalid" };
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
  const source: Source = { id: "helper-protection", name: "Helper", type: "tmux", transport: "local" };
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
    await installCanvasHelper({ id: "parent-mode", name: "Fixture", type: "tmux", transport: "local" }, Buffer.from("#!/bin/sh\nexit 0\n"));
    for (const directory of parents) assert.equal(statSync(directory).mode & 0o777, 0o775);
    assert.equal(statSync(join(root, ".local/state/canvas")).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, ".local/bin/canvas")).mode & 0o777, 0o755);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote tmux clients resolve user installs without login rc and preserve exact arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-remote-client-"));
  const home = join(root, "home with 'quotes' and $variables");
  const path = join(root, "ssh-path");
  const source: Source = {
    id: "remote",
    name: "Remote",
    type: "tmux",
    transport: "ssh",
    target: "ssh://alice@example.test",
    tmuxSocket: "session ' ; $(printf injected) `whoami`",
  };
  const install = (directory: string, program: string, marker: string) => {
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, program);
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s\\0' ${shellQuote(marker)} "$@" "\${TMUX-unset}" "\${HERDR_SESSION-unset}" "$TERM"\n`,
      { mode: 0o700 },
    );
    return executable;
  };
  const execute = (connection = source, args = ["list-sessions"]) => {
    const command = sourceCommand(connection, args);
    assert.equal(command.file, "ssh");
    return execFileSync("/bin/sh", ["-c", command.args.at(-1)!], {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: path,
        TMUX: "inherited-session",
        HERDR_SESSION: "inherited-session",
      },
    })
      .split("\0")
      .slice(0, -1);
  };
  try {
    mkdirSync(path, { recursive: true });
    mkdirSync(home, { recursive: true });
    symlinkSync("/usr/bin/env", join(path, "env"));
    symlinkSync("/bin/sh", join(path, "sh"));
    // Loading these files would both corrupt the protocol and create a marker.
    const rcMarker = join(root, "rc-loaded");
    for (const rc of [".profile", ".bashrc", ".zshrc"])
      writeFileSync(
        join(home, rc),
        `echo rc-output\n: > ${shellQuote(rcMarker)}\n`,
      );
    const args = [
      "rename-window",
      "-t",
      "@7",
      "quotes ' ; $(printf injected) `whoami`\nnext",
    ];
    const expectedTail = [
      "-L",
      source.tmuxSocket!,
      ...args,
      "unset",
      "unset",
      "xterm-256color",
    ];
    install(join(home, ".cargo/bin"), "tmux", "cargo");
    assert.deepEqual(execute(source, args), ["cargo", ...expectedTail]);
    install(join(home, ".local/bin"), "tmux", "local");
    assert.deepEqual(execute(source, args), ["local", ...expectedTail]);
    install(path, "tmux", "path");
    assert.deepEqual(execute(source, args), ["path", ...expectedTail]);
    const canvasClient = install(
      join(home, ".local/share/canvas/bin"),
      "tmux",
      "canvas",
    );
    // A bundled executable is not used implicitly; PATH keeps precedence.
    assert.deepEqual(execute(source, args), ["path", ...expectedTail]);
    // An explicit path/name is authoritative, even when a Canvas client exists.
    assert.deepEqual(execute({ ...source, binary: "tmux" }, args), [
      "path",
      ...expectedTail,
    ]);
    const custom = install(
      join(root, "custom ' executable"),
      "tmux",
      "custom",
    );
    assert.deepEqual(execute({ ...source, binary: custom }, args), [
      "custom",
      ...expectedTail,
    ]);
    assert.equal(existsSync(rcMarker), false);
    // A directory is not a usable executable, even if its mode is executable.
    rmSync(canvasClient);
    mkdirSync(canvasClient);
    assert.deepEqual(execute(source, args), ["path", ...expectedTail]);
    rmSync(join(path, "tmux"));
    install(join(home, ".local/bin"), "tmux", "tmux-local");
    assert.deepEqual(
      execute({ ...source, type: "tmux", tmuxSocket: "socket ' name" }, [
        "list-sessions",
      ]),
      [
        "tmux-local",
        "-L",
        "socket ' name",
        "list-sessions",
        "unset",
        "unset",
        "xterm-256color",
      ],
    );
    for (const binary of ["-option", "bad\ncommand", "bad\0command"])
      assert.throws(() => sourceCommand({ ...source, binary }, []));
  } finally {
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
    type: "herdr",
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
      socket.end(JSON.stringify({ id: request.id, result: { snapshot: { workspaces: [{ workspace_id: "space", label: "Space" }], tabs: [{ workspace_id: "space", tab_id: "tab", label: "Window" }] } } }) + "\n");
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
      openTerminal(source, "space", "tab", 100, 30),
      openTerminal(source, "space", "tab", 100, 30),
    ]);
    assert.equal(typeof first.connect, "function");
    assert.equal(first.file, undefined); assert.equal(first.args, undefined);
    assert.equal(first.geometryMode, "client");
    assert.equal(readFileSync(forwards, "utf8").trim().split("\n").length, 1);
    assert.equal((await listResources(source)).spaces[0]!.windows[0]!.id, "tab");
    await second.cleanup(); second = undefined;
    assert.equal((await listResources(source)).status, "online");
    assert.equal(readFileSync(forwards, "utf8").trim().split("\n").length, 1, "one native handle keeps both forwards alive");
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
    const record = { version: 1 as const, provider: "herdr" as const, nativeSocket, socket: bridge.remoteSocket!, secret: randomUUID().replaceAll("-", "").repeat(2) };
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

test("tmux failed PTY preparation retains recovery until native cleanup", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "canvas-restore-failure-"));
  const socket = join(root, "socket");
  const source: Source = {
    id: "restore-failure",
    name: "Restore",
    type: "tmux",
    transport: "local",
    tmuxSocket: socket,
  };
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  let terminal: pty.IPty | undefined;
  let command: Awaited<ReturnType<typeof openTerminal>> | undefined;
  try {
    tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "native",
      "-x",
      "101",
      "-y",
      "31",
    );
    const space = (await listResources(source)).spaces[0]!;
    const windowId = space.windows[0]!.id;
    const window = windowId.split(":")[1]!;
    command = await openTerminal(source, space.id, windowId, 101, 31);
    assert.ok(!command.connect, "tmux uses a PTY transport");
    terminal = pty.spawn(command.file, command.args, {
      name: "xterm-256color",
      cols: 101,
      rows: 31,
      env: { PATH: process.env.PATH!, HOME: root, TERM: "xterm-256color" },
    });
    await new Promise<void>((resolve) => terminal!.onData(() => resolve()));
    const before = await command.readSize!();
    const focused = await command.resize!(150, 48, before.token);
    terminal.resize(150, 48);
    await assert.rejects(
      command.restoreSize!(before, focused.token, async () => {
        throw new Error("PTY has exited");
      }),
      /PTY has exited/u,
    );
    await command.cleanup();
    assert.equal(
      tmux(
        "display-message",
        "-p",
        "-t",
        window,
        "#{window_width}x#{window_height}",
      ),
      "101x31",
    );
    assert.equal(
      tmux("show-options", "-w", "-t", window, "window-size"),
      before.policy,
    );
    assert.equal(tmux("list-sessions", "-F", "#{session_name}"), "native");
    assert.ok(
      !tmux("show-options", "-w", "-t", window).includes("@canvas_geometry_"),
    );
  } finally {
    terminal?.kill();
    await command?.cleanup();
    try {
      tmux("kill-server");
    } catch {
      /* Already stopped. */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("tmux native receipts recover lost resize responses without claiming external writes", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "canvas-resize-receipt-"));
  const socket = join(root, "socket"),
    binary = join(root, "tmux"),
    armed = join(root, "armed"),
    blocked = join(root, "blocked");
  const realTmux = execFileSync("sh", ["-c", "command -v tmux"], {
    encoding: "utf8",
  }).trim();
  const tmux = (...args: string[]) =>
    execFileSync(realTmux, ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2), armed=${JSON.stringify(armed)}, blocked=${JSON.stringify(blocked)}, real=${JSON.stringify(realTmux)};
if (fs.existsSync(blocked) && args.includes('display-message')) { process.stderr.write('synthetic read outage'); process.exit(75); }
const result=cp.spawnSync(real,args,{encoding:'utf8'});
const ownWrite=args.includes('if-shell') && args.some(arg=>arg.includes("_writer ") && arg.includes("resize-window -t "));
if (result.status===0 && ownWrite && fs.existsSync(armed)) {
 const mode=fs.readFileSync(armed,'utf8'); fs.unlinkSync(armed);
 if(mode==='blocked') fs.writeFileSync(blocked,'blocked');
 if(mode==='external') cp.execFileSync(real,['-S',${JSON.stringify(socket)},'resize-window','-t','@0','-x','150','-y','45']);
 process.stderr.write('synthetic resize response loss'); process.exit(75);
}
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);
`,
    { mode: 0o700 },
  );
  const source: Source = {
    id: "receipt",
    name: "Receipt",
    type: "tmux",
    transport: "local",
    tmuxSocket: socket,
    binary,
  };
  let command: Awaited<ReturnType<typeof openTerminal>> | undefined;
  try {
    tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "native",
      "-x",
      "101",
      "-y",
      "31",
    );
    const space = (await listResources(source)).spaces[0]!;
    command = await openTerminal(
      source,
      space.id,
      space.windows[0]!.id,
      101,
      31,
    );
    const baseline = await command.readSize!();
    writeFileSync(armed, "drop");
    const recovered = await command.resize!(150, 45, baseline.token);
    assert.equal(recovered.recoveredFromToken, baseline.token);
    assert.ok(recovered.operationId);
    const restored = await command.restoreSize!(baseline, recovered.token);
    assert.equal(`${restored.cols}x${restored.rows}`, "101x31");

    const second = await command.readSize!();
    writeFileSync(armed, "blocked");
    await assert.rejects(
      command.resize!(150, 45, second.token),
      (error) =>
        error instanceof Error &&
        !(error instanceof NativeGeometryConflictError),
    );
    rmSync(blocked);
    const deferred = await command.readSize!();
    assert.equal(
      deferred.recoveredFromToken,
      second.token,
      "recovery after outage lost exact write attribution",
    );
    await command.restoreSize!(second, deferred.token);

    const third = await command.readSize!();
    writeFileSync(armed, "external");
    await assert.rejects(
      command.resize!(150, 45, third.token),
      NativeGeometryConflictError,
    );
    const external = await command.readSize!();
    assert.equal(`${external.cols}x${external.rows}`, "150x45");
    assert.equal(
      external.recoveredFromToken,
      undefined,
      "matching external dimensions were mistaken for our write",
    );
    await command.cleanup();
    assert.equal(
      tmux(
        "display-message",
        "-p",
        "-t",
        "@0",
        "#{window_width}x#{window_height}",
      ),
      "150x45",
    );
  } finally {
    rmSync(blocked, { force: true });
    await command?.cleanup();
    try {
      tmux("kill-server");
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("tmux native bare client preserves source selection, resize, panes and lifecycle", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "canvas-provider-"));
  const socket = join(root, "socket");
  const source: Source = {
    id: "test",
    name: "Test",
    type: "tmux",
    transport: "local",
    tmuxSocket: socket,
  };
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const raw = (id: string) => id.split(":")[1]!;
  const opened: Awaited<ReturnType<typeof openTerminal>>[] = [];
  let terminal: pty.IPty | undefined;
  try {
    // Discovery on an empty socket must not launch the daemon.
    assert.deepEqual((await listResources(source)).spaces, []);
    assert.throws(() => tmux("list-sessions"));
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "first", "-n", "one");
    tmux("new-window", "-t", "first:", "-n", "two");
    const snapshot = await listResources(source);
    assert.equal(snapshot.status, "online");
    const space = snapshot.spaces[0]!;
    const one = space.windows.find((w) => w.name === "one")!;
    const beforeSelection = tmux(
      "display-message",
      "-p",
      "-t",
      "first:",
      "#{window_id}",
    );
    tmux("split-window", "-h", "-t", raw(one.id));
    const initialPolicy = tmux(
      "show-options",
      "-w",
      "-t",
      raw(one.id),
      "window-size",
    );
    const command = await openTerminal(source, space.id, one.id, 90, 25);
    opened.push(command);
    assert.equal(
      tmux("display-message", "-p", "-t", "first:", "#{window_id}"),
      beforeSelection,
    );
    assert.equal(
      (await listResources(source)).spaces.length,
      1,
      "helper sessions are hidden",
    );
    const helper = tmux("list-sessions", "-F", "#{session_name}")
      .split("\n")
      .find((s) => s.startsWith("__canvas_"))!;
    assert.equal(tmux("show-options", "-t", helper, "status"), "status off");
    assert.equal(
      tmux("list-windows", "-t", helper, "-F", "#{window_id}"),
      raw(one.id),
    );
    assert.equal(
      tmux("list-panes", "-t", raw(one.id), "-F", "#{pane_id}").split("\n")
        .length,
      2,
    );
    const env = {
      PATH: process.env.PATH!,
      HOME: root,
      SHELL: "/bin/sh",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      ...command.env,
    };
    assert.ok(!command.connect, "tmux uses a PTY transport");
    terminal = pty.spawn(command.file, command.args, {
      name: "xterm-256color",
      cols: 90,
      rows: 25,
      cwd: root,
      env,
    });
    let output = "";
    terminal.onData((data) => {
      output += data;
    });
    const waitFor = async (check: () => boolean, message: string) => {
      for (let i = 0; i < 100; i++) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.fail(message);
    };
    await waitFor(
      () => output.length > 0,
      "native client produced no terminal output",
    );
    terminal.write("printf 'CANVAS_NATIVE_%s\\n' OK\r");
    await waitFor(
      () =>
        tmux("capture-pane", "-p", "-t", raw(one.id)).includes(
          "CANVAS_NATIVE_OK",
        ),
      "PTY input did not reach pane",
    );
    terminal.resize(112, 32);
    await command.resize!(112, 32);
    assert.equal(
      tmux(
        "display-message",
        "-p",
        "-t",
        raw(one.id),
        "#{window_width}x#{window_height}",
      ),
      "112x32",
    );
    assert.equal(
      tmux("display-message", "-p", "-t", "first:", "#{window_id}"),
      beforeSelection,
    );
    await command.cleanup();
    assert.equal(
      tmux("show-options", "-w", "-t", raw(one.id), "window-size"),
      initialPolicy,
      "size policy restored",
    );
    assert.equal(tmux("list-sessions", "-F", "#{session_name}"), "first");
    await renameSpace(source, space.id, "renamed space");
    await renameWindow(source, space.id, one.id, "name with 'quotes'");
    assert.equal(
      (await listResources(source)).spaces[0]!.name,
      "renamed space",
    );
    assert.equal(
      (await listResources(source)).spaces[0]!.windows.find(
        (w) => w.id === one.id,
      )!.name,
      "name with 'quotes'",
    );
    await renameWindow(source, space.id, one.id, "semi;");
    assert.equal(
      (await listResources(source)).spaces[0]!.windows.find(
        (w) => w.id === one.id,
      )!.name,
      "semi;",
    );
    await createWindow(source, space.id, "third");
    const third = (await listResources(source)).spaces[0]!.windows.find(
      (w) => w.name === "third",
    )!;
    await assert.rejects(
      openTerminal(source, "0.0:$0", third.id, 80, 24),
      /Space no longer exists/u,
    );
    await closeWindow(source, space.id, third.id);
    await createSpace(source, "second");
    const second = (await listResources(source)).spaces.find(
      (s) => s.name === "second",
    )!;
    await assert.rejects(
      closeWindow(source, second.id, one.id),
      /Window no longer belongs/u,
    );
    const orphan = await openTerminal(source, space.id, one.id, 80, 24);
    opened.push(orphan);
    tmux("kill-session", "-t", raw(space.id));
    await waitFor(
      () =>
        !tmux("list-sessions", "-F", "#{session_name}").includes("__canvas_"),
      "helper kept deleted source session alive",
    );
    await closeSpace(source, second.id);
    assert.deepEqual((await listResources(source)).spaces, []);
  } finally {
    terminal?.kill();
    await Promise.all(opened.map((command) => command.cleanup()));
    try {
      tmux("kill-server");
    } catch {
      /* Server can exit with its last session. */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("tmux cleanup preserves unexpected helper windows and external size policy changes", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "canvas-provider-cleanup-"));
  const socket = join(root, "socket");
  const source: Source = {
    id: "cleanup",
    name: "Cleanup",
    type: "tmux",
    transport: "local",
    tmuxSocket: socket,
  };
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  let command: Awaited<ReturnType<typeof openTerminal>> | undefined;
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "original");
    const space = (await listResources(source)).spaces[0]!;
    command = await openTerminal(
      source,
      space.id,
      space.windows[0]!.id,
      80,
      24,
    );
    const helper = tmux("list-sessions", "-F", "#{session_name}")
      .split("\n")
      .find((s) => s.startsWith("__canvas_"))!;
    tmux("new-window", "-d", "-t", `${helper}:`, "-n", "keep-me");
    const window = space.windows[0]!.id.split(":")[1]!;
    tmux("set-option", "-w", "-t", window, "window-size", "largest");
    await command.cleanup();
    const snapshot = await listResources(source);
    assert.equal(snapshot.spaces.length, 2);
    assert.ok(
      snapshot.spaces.some(
        (s) =>
          s.name.startsWith("canvas-detached-") &&
          s.windows.some((w) => w.name === "keep-me"),
      ),
    );
    assert.equal(
      tmux("show-options", "-w", "-t", window, "window-size"),
      "window-size largest",
    );
  } finally {
    await command?.cleanup();
    try {
      tmux("kill-server");
    } catch {
      /* Already stopped. */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("tmux named sockets and abrupt native client exit clean the helper", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const socketName = `canvas-test-${randomUUID()}`;
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-L", socketName, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const source: Source = {
    id: "named",
    name: "Named",
    type: "tmux",
    transport: "local",
    tmuxSocket: socketName,
  };
  let command: Awaited<ReturnType<typeof openTerminal>> | undefined;
  let terminal: pty.IPty | undefined;
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "original");
    const space = (await listResources(source)).spaces[0]!;
    assert.equal(space.name, "original");
    const window = space.windows[0]!.id.split(":")[1]!;
    const originalPolicy = tmux(
      "show-options",
      "-w",
      "-t",
      window,
      "window-size",
    );
    command = await openTerminal(
      source,
      space.id,
      space.windows[0]!.id,
      80,
      24,
    );
    assert.ok(!command.connect, "tmux uses a PTY transport");
    terminal = pty.spawn(command.file, command.args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      env: {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        TERM: "xterm-256color",
      },
    });
    let attached = false;
    terminal.onData(() => {
      attached = true;
    });
    for (let i = 0; !attached && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(attached);
    terminal.kill();
    for (
      let i = 0;
      i < 100 &&
      tmux("list-sessions", "-F", "#{session_name}").includes("__canvas_");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      tmux("list-sessions", "-F", "#{session_name}"),
      "original",
      "native detach hook did not remove helper",
    );
    assert.equal(
      tmux("show-options", "-w", "-t", window, "window-size"),
      originalPolicy,
    );
  } finally {
    terminal?.kill();
    await command?.cleanup();
    try {
      tmux("kill-server");
    } catch {
      /* Already stopped. */
    }
  }
});

test("tmux passive views follow native size and temporary resize never overwrites an external owner", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "canvas-native-size-"));
  const socket = join(root, "socket");
  const source: Source = {
    id: "geometry",
    name: "Geometry",
    type: "tmux",
    transport: "local",
    tmuxSocket: socket,
  };
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  let terminal: pty.IPty | undefined;
  let command: Awaited<ReturnType<typeof openTerminal>> | undefined;
  let externalTerminal: pty.IPty | undefined;
  const waitFor = async (check: () => boolean, message: string) => {
    for (let i = 0; i < 150; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(message);
  };
  try {
    tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "native",
      "-x",
      "101",
      "-y",
      "31",
    );
    tmux(
      "set-hook",
      "-g",
      "window-resized[17]",
      "set-option -g @existing-global-fired yes",
    );
    tmux(
      "set-hook",
      "-w",
      "-t",
      "@0",
      "after-resize-window[29]",
      "set-option -w -t @0 @existing-window-fired yes",
    );
    const globalHooks = tmux("show-options", "-g", "window-resized");
    const windowHooks = tmux(
      "show-options",
      "-w",
      "-t",
      "@0",
      "after-resize-window",
    );
    const space = (await listResources(source)).spaces[0]!;
    const windowId = space.windows[0]!.id;
    const window = windowId.split(":")[1]!;
    const nativeGeometry = () =>
      tmux(
        "display-message",
        "-p",
        "-t",
        window,
        "#{window_width}x#{window_height}",
      );
    const beforePolicy = tmux(
      "show-options",
      "-w",
      "-t",
      window,
      "window-size",
    );
    command = await openTerminal(source, space.id, windowId, 90, 25);
    assert.equal(
      nativeGeometry(),
      "101x31",
      "opening a passive view resized the original window",
    );
    assert.equal(
      tmux("show-options", "-w", "-t", window, "window-size"),
      beforePolicy,
    );
    assert.equal(command.initialSize!.cols, 101);
    assert.equal(command.initialSize!.rows, 31);
    assert.ok(!command.connect, "tmux uses a PTY transport");
    terminal = pty.spawn(command.file, command.args, {
      name: "xterm-256color",
      cols: command.initialSize!.cols,
      rows: command.initialSize!.rows,
      env: { PATH: process.env.PATH!, HOME: root, TERM: "xterm-256color" },
    });
    let attached = false;
    terminal.onData(() => {
      if (attached) return;
      attached = true;
      command!.connected?.();
    });
    await waitFor(() => attached, "native view did not attach");
    await command.readSize!();
    assert.equal(
      nativeGeometry(),
      "101x31",
      "the passive PTY participated in native size negotiation",
    );
    const automaticBaseline = await command.readSize!();
    const automaticFocus = await command.resize!(
      150,
      48,
      automaticBaseline.token,
    );
    terminal.resize(150, 48);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const automaticRestore = await command.restoreSize!(
      automaticBaseline,
      automaticFocus.token,
      async (size) => {
        terminal!.resize(size.cols, size.rows);
      },
    );
    assert.equal(
      `${automaticRestore.cols}x${automaticRestore.rows}`,
      "101x31",
      "restoring automatic policy reused the focused PTY dimensions",
    );
    const raceBaseline = await command.readSize!();
    const raceFocus = await command.resize!(150, 48, raceBaseline.token);
    terminal.resize(150, 48);
    const raceRestored = await command.restoreSize!(
      raceBaseline,
      raceFocus.token,
      async (size) => {
        terminal!.resize(size.cols, size.rows);
        tmux("resize-window", "-t", window, "-x", "143", "-y", "43");
      },
    );
    assert.equal(
      `${raceRestored.cols}x${raceRestored.rows}`,
      "143x43",
      "external takeover during preparation lost the atomic restore guard",
    );
    let notifications = 0;
    command.watchSize!(() => notifications++);
    tmux("resize-window", "-t", window, "-x", "108", "-y", "38");
    const baseline = await command.readSize!();
    assert.equal(baseline.cols, 108);
    assert.equal(baseline.rows, 38);
    await waitFor(
      () => notifications > 0,
      "external native geometry emitted no notification",
    );
    terminal.resize(108, 38);
    const focused = await command.resize!(160, 50);
    assert.equal(
      (await command.readSize!()).token,
      focused.token,
      "own late events invalidated the resize token",
    );
    tmux(
      "set-option",
      "-w",
      "-t",
      window,
      "@unrelated-plugin-state",
      "updated",
    );
    tmux("set-option", "-t", "native", "status-style", "bg=blue");
    tmux("set-window-option", "-t", window, "window-style", "fg=green");
    assert.equal(
      (await command.readSize!()).token,
      focused.token,
      "unrelated option changes ended the focused geometry lease",
    );
    const restored = await command.restoreSize!(baseline, focused.token);
    assert.equal(`${restored.cols}x${restored.rows}`, "108x38");
    assert.equal(restored.policy, baseline.policy);

    const next = await command.resize!(160, 50);
    tmux(
      "resize-window",
      "-t",
      window,
      "-x",
      "145",
      "-y",
      "45",
      ";",
      "resize-window",
      "-t",
      window,
      "-x",
      "160",
      "-y",
      "50",
    );
    const bounced = await command.readSize!();
    assert.equal(`${bounced.cols}x${bounced.rows}`, "160x50");
    assert.notEqual(
      bounced.token,
      next.token,
      "A→B→A native resize was lost between polls",
    );
    await command.restoreSize!(baseline, next.token, async () => {
      assert.fail("external takeover must not prepare an old PTY size");
    });
    assert.equal(
      nativeGeometry(),
      "160x50",
      "restore overwrote a newer external size",
    );
    const sameSizePolicyBaseline = await command.readSize!();
    const sameSizePolicyFocus = await command.resize!(
      160,
      50,
      sameSizePolicyBaseline.token,
    );
    tmux("set-option", "-w", "-t", window, "window-size", "manual");
    const sameSizePolicy = await command.readSize!();
    assert.equal(`${sameSizePolicy.cols}x${sameSizePolicy.rows}`, "160x50");
    assert.notEqual(
      sameSizePolicy.token,
      sameSizePolicyFocus.token,
      "same-size policy writes lost ownership invalidation",
    );
    await command.restoreSize!(
      sameSizePolicyBaseline,
      sameSizePolicyFocus.token,
    );

    // A real client's resize must take back control even though resize-window
    // temporarily selected tmux's manual sizing policy for the focused view.
    tmux("set-option", "-w", "-u", "-t", window, "window-size");
    externalTerminal = pty.spawn(
      "tmux",
      ["-S", socket, "attach-session", "-t", "native"],
      {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        env: { PATH: process.env.PATH!, HOME: root, TERM: "xterm-256color" },
      },
    );
    externalTerminal.onData(() => {});
    await waitFor(
      () => nativeGeometry() === "120x39",
      "native external client did not establish its viewport",
    );
    const externalBaseline = await command.readSize!();
    const externalFocus = await command.resize!(
      160,
      50,
      externalBaseline.token,
    );
    externalTerminal.resize(135, 45);
    await waitFor(
      () => nativeGeometry() === "135x44",
      "native external client resize was blocked by the temporary manual policy",
    );
    const externalTakeover = await command.readSize!();
    assert.notEqual(externalTakeover.token, externalFocus.token);
    assert.equal(
      externalTakeover.effectivePolicy,
      externalBaseline.effectivePolicy,
    );
    await command.restoreSize!(externalBaseline, externalFocus.token);
    assert.equal(
      nativeGeometry(),
      "135x44",
      "collapse overwrote the external native client's new viewport",
    );
    const nativeRaceBaseline = await command.readSize!();
    const nativeRaceFocus = await command.resize!(
      160,
      50,
      nativeRaceBaseline.token,
    );
    terminal.resize(160, 50);
    const nativeRaceRestored = await command.restoreSize!(
      nativeRaceBaseline,
      nativeRaceFocus.token,
      async (size) => {
        terminal!.resize(size.cols, size.rows);
        externalTerminal!.resize(140, 46);
        await waitFor(
          () => nativeGeometry() === "140x45",
          "external native client could not take over during collapse",
        );
      },
    );
    assert.equal(
      `${nativeRaceRestored.cols}x${nativeRaceRestored.rows}`,
      "140x45",
    );

    const policyBaseline = await command.readSize!();
    const policyFocus = await command.resize!(170, 55);
    tmux("set-option", "-w", "-t", window, "window-size", "largest");
    const external = await command.readSize!();
    assert.notEqual(external.token, policyFocus.token);
    await command.restoreSize!(policyBaseline, policyFocus.token);
    assert.equal(
      tmux("show-options", "-w", "-t", window, "window-size"),
      "window-size largest",
    );
    await command.cleanup();
    assert.equal(
      tmux("show-options", "-w", "-t", window, "window-size"),
      "window-size largest",
      "detach replaced external sizing policy",
    );
    assert.equal(
      tmux("show-options", "-g", "window-resized"),
      globalHooks,
      "existing global hooks changed",
    );
    assert.equal(
      tmux("show-options", "-w", "-t", window, "after-resize-window"),
      windowHooks,
      "existing window hooks changed",
    );
    assert.equal(
      tmux("show-options", "-g", "@existing-global-fired"),
      "@existing-global-fired yes",
      "inherited hooks stopped running",
    );
    assert.equal(
      tmux("show-options", "-w", "-t", window, "@existing-window-fired"),
      "@existing-window-fired yes",
      "local hooks stopped running",
    );
    assert.ok(
      !tmux("show-options", "-w", "-t", window).includes("@canvas_geometry_"),
    );
    const persistent = await openTerminal(source, space.id, windowId, 90, 25);
    try {
      await persistent.resize!(175, 55);
      await persistent.commitSize!();
    } finally {
      await persistent.cleanup();
    }
    assert.equal(
      nativeGeometry(),
      "175x55",
      "cleanup restored a deliberately committed window size",
    );
    assert.equal(
      tmux("show-options", "-w", "-t", window, "window-size"),
      "window-size manual",
    );
  } finally {
    externalTerminal?.kill();
    terminal?.kill();
    await command?.cleanup();
    try {
      tmux("kill-server");
    } catch {
      /* Already stopped. */
    }
    rmSync(root, { recursive: true, force: true });
  }
});
