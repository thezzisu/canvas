import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import headless from "@xterm/headless";
import { terminalUnicodeAddon } from "../shared/terminal-unicode.ts";
import { terminalInputChunks } from "../web/src/terminal-input-chunks.ts";
import { TerminalManager } from "./terminals.ts";
import { createSpace, createWindow, listResources, shellQuote, type Source } from "./providers.ts";

class Client extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  received: (string | Buffer)[] = [];
  send(data: string | Buffer) { this.received.push(data); }
  close() { this.readyState = 3; this.emit("close"); }
  command(data: unknown) { this.emit("message", Buffer.from(JSON.stringify(data)), false); }
  get socket() { return this as unknown as WebSocket; }
}

const messages = (client: Client) => client.received.filter((data): data is string => typeof data === "string").map(data => JSON.parse(data));
const presentation = (client: Client) => messages(client).filter(item => item.type === "presentation").at(-1);
const size = (client: Client) => messages(client).filter(item => item.type === "resize").at(-1);
const output = (client: Client) => client.received.filter(Buffer.isBuffer).map(data => data.toString()).join("");
async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(label);
}

async function fixture(t: TestContext, probe = false, quietProbe = false) {
  const binary = process.env.CANVAS_TEST_HERDR_SERVER_BINARY;
  if (!binary) { t.skip("Set CANVAS_TEST_HERDR_SERVER_BINARY to an unmodified upstream server"); return; }
  const root = mkdtempSync(join(tmpdir(), "cv-terminal-"));
  const config = join(root, "config"), state = join(root, "state"), bytes = join(root, "input.bin");
  let shell = "/bin/sh";
  if (probe) {
    shell = join(root, "receiver");
    writeFileSync(shell, `#!/usr/bin/python3\nimport os,tty\ntty.setraw(0)\nprint('\\x1b[?1003h${quietProbe ? "\\x1b[?2004h" : ""}READY',flush=True)\nwith open(${JSON.stringify(bytes)},'ab',buffering=0) as output:\n while True:\n  data=os.read(0,4096)\n  if not data: break\n  output.write(data)\n${quietProbe ? "" : "  print('HEX:'+data.hex(),flush=True)\n"}`, { mode: 0o700 });
  }
  for (const flavor of ["herdr", "herdr-dev"]) {
    mkdirSync(join(config, flavor), { recursive: true });
    writeFileSync(join(config, flavor, "config.toml"), `onboarding = false\n[terminal]\ndefault_shell = ${JSON.stringify(shell)}\nshell_mode = "non_login"\n`);
  }
  const env = { PATH: process.env.PATH!, HOME: root, USER: process.env.USER || "fixture", SHELL: shell,
    TERM: "xterm-256color", LANG: "C.UTF-8", XDG_CONFIG_HOME: config, XDG_STATE_HOME: state };
  const session = "terminal-test";
  const source: Source = { id: root, name: "Fixture", transport: "local", herdrSession: session,
    herdrSocket: join(config, "herdr/sessions", session, "herdr.sock") };
  const server = spawn(binary, ["--session", session, "server"], { env, stdio: "ignore" });
  const manager = new TerminalManager();
  t.after(async () => {
    await manager.closeAll();
    try { execFileSync(binary, ["--session", session, "server", "stop"], { env, stdio: "ignore", timeout: 5000 }); } catch {}
    server.kill();
    if (server.exitCode === null && server.signalCode === null)
      await new Promise<void>(resolve => { server.once("exit", () => resolve()); setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 1500).unref(); });
    rmSync(root, { recursive: true, force: true });
  });
  await waitFor(async () => (await listResources(source)).status === "online", "isolated herdr server did not start");
  await createSpace(source, "Synthetic");
  const space = (await listResources(source)).spaces.find(item => item.name === "Synthetic")!;
  const target = { sourceId: source.id, spaceId: space.id, windowId: space.windows[0]!.id };
  const text = async () => {
    const terminal = await manager.entries.get(`${source.id}/${target.windowId}`);
    return terminal ? Array.from({ length: terminal.emulator.buffer.active.length },
      (_, row) => terminal.emulator.buffer.active.getLine(row)?.translateToString(true) || "").join("\n") : "";
  };
  const ready = () => waitFor(async () => (await text()).includes(probe ? "READY" : "sh-"), "native pane was not ready");
  let sequence = 0;
  const shellResult = async (client: Client, command: string) => {
    const path = join(root, `result-${sequence++}`);
    client.command({ type: "input", data: `${command} > ${shellQuote(path)}\r` });
    await waitFor(() => existsSync(path) && readFileSync(path, "utf8").length > 0, "shell result was not written");
    return readFileSync(path, "utf8").trim();
  };
  const assertSize = async (client: Client, cols: number, rows: number) => {
    await waitFor(() => size(client)?.cols === cols && size(client)?.rows === rows, "client viewport did not reach requested size");
    assert.equal(await shellResult(client, "stty size"), `${rows} ${cols - 1}`, "native pane does not fill its viewport except its scrollbar column");
  };
  return { root, bytes, manager, source, target, shellResult, assertSize, ready, text };
}

