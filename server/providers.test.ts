import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import {
  existsSync,
  chmodSync,
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
import { randomUUID } from "node:crypto";
import { herdrApiRequest } from "./herdr/api.ts";
import {
  createSpace,
  createWindow,
  listResources,
  probeSource,
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

test('discovery selects each tab\'s remembered pane rather than global focus or the first title', async t => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-tab-titles-'));
  const source: Source = { id: randomUUID(), name: 'Titles', transport: 'local', herdrSocket: join(root, 'herdr.sock') };
  const requests: string[] = [];
  const snapshot = {
    workspaces: [{ workspace_id: 'space', label: 'Space' }],
    tabs: ['single', 'split', 'foreground'].map((tab_id, index) => ({ workspace_id: 'space', tab_id, label: String(index + 1) })),
    layouts: [{ tab_id: 'single', focused_pane_id: 'only' }, { tab_id: 'split', focused_pane_id: 'second' }, { tab_id: 'foreground', focused_pane_id: 'current' }],
    panes: [
      { tab_id: 'single', pane_id: 'only', focused: false, terminal_title_stripped: 'Background shell' },
      { tab_id: 'split', pane_id: 'first', focused: false, terminal_title_stripped: 'Different task' },
      { tab_id: 'split', pane_id: 'second', focused: false, terminal_title_stripped: 'Selected task' },
      { tab_id: 'foreground', pane_id: 'current', focused: true, terminal_title_stripped: 'Foreground shell' },
    ],
  };
  const api = createServer(socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString(); if (!input.includes('\n')) return;
      const request = JSON.parse(input.split('\n')[0]!); requests.push(request.method);
      socket.end(JSON.stringify({ id: request.id, result: { snapshot } }) + '\n');
    });
  });
  let attaches = 0;
  const endpoint = createServer(socket => { attaches++; socket.destroy(); });
  await Promise.all([new Promise<void>(resolve => api.listen(source.herdrSocket, resolve)),
    new Promise<void>(resolve => endpoint.listen(join(root, 'herdr-client.sock'), resolve))]);
  t.after(async () => {
    await closeProviderConnections(source.id);
    await Promise.all([api, endpoint].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    rmSync(root, { recursive: true, force: true });
  });
  const windows = async () => (await listResources(source)).spaces[0]!.windows;
  assert.deepEqual((await windows()).map(window => window.panes.find(pane => pane.active)?.terminalTitle), ['Background shell', 'Selected task', 'Foreground shell']);
  snapshot.panes[2]!.terminal_title_stripped = '';
  const cleared = (await windows())[1]!;
  assert.equal(cleared.panes.find(pane => pane.active)?.id, 'second');
  assert.equal(cleared.panes.find(pane => pane.active)?.terminalTitle, '', 'clearing a title never borrows another pane\'s title');
  snapshot.layouts[1]!.focused_pane_id = 'first';
  assert.equal((await windows())[1]!.panes.find(pane => pane.active)?.terminalTitle, 'Different task');
  snapshot.layouts[1]!.focused_pane_id = 'missing';
  assert.equal((await windows())[1]!.panes.some(pane => pane.active), false, 'invalid layout identity cannot guess a title');
  assert(requests.every(method => method === 'session.snapshot'));
  assert.equal(attaches, 0, 'title discovery never attaches or changes native focus');
});