test("a transport closing during queued browser join rejects the connection", async () => {
  const manager = new TerminalManager(), client = new Client();
  const source: Source = { id: "join-race", name: "Join race", transport: "local" };
  const terminal = { closed: false, async join() { await Promise.resolve(); this.closed = true; } };
  manager.entries.set("join-race/window", Promise.resolve(terminal) as never);
  await assert.rejects(manager.connect(source, { sourceId: source.id, spaceId: "space", windowId: "window" }, client.socket), /detached while connecting/);
  manager.entries.clear();
});

test("file downloads require explicit interaction and never follow passive controller fallback", async t => {
  const f = await fixture(t); if (!f) return;
  const { manager, source, target } = f;
  const first = new Client(), second = new Client(), reconnected = new Client();
  const maxToken = randomUUID();
  await manager.connect(source, target, first.socket);
  await manager.connect(source, target, second.socket);
  assert.equal(await manager.downloadRecipient(source.id, target.windowId), undefined);
  second.command({ type: "focus" });
  const secondRecipient = await manager.downloadRecipient(source.id, target.windowId);
  assert.equal(secondRecipient?.socket, second.socket); assert.equal(secondRecipient?.isCurrent(), true);
  first.command({ type: "focus" });
  assert.equal(secondRecipient?.isCurrent(), false);
  assert.equal((await manager.downloadRecipient(source.id, target.windowId))?.socket, first.socket);
  first.close();
  assert.equal(await manager.downloadRecipient(source.id, target.windowId), undefined, "passive fallback inherited file delivery");
  await manager.connect(source, target, reconnected.socket);
  assert.equal(await manager.downloadRecipient(source.id, target.windowId), undefined, "reconnection reclaimed file delivery");
  second.command({ type: "focus" });
  assert.equal((await manager.downloadRecipient(source.id, target.windowId))?.socket, second.socket);
  reconnected.command({ type: "focus-resize-begin", token: maxToken, cols: 120, rows: 35 });
  const maximizedRecipient = await manager.downloadRecipient(source.id, target.windowId);
  assert.equal(maximizedRecipient?.socket, reconnected.socket);
  second.command({ type: "focus" });
  assert.equal(maximizedRecipient?.isCurrent(), true, "paused viewer stole the file recipient");
  reconnected.close();
  assert.equal(maximizedRecipient?.isCurrent(), false);
  assert.equal(await manager.downloadRecipient(source.id, target.windowId), undefined);
});

test("one native window has one maximized view, pauses peers and restores complete snapshots and viewport", async t => {
  const f = await fixture(t); if (!f) return;
  const { manager, source, target } = f;
  const first = new Client(), second = new Client(), late = new Client(), independent = new Client();
  const firstToken = randomUUID(), secondToken = randomUUID(), otherToken = randomUUID();
  const exitToken = randomUUID(), cancelToken = randomUUID(), latestToken = randomUUID();
  await manager.connect(source, target, first.socket);
  await manager.connect(source, target, second.socket);
  await f.ready();
  const pid = await f.shellResult(first, "printf '%s\\n' $$");
  first.command({ type: "focus-resize-begin", token: firstToken, cols: 130, rows: 40 });
  assert.deepEqual(presentation(second), { type: "presentation", maximized: true, owned: false, token: firstToken, lease: presentation(second).lease });
  assert(Number.isSafeInteger(presentation(second).lease));
  await f.assertSize(first, 130, 40);
  const secondMark = second.received.length;
  second.command({ type: "focus" });
  second.command({ type: "input", data: "printf 'BLOCKED_%s\\n' VIEW\r" });
  second.command({ type: "resize", cols: 70, rows: 20 });
  first.command({ type: "input", data: "printf 'CURRENT_%s\\n' SCREEN\r" });
  await waitFor(async () => (await f.text()).includes("CURRENT_SCREEN"), "owner input did not reach terminal");
  assert.ok(!(await f.text()).includes("BLOCKED_VIEW"));
  assert.equal(size(first).cols, 130);
  assert.ok(second.received.slice(secondMark).every(data => typeof data === "string" && JSON.parse(data).type !== "resize"), "paused viewer received output or size");
  await manager.connect(source, target, late.socket);
  assert.equal(manager.entries.size, 1);
  assert.ok(late.received.every(data => typeof data === "string" && JSON.parse(data).type !== "resize"));
  assert.equal(presentation(late).maximized, true);
  await createWindow(source, target.spaceId, "Independent");
  const other = (await listResources(source)).spaces.find(item => item.id === target.spaceId)!.windows.find(item => item.name === "Independent")!;
  await manager.connect(source, { ...target, windowId: other.id }, independent.socket);
  independent.command({ type: "focus-resize-begin", token: otherToken, cols: 100, rows: 32 });
  await waitFor(() => presentation(independent)?.owned === true, "independent native window did not maximize");
  assert.equal(presentation(first).owned, true);
  assert.equal(manager.entries.size, 2);

  const takeoverMark = second.received.length;
  second.command({ type: "focus-resize-begin", token: secondToken, cols: 144, rows: 44 });
  assert.equal(presentation(first).owned, false);
  await waitFor(() => presentation(second)?.owned === true, "second view could not take over");
  const takeover = second.received.slice(takeoverMark);
  const resetIndex = takeover.findIndex(data => typeof data === "string" && JSON.parse(data).type === "reset");
  const replayIndex = takeover.findIndex(data => Buffer.isBuffer(data) && data.toString().includes("CURRENT_SCREEN"));
  const shownIndex = takeover.findIndex(data => typeof data === "string" && JSON.parse(data).type === "presentation" && JSON.parse(data).owned);
  assert.ok(resetIndex >= 0 && replayIndex > resetIndex && shownIndex > replayIndex, "takeover preceded its complete reset/snapshot");
  await f.assertSize(second, 144, 44);
  first.command({ type: "focus-resize-end", token: firstToken });
  first.command({ type: "focus-resize-update", token: firstToken, cols: 80, rows: 24 });
  await f.assertSize(second, 144, 44);

  const resumeMark = late.received.length;
  second.command({ type: "focus-resize-end", token: secondToken });
  await waitFor(() => presentation(late)?.maximized === false, "paused viewer did not resume");
  const resumed = late.received.slice(resumeMark);
  const resume = resumed.slice(resumed.findIndex(data => typeof data === "string" && JSON.parse(data).type === "reset"));
  assert.deepEqual(JSON.parse(resume[0] as string), { type: "reset" });
  assert.deepEqual(JSON.parse(resume[1] as string), { type: "resize", cols: 100, rows: 30 });
  assert.ok(Buffer.isBuffer(resume[2]) && resume[2].toString().includes("CURRENT_SCREEN"));
  assert.deepEqual(JSON.parse(resume[3] as string), { type: "presentation", maximized: false, owned: false });
  await f.assertSize(second, 100, 30);

  second.command({ type: "focus-resize-begin", token: exitToken, cols: 150, rows: 45 });
  await f.assertSize(second, 150, 45);
  second.close();
  await waitFor(() => presentation(first)?.maximized === false, "disconnect did not restore and resume viewers");
  first.command({ type: "focus" });
  await f.assertSize(first, 100, 30);
  first.command({ type: "focus-resize-begin", token: cancelToken, cols: 160, rows: 48 });
  first.command({ type: "focus-resize-end", token: cancelToken });
  late.command({ type: "focus-resize-begin", token: latestToken, cols: 140, rows: 42 });
  await waitFor(() => presentation(late)?.owned === true, "rapid takeover lost the latest owner");
  await f.assertSize(late, 140, 42);
  assert.equal(presentation(first).owned, false);
  late.command({ type: "focus-resize-end", token: latestToken });
  await waitFor(() => presentation(first)?.maximized === false, "rapid takeover did not release");
  await f.assertSize(late, 100, 30);
  assert.equal(await f.shellResult(late, "printf '%s\\n' $$"), pid, "native shell was replaced");
  assert.equal(presentation(independent).owned, true, "ownership leaked across native windows");
});