test('official herdr preserves inactive single and split tab titles without attaching a Canvas terminal', async t => {
  const binary = process.env.CANVAS_TEST_HERDR_SERVER_BINARY;
  if (!binary) { t.skip('Set CANVAS_TEST_HERDR_SERVER_BINARY to an unmodified upstream server'); return; }
  const root = mkdtempSync(join(tmpdir(), 'canvas-title-native-')), config = join(root, 'config');
  mkdirSync(join(config, 'herdr'), { recursive: true });
  writeFileSync(join(config, 'herdr/config.toml'), 'onboarding=false\n[terminal]\ndefault_shell="/bin/sh"\nshell_mode="non_login"\n');
  const env = { PATH: process.env.PATH, HOME: root, USER: 'fixture', SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(root, 'state') };
  const native = spawn(binary, ['--session', 'titles', 'server'], { env, stdio: 'ignore' });
  const source: Source = { id: randomUUID(), name: 'Isolated titles', transport: 'local', herdrSocket: join(config, 'herdr/sessions/titles/herdr.sock') };
  t.after(async () => {
    await closeProviderConnections(source.id);
    if (native.exitCode === null && native.signalCode === null) {
      const ended = new Promise<void>(resolve => native.once('exit', () => resolve()));
      native.kill(); const timer = setTimeout(() => native.kill('SIGKILL'), 3000); await ended; clearTimeout(timer);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const until = async (check: () => Promise<boolean>, message: string) => {
    const deadline = Date.now() + 10000;
    while (!await check()) { assert(Date.now() < deadline && native.exitCode === null, message); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  await until(async () => (await listResources(source)).status === 'online', 'isolated official herdr did not start');
  const space = await createSpace(source, 'Titles'), split = await createWindow(source, space.spaceId, '2'), foreground = await createWindow(source, space.spaceId, '3');
  const snapshot = async () => (await herdrApiRequest(source.herdrSocket!, 'session.snapshot')).snapshot as {
    focused_tab_id: string; focused_pane_id: string; panes: Array<{ pane_id: string; tab_id: string; focused: boolean; terminal_title_stripped?: string }>;
  };
  const first = await snapshot(), only = first.panes.find(pane => pane.tab_id === space.windowId)!, left = first.panes.find(pane => pane.tab_id === split.windowId)!;
  await herdrApiRequest(source.herdrSocket!, 'pane.split', { target_pane_id: left.pane_id, direction: 'right', focus: false });
  const right = (await snapshot()).panes.find(pane => pane.tab_id === split.windowId && pane.pane_id !== left.pane_id)!;
  const setTitle = (paneId: string, title: string) => herdrApiRequest(source.herdrSocket!, 'pane.send_text', {
    pane_id: paneId, text: `printf '\\033]0;${title}\\007'\r`,
  });
  for (const [paneId, title] of [[only.pane_id, 'Single task'], [left.pane_id, 'Left task'], [right.pane_id, 'Right task']]) await setTitle(paneId!, title!);
  await until(async () => (await snapshot()).panes.find(pane => pane.pane_id === right.pane_id)?.terminal_title_stripped === 'Right task', 'native OSC titles did not arrive');
  await herdrApiRequest(source.herdrSocket!, 'pane.focus', { pane_id: right.pane_id });
  await herdrApiRequest(source.herdrSocket!, 'tab.focus', { tab_id: foreground.windowId });
  const before = await snapshot();
  assert(before.panes.filter(pane => [space.windowId, split.windowId].includes(pane.tab_id)).every(pane => !pane.focused), 'inactive API panes reproduce the missing-title condition');
  const windows = (await listResources(source)).spaces.find(item => item.id === space.spaceId)!.windows;
  assert.equal(windows.find(window => window.id === space.windowId)!.panes.find(pane => pane.active)?.terminalTitle, 'Single task');
  assert.equal(windows.find(window => window.id === split.windowId)!.panes.find(pane => pane.active)?.terminalTitle, 'Right task');
  const after = await snapshot();
  assert.equal(after.focused_tab_id, before.focused_tab_id);
  assert.equal(after.focused_pane_id, before.focused_pane_id);
  await setTitle(right.pane_id, '');
  await until(async () => !(await snapshot()).panes.find(pane => pane.pane_id === right.pane_id)?.terminal_title_stripped, 'native title did not clear');
  const cleared = (await listResources(source)).spaces.find(item => item.id === space.spaceId)!.windows.find(window => window.id === split.windowId)!;
  assert.equal(cleared.panes.find(pane => pane.active)?.terminalTitle, '');
});

async function helperFixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'canvas-helper-')), previousHome = process.env.HOME, previousPath = process.env.PATH;
  process.env.HOME = root; process.env.PATH = '/usr/bin:/bin';
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, target: join(root, '.local/bin/canvas'), source: { id: 'helper', name: 'Fixture', transport: 'local' } as Source };
}

test('Canvas publishes only a missing helper atomically, without state journals', async t => {
  const { root, target, source } = await helperFixture(t);
  const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
  await Promise.all(Array.from({ length: 12 }, () => installCanvasHelper(source, bytes)));
  assert.deepEqual(readFileSync(target), bytes);
  assert.equal(statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(join(root, '.local/bin')), ['canvas']);
  assert(!existsSync(join(root, '.local/state/canvas')));
  await installCanvasHelper(source, Buffer.from('#!/bin/sh\nexit 1\n'));
  assert.deepEqual(readFileSync(target), bytes, 'existing helpers are not upgraded or overwritten');
  await assert.rejects(installCanvasHelper(source, Buffer.alloc(8 * 1024 * 1024 + 1)), /size is invalid/u);
});

test('any executable canvas on PATH prevents injection without running it', async t => {
  const { root, target, source } = await helperFixture(t), tools = join(root, 'tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'canvas'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  process.env.PATH = `${tools}:/usr/bin:/bin`;
  await installCanvasHelper(source, Buffer.from('#!/bin/sh\nexit 0\n'));
  assert(!existsSync(target));
  assert(!existsSync(join(root, '.local')), 'skipping an existing command creates no helper directories');
});

test('existing helper, npm symlink, unrelated command and broken link stay untouched', async t => {
  const { root, target, source } = await helperFixture(t);
  mkdirSync(dirname(target), { recursive: true });
  const original = Buffer.from('owned or unrelated existing command');
  for (const kind of ['file', 'managed', 'symlink', 'broken']) {
    rmSync(target, { force: true });
    if (kind === 'symlink' || kind === 'broken') symlinkSync(join(root, kind === 'symlink' ? 'npm-entry' : 'missing'), target);
    else writeFileSync(target, original, { mode: 0o755 });
    if (kind === 'symlink') writeFileSync(join(root, 'npm-entry'), original, { mode: 0o755 });
    if (kind === 'managed') writeFileSync(join(dirname(target), '.canvas-managed-sha256'), 'existing marker');
    await installCanvasHelper(source, Buffer.from('#!/bin/sh\nexit 0\n'));
    if (kind !== 'broken') assert.deepEqual(readFileSync(target), original);
    else assert.equal(existsSync(target), false);
  }
  assert.equal(readFileSync(join(dirname(target), '.canvas-managed-sha256'), 'utf8'), 'existing marker');
});

test('missing helper installation rejects symlinked or world-writable parents', async t => {
  const { root, source } = await helperFixture(t);
  for (const kind of ['symlink', 'writable']) {
    const home = join(root, kind); mkdirSync(home); process.env.HOME = home;
    mkdirSync(join(home, '.local'));
    if (kind === 'symlink') { mkdirSync(join(home, 'elsewhere')); symlinkSync(join(home, 'elsewhere'), join(home, '.local/bin')); }
    else { mkdirSync(join(home, '.local/bin')); chmodSync(join(home, '.local/bin'), 0o777); }
    await assert.rejects(installCanvasHelper(source, Buffer.from('#!/bin/sh\nexit 0\n')));
    assert(!existsSync(join(home, '.local/bin/canvas')));
  }
});

test('owner-managed group-writable parents retain their permissions', async t => {
  const { root, target, source } = await helperFixture(t);
  for (const directory of [join(root, '.local'), dirname(target)]) { mkdirSync(directory, { recursive: true }); chmodSync(directory, 0o775); }
  await installCanvasHelper(source, Buffer.from('#!/bin/sh\nexit 0\n'));
  assert.equal(statSync(dirname(target)).mode & 0o777, 0o775);
  assert.equal(statSync(target).mode & 0o777, 0o755);
});

test('SSH helper installation applies the same no-overwrite rule in an isolated home', async t => {
  const { root, target } = await helperFixture(t), tools = join(root, 'tools'); mkdirSync(tools);
  writeFileSync(join(tools, 'ssh'), '#!/bin/sh\nfor argument do command=$argument; done\nexec /bin/sh -c "$command"\n', { mode: 0o755 });
  process.env.PATH = `${tools}:/usr/bin:/bin`;
  const source: Source = { id: 'helper-ssh', name: 'Fixture', transport: 'ssh', target: 'fixture.invalid' };
  const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
  await installCanvasHelper(source, bytes);
  await installCanvasHelper(source, Buffer.from('#!/bin/sh\nexit 1\n'));
  assert.deepEqual(readFileSync(target), bytes);
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
      socket.end(JSON.stringify({ id: request.id, result: { snapshot: { version: "0.9.5-remote.fixture", protocol: 888, workspaces: [{ workspace_id: "space", label: "Space" }], tabs: [{ workspace_id: "space", tab_id: "tab", label: "Window" }],
        layouts: [{ tab_id: "tab", focused_pane_id: "pane" }],
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
    const discovered = await listResources(source);
    assert.equal(discovered.serverVersion, "0.9.5-remote.fixture", "SSH reports the remote server identity through its forwarded API socket");
    const window = discovered.spaces[0]!.windows[0]!;
    assert.equal(window.id, "tab");
    assert.equal(window.panes[0]?.active, true, 'SSH discovery uses the tab layout even when no pane is globally focused');
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

    first = await openTerminal(source, "space", "tab");
    const beforeProbe = forwardingCount();
    assert.deepEqual(await probeSource(source), { status: "online", serverVersion: "0.9.5-remote.fixture" });
    assert.equal(forwardingCount(), beforeProbe + 1, "a draft probe owns a separate temporary forward");
    assert.equal((await listResources(source)).status, "online");
    assert.equal(forwardingCount(), beforeProbe + 1, "probe cleanup leaves the existing connection's forward alive");
    await first.cleanup(); first = undefined;

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