test("a paused peer cancels the observed maximization without input, focus takeover or losing the shared restore size", async t => {
  const f = await fixture(t, true); if (!f) return;
  const { manager, source, target } = f;
  const owner = new Client(), peer = new Client();
  await manager.connect(source, target, owner.socket);
  await manager.connect(source, target, peer.socket);
  await f.ready();
  const token = randomUUID();
  owner.command({ type: "focus-resize-begin", token, cols: 130, rows: 40 });
  await waitFor(() => size(owner)?.cols === 130, "owner did not maximize");
  const observed = presentation(peer);
  assert(observed.maximized && !observed.owned && Number.isSafeInteger(observed.lease));
  owner.command({ type: "resize", cols: 112, rows: 34 });
  const terminal = await manager.entries.get(`${source.id}/${target.windowId}`)!;
  await terminal.geometry.drain();
  assert.equal(size(owner).cols, 130, "persistent card geometry replaced the active maximized size");
  const before = existsSync(f.bytes) ? readFileSync(f.bytes) : Buffer.alloc(0);
  peer.command({ type: "presentation-cancel", token, lease: observed.lease });
  peer.command({ type: "presentation-cancel", token, lease: observed.lease });
  await waitFor(() => presentation(owner)?.maximized === false && presentation(peer)?.maximized === false, "peer cancel did not resume both views");
  assert.equal(size(peer).cols, 112);
  assert.equal(size(peer).rows, 34);
  assert.equal(terminal.controller, owner.socket, "cancel stole terminal focus");
  assert.equal((await manager.downloadRecipient(source.id, target.windowId))?.socket, owner.socket);
  assert.deepEqual(existsSync(f.bytes) ? readFileSync(f.bytes) : Buffer.alloc(0), before, "cancel sent terminal input");
  peer.command({ type: "presentation-cancel", token, lease: observed.lease });
  assert.equal(presentation(peer).maximized, false, "repeated cancel reintroduced a lease");
});

test("stale peer cancellation cannot end a replacement lease or a takeover queued during restoration", async t => {
  const f = await fixture(t, true); if (!f) return;
  const { manager, source, target } = f;
  const owner = new Client(), peer = new Client();
  await manager.connect(source, target, owner.socket);
  await manager.connect(source, target, peer.socket);
  await f.ready();
  const token = randomUUID();
  owner.command({ type: "focus-resize-begin", token, cols: 130, rows: 40 });
  await waitFor(() => size(owner)?.cols === 130, "initial maximization failed");
  const stale = presentation(peer);
  owner.command({ type: "focus-resize-begin", token, cols: 140, rows: 44 });
  const replacement = presentation(peer);
  assert.notEqual(replacement.lease, stale.lease, "server lease identity must not depend on client token uniqueness");
  peer.command({ type: "presentation-cancel", token, lease: stale.lease });
  await waitFor(() => size(owner)?.cols === 140, "stale cancellation changed replacement geometry");
  assert.equal(presentation(peer).lease, replacement.lease);
  peer.command({ type: "presentation-cancel", token, lease: replacement.lease });
  const nextToken = randomUUID();
  owner.command({ type: "focus-resize-begin", token: nextToken, cols: 150, rows: 46 });
  const terminal = await manager.entries.get(`${source.id}/${target.windowId}`)!;
  await terminal.geometry.drain();
  await waitFor(() => presentation(owner)?.owned === true && presentation(owner)?.token === nextToken, "queued restore dismissed the new owner");
  assert.equal(size(owner).cols, 150);
  peer.command({ type: "presentation-cancel", token, lease: replacement.lease });
  assert.equal(presentation(peer).token, nextToken);
  assert.equal(presentation(peer).maximized, true);
  const current = presentation(peer);
  peer.command({ type: "presentation-cancel", token: nextToken, lease: current.lease });
  await waitFor(() => presentation(peer)?.maximized === false, "latest observed lease could not be cancelled");
  assert.equal(size(peer).cols, 100);
  assert.equal(size(peer).rows, 30);
});

test("shared native terminals serialize to late viewers, retain last resize and close without stopping herdr", async t => {
  const f = await fixture(t); if (!f) return;
  const { manager, source, target } = f;
  const first = new Client(), second = new Client();
  await manager.connect(source, target, first.socket);
  await f.ready();
  first.command({ type: "input", data: "printf 'SHARED_%s\\n' SCREEN\r" });
  await waitFor(async () => (await f.text()).includes("SHARED_SCREEN"), "first viewer received no output");
  await manager.connect(source, target, second.socket);
  assert.equal(manager.entries.size, 1);
  assert.ok(output(second).includes("SHARED_SCREEN"), "late viewer received no snapshot");
  const replay = new headless.Terminal({ allowProposedApi: true });
  const write = (data: string | Buffer) => new Promise<void>(resolve => replay.write(data, resolve));
  try {
    for (const data of second.received.slice()) {
      if (Buffer.isBuffer(data)) await write(data);
      else {
        const message = JSON.parse(data);
        if (message.type === "reset") await write("\x1bc");
        if (message.type === "resize") replay.resize(message.cols, message.rows);
      }
    }
    let replies = "";
    const listener = replay.onData(data => { replies += data; });
    await write("\x1b[?1002$p\x1b[?1006$p\x1b[?1016$p");
    listener.dispose();
    assert.equal(replies, "\x1b[?1002;1$y\x1b[?1006;1$y\x1b[?1016;2$y", "late views must retain drag tracking and cell-based SGR encoding");
    assert.equal(replay.buffer.active.type, "alternate");
    assert.ok(Array.from({ length: replay.buffer.active.length }, (_, row) => replay.buffer.active.getLine(row)?.translateToString(true)).join("\n").includes("SHARED_SCREEN"), "restoring mouse modes cleared the replayed screen");
  } finally { replay.dispose(); }
  assert.ok(messages(second).some(item => item.readOnly === true));
  second.command({ type: "focus" });
  assert.ok(messages(first).some(item => item.readOnly === true));
  first.readyState = 2;
  first.command({ type: "focus" });
  first.command({ type: "input", data: "printf 'BLOCKED_%s\\n' INPUT\r" });
  second.command({ type: "input", data: "printf 'ALLOWED_%s\\n' INPUT\r" });
  await waitFor(async () => (await f.text()).includes("ALLOWED_INPUT"), "controller input did not arrive");
  assert.ok(!(await f.text()).includes("BLOCKED_INPUT"));
  for (let cols = 110; cols <= 132; cols++) second.command({ type: "resize", cols, rows: 42 });
  await f.assertSize(second, 132, 42);
  second.command({ type: "input", data: "seq 1 40000\r" });
  await manager.closeAll();
  await assert.rejects(manager.connect(source, target, new Client().socket), /service is closing/);
  assert.equal(manager.entries.size, 0);
  assert.equal((await listResources(source)).spaces.find(item => item.id === target.spaceId)?.windows[0]?.id, target.windowId);
});

test("binary mouse coordinates and UTF-8 input pass through the native herdr client", async t => {
  const f = await fixture(t, true); if (!f) return;
  const { manager, source, target } = f, client = new Client();
  await manager.connect(source, target, client.socket);
  await f.ready();
  client.command({ type: "resize", cols: 220, rows: 60 });
  await waitFor(() => size(client)?.cols === 220, "wide viewport was not applied");
  client.command({ type: "input", encoding: "binary", data: "\x1b[M" + String.fromCharCode(67, 200, 70) });
  await waitFor(() => existsSync(f.bytes) && readFileSync(f.bytes).length >= 6, "legacy mouse bytes did not arrive");
  const mouseBytes = readFileSync(f.bytes);
  assert.equal(mouseBytes.toString("hex"), "1b5b4d43c846", "borderless native pane mouse coordinates must arrive without UTF-8 expansion");
  client.command({ type: "input", data: "中文" });
  await waitFor(() => readFileSync(f.bytes).length >= mouseBytes.length + Buffer.byteLength("中文"), "UTF-8 text did not arrive");
  assert.deepEqual(readFileSync(f.bytes).subarray(mouseBytes.length), Buffer.from("中文"));
});

test("a 200000-code-unit note reaches the native pane intact in bounded chunks and one paste bracket pair", async t => {
  const f = await fixture(t, true, true); if (!f) return;
  const client = new Client();
  await f.manager.connect(f.source, f.target, client.socket);
  await f.ready();
  const body = '中文😀\0\t\n\r"\\'.repeat(20_000);
  assert.equal(body.length, 200_000);
  const input = `\x1b[200~${body}\x1b[201~`, expected = Buffer.from(input);
  for (const data of terminalInputChunks(input)) {
    assert(Buffer.byteLength(JSON.stringify({ type: "input", data })) < 128 * 1024);
    client.command({ type: "input", data });
  }
  await waitFor(() => existsSync(f.bytes) && readFileSync(f.bytes).length >= expected.length, "long note bytes were dropped");
  assert.deepEqual(readFileSync(f.bytes), expected, "native paste was truncated, Unicode was split, or Enter/brackets were duplicated");
});

test("a viewport failure closes every viewer and drains restoration before reconnect", async t => {
  const f = await fixture(t); if (!f) return;
  const { manager, source, target } = f;
  const first = new Client(), second = new Client();
  const resizeToken = randomUUID();
  await manager.connect(source, target, first.socket);
  await manager.connect(source, target, second.socket);
  await f.ready();
  first.command({ type: "focus-resize-begin", token: resizeToken, cols: 130, rows: 40 });
  await f.assertSize(first, 130, 40);
  const terminal = (await manager.entries.get(`${source.id}/${target.windowId}`))!;
  terminal.proc.resize = () => { throw new Error("fixture resize failure"); };
  first.command({ type: "focus-resize-update", token: resizeToken, cols: 140, rows: 45 });
  await waitFor(() => first.readyState === 3 && second.readyState === 3 && manager.entries.size === 0,
    "resize failure left the owner, paused peer or restoration queue hanging");
  assert.equal(messages(first).at(-1)?.status, "closed");
  const reconnected = new Client();
  await manager.connect(source, target, reconnected.socket);
  assert.equal(manager.entries.size, 1);
  await f.assertSize(reconnected, 100, 30);
});

test("hidden viewers stop binary traffic and resume an exact current screen without native reconnect", async t => {
  const f = await fixture(t); if (!f) return;
  const first = new Client(), second = new Client();
  await f.manager.connect(f.source, f.target, first.socket);
  await f.manager.connect(f.source, f.target, second.socket);
  await f.ready();
  const terminal = (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!;
  const native = terminal.proc;
  first.command({ type: 'focus' });
  const recipient = await f.manager.downloadRecipient(f.source.id, f.target.windowId);
  second.command({ type: 'view-visible', visible: false });
  const mark = second.received.length;
  first.command({ type: 'input', data: "printf '\\033[2J\\033[H'; printf 'HIDDEN_%s\\n' OUTPUT; seq 1 70\r" });
  await waitFor(async () => (await f.text()).includes('70'), 'background output was not incorporated');
  first.command({ type: 'resize', cols: 123, rows: 37 });
  await f.assertSize(first, 123, 37);
  await terminal.queue;
  assert.equal(second.received.slice(mark).filter(Buffer.isBuffer).length, 0);
  assert(!second.received.slice(mark).some(frame => typeof frame === 'string' && JSON.parse(frame).type === 'resize'));
  assert.equal(recipient?.isCurrent(), true, 'hiding another view changed the CLI recipient');
  const beforeResume = second.received.length;
  for (let i = 0; i < 4; i++) {
    second.command({ type: 'view-visible', visible: true });
    second.command({ type: 'view-visible', visible: false });
  }
  second.command({ type: 'view-visible', visible: true });
  await terminal.queue;
  assert.equal(terminal.proc, native); assert.equal(f.manager.entries.size, 1);
  const frames = second.received.slice(beforeResume);
  const visible = (value: InstanceType<typeof headless.Terminal>) => Array.from({ length: value.rows }, (_, row) =>
    value.buffer.active.getLine(value.buffer.active.baseY + row)?.translateToString(true) || '');
  const expected = { lines: visible(terminal.emulator), cols: terminal.cols, rows: terminal.rows,
    x: terminal.emulator.buffer.active.cursorX, y: terminal.emulator.buffer.active.cursorY };
  const replay = new headless.Terminal({ cols: 80, rows: 24, scrollback: 2000, allowProposedApi: true });
  replay.loadAddon(terminalUnicodeAddon());
  try {
    for (const frame of frames) {
      if (Buffer.isBuffer(frame)) await new Promise<void>(resolve => replay.write(frame, resolve));
      else {
        const message = JSON.parse(frame);
        if (message.type === 'reset') await new Promise<void>(resolve => replay.write('\x1bc', resolve));
        if (message.type === 'resize') replay.resize(message.cols, message.rows);
      }
    }
    assert.equal(replay.cols, expected.cols); assert.equal(replay.rows, expected.rows);
    assert.deepEqual(visible(replay), expected.lines);
    assert.equal(replay.buffer.active.cursorX, expected.x);
    assert.equal(replay.buffer.active.cursorY, expected.y);
  } finally { replay.dispose(); }
  const token = randomUUID();
  first.command({ type: 'focus-resize-begin', token, cols: 130, rows: 40 });
  second.command({ type: 'view-visible', visible: false });
  first.command({ type: 'focus-resize-end', token });
  await terminal.geometry.drain(); await terminal.queue;
  assert.equal(presentation(second).maximized, false, 'hidden peers missed lease state');
});
