import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from 'node:net';
import { UploadService } from "./uploads.ts";
import { Store, sourceConnectionKey, type Source } from "./state.ts";
import { createApp } from "./app.ts";
import { TerminalManager } from "./terminals.ts";
import type { SourceResource } from "./providers.ts";
import { closeWindow, createSpace, listResources, shellQuote } from "./providers.ts";
import type { writeInboxFile } from "./inbox.ts";

class FakeSocket {
  readyState = 1;
  messages: Record<string, any>[] = [];
  send(value: string) { this.messages.push(JSON.parse(value)); }
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(ok => { resolve = ok; });
  return { promise, resolve };
}
function uploadRequest(bytes: Uint8Array, signal?: AbortSignal) {
  return new Request("http://canvas.test/api/uploads/fixture", { method: "PUT", body: bytes as BodyInit, signal });
}
type Writer = typeof writeInboxFile;
function fixture(t: TestContext, options: { beforeWrite?: () => Promise<void>; beforePaste?: () => Promise<void>; capture?: () => Promise<void>; reportAfterAbort?: boolean } = {}) {
  const source: Source = { id: randomUUID(), name: "Fixture", transport: "local" };
  const socket = new FakeSocket(), other = new FakeSocket();
  const files = new Map<string, Buffer>(), removed: Array<{ sourceId: string; paths: string[] }> = [];
  const pasted: Array<{ sourceId: string; windowId: string; text: string }> = [];
  const captures: Array<{ sourceId: string; windowId: string; socket: WebSocket }> = [];
  const windows = new Set(["window-a", "window-b"]);
  let serial = 0, pasteFails = false, canCapture = true;
  const write: Writer = async (_source, file, bytes, signal, progress) => {
    await options.beforeWrite?.();
    if (signal.aborted && options.reportAfterAbort) progress(1);
    signal.throwIfAborted();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of bytes) {
      signal.throwIfAborted();
      size += chunk.byteLength;
      if (size > file.size) throw new Error("上传大小不符");
      chunks.push(Buffer.from(chunk));
      progress(size);
    }
    signal.throwIfAborted();
    if (size !== file.size) throw new Error("上传不完整");
    const path = `/fixture/.local/share/canvas/inbox/${(++serial).toString(16).padStart(8, "0")}_${file.name}`;
    files.set(path, Buffer.concat(chunks));
    return path;
  };
  const terminals = {
    captureFilePaste: async (sourceId: string, windowId: string, socket: WebSocket) => {
      await options.capture?.();
      captures.push({ sourceId, windowId, socket });
      if (!canCapture) return undefined;
      return async (text: string, signal: AbortSignal) => {
        await options.beforePaste?.();
        signal.throwIfAborted();
        if (pasteFails) throw new Error("目标窗口已关闭");
        pasted.push({ sourceId, windowId, text });
      };
    },
  } as unknown as TerminalManager;
  const service = new UploadService(terminals, {
    write,
    remove: async (removedSource, paths) => {
      removed.push({ sourceId: removedSource.id, paths: [...paths] });
      for (const path of paths) files.delete(path);
    },
    resources: async () => ({ ...source, status: "online", spaces: [{ id: "space", name: "Space",
      windows: [...windows].map(id => ({ id, name: id, panes: [], status: "unknown" })),
    }] }) as SourceResource,
  });
  t.after(() => service.closeAll());
  const begin = async (files: Array<{ name: string; size: number }>, windowId = "window-a", id = "batch") => {
    await service.begin(source, windowId, socket as never, "session-a", { id, files });
    const ready = socket.messages.findLast(message => message.type === "upload-ready" && message.id === id);
    assert(ready, "upload batch did not become ready");
    return (ready.urls as string[]).map(url => url.split("/").at(-1)!);
  };
  return { source, service, socket, other, files, removed, pasted, captures, windows, begin,
    setPasteFailure: () => { pasteFails = true; }, disableCapture: () => { canCapture = false; } };
}

test("multi-file batches preserve order and paste quoted paths once into the captured window without Enter", async t => {
  const f = fixture(t);
  const names = ["风景 O'Brian.png", "second file.txt", "empty"];
  const contents = [Buffer.from([0, 255, 128, 1]), Buffer.from("second"), Buffer.alloc(0)];
  const tokens = await f.begin(names.map((name, i) => ({ name, size: contents[i]!.length })));
  // A later target change has no effect on the captured callback.
  f.windows.add("other-active-window");
  for (let i = 0; i < tokens.length; i++) {
    assert.equal(await f.service.receive(tokens[i]!, "session-a", uploadRequest(contents[i]!)), 204);
    if (i < tokens.length - 1) assert.deepEqual(f.pasted, []);
  }
  const paths = [...f.files.keys()];
  assert.deepEqual(paths.map(path => path.slice(path.indexOf("_") + 1)), names);
  assert.deepEqual([...f.files.values()], contents);
  assert.deepEqual(f.pasted, [{ sourceId: f.source.id, windowId: "window-a", text: paths.map(shellQuote).join(" ") }]);
  assert(!f.pasted[0]!.text.includes("\n"));
  assert(!f.pasted[0]!.text.includes("\r"));
  assert.equal(f.captures.length, 1);
  const completed = f.socket.messages.find(message => message.state === "completed")!;
  assert.deepEqual(completed.paths, paths);
  assert.equal(completed.transferred, 10);
  assert.equal(completed.total, 10);
});

test("upload tokens reject other sessions, out-of-order writes and replays", async t => {
  const f = fixture(t), tokens = await f.begin([{ name: "a", size: 1 }, { name: "b", size: 1 }]);
  assert.equal(await f.service.receive(tokens[0]!, "other-session", uploadRequest(Buffer.from("a"))), 404);
  assert.equal(await f.service.receive(tokens[1]!, "session-a", uploadRequest(Buffer.from("b"))), 409);
  assert.deepEqual(f.pasted, []);
  assert.equal(f.files.size, 0);
  assert.equal(await f.service.receive(tokens[0]!, "session-a", uploadRequest(Buffer.from("a"))), 204);
  assert.equal(await f.service.receive(tokens[0]!, "session-a", uploadRequest(Buffer.from("a"))), 404);
  assert.equal(await f.service.receive(tokens[1]!, "session-a", uploadRequest(Buffer.from("b"))), 204);
  assert.equal(f.pasted.length, 1);
});

test("progress only advances after the writer confirms bytes, and duplicate batches cannot overlap a window", async t => {
  const writing = gate(), f = fixture(t, { beforeWrite: () => writing.promise });
  const tokens = await f.begin([{ name: "data", size: 4 }]);
  const receiving = f.service.receive(tokens[0]!, "session-a", uploadRequest(Buffer.from("data")));
  await new Promise(resolve => setImmediate(resolve));
  assert(f.socket.messages.filter(message => message.type === "upload-progress").every(message => message.transferred === 0));
  await f.service.begin(f.source, "window-a", f.other as never, "other-session", { id: "collision", files: [{ name: "other", size: 0 }] });
  assert.equal(f.other.messages.at(-1)?.state, "failed");
  writing.resolve();
  assert.equal(await receiving, 204);
  assert.equal(f.socket.messages.at(-1)?.transferred, 4);
});

test("source renames preserve active uploads and future uploads from the same attached view", async t => {
  const writing = gate(), f = fixture(t, { beforeWrite: () => writing.promise });
  const root = mkdtempSync(join(tmpdir(), "canvas-upload-rename-")), store = new Store(join(root, "state.db"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.put("source", f.source); store.addSession("session-a");
  let closed = 0;
  const app = createApp(store, { username: "fixture", passwordHash: "unused" }, {
    closeSource: async () => { closed++; },
  } as unknown as TerminalManager, {
    uploads: f.service,
    closeOpenBridge: async id => f.service.closeSource(id),
  });
  const patch = (body: unknown) => app.request(`http://canvas.test/api/sources/${f.source.id}`, {
    method: "PATCH", headers: { Host: "canvas.test", Origin: "http://canvas.test", Authorization: "Bearer session-a", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const [token] = await f.begin([{ name: "active", size: 4 }]);
  const receiving = f.service.receive(token!, "session-a", uploadRequest(Buffer.from("data")));
  assert.equal((await patch({ ...f.source, name: "Renamed", target: "", sshIdentityFile: "", sshKnownHostsFile: "", herdrSession: "", herdrSocket: "" })).status, 200);
  assert.equal(closed, 0);
  assert.equal(sourceConnectionKey(store.get<Source>("source", f.source.id)!), sourceConnectionKey(f.source), "the attached view must still authorize new uploads after rename");
  writing.resolve();
  assert.equal(await receiving, 204);
  assert.equal(f.pasted.length, 1);
  const [next] = await f.begin([{ name: "after-rename", size: 4 }], "window-a", "after-rename");
  assert.equal(await f.service.receive(next!, "session-a", uploadRequest(Buffer.from("next"))), 204);
  assert.equal(f.pasted.length, 2);

  const [pending] = await f.begin([{ name: "old-endpoint", size: 4 }], "window-a", "old-endpoint");
  assert.equal((await patch({ herdrSocket: "/fixture/changed.sock" })).status, 200);
  assert.equal(closed, 1);
  assert.notEqual(sourceConnectionKey(store.get<Source>("source", f.source.id)!), sourceConnectionKey(f.source));
  assert.equal(await f.service.receive(pending!, "session-a", uploadRequest(Buffer.from("stop"))), 404);
  assert.equal(f.pasted.length, 2);
});

test("short or oversized later files retain earlier successful files and never paste partial results", async t => {
  for (const [size, bytes] of [[10, Buffer.from("short")], [1, Buffer.from("long")]] as const) {
    const f = fixture(t), tokens = await f.begin([{ name: "first", size: 3 }, { name: "bad", size }]);
    assert.equal(await f.service.receive(tokens[0]!, "session-a", uploadRequest(Buffer.from("one"))), 204);
    const firstPath = [...f.files.keys()][0]!;
    assert.equal(await f.service.receive(tokens[1]!, "session-a", uploadRequest(bytes)), 409);
    await f.service.closeAll();
    assert.equal(f.files.size, 1);
    assert.deepEqual(f.files.get(firstPath), Buffer.from('one'));
    assert(!f.removed.some(call => call.paths.includes(firstPath)));
    assert.deepEqual(f.pasted, []);
    assert.equal(f.socket.messages.at(-1)?.state, "failed");
    assert.equal(f.socket.messages.at(-1)?.failedFile, "bad");
  }
});

test("closed native windows and failed paste callbacks retain complete files without inserting paths", async t => {
  for (const unavailable of ["resource", "paste"] as const) {
    const f = fixture(t), [token] = await f.begin([{ name: "one", size: 3 }]);
    if (unavailable === "resource") f.windows.delete("window-a"); else f.setPasteFailure();
    assert.equal(await f.service.receive(token!, "session-a", uploadRequest(Buffer.from("one"))), 409);
    await f.service.closeAll();
    assert.deepEqual([...f.files.values()], [Buffer.from('one')]);
    assert.deepEqual(f.removed, []);
    assert.deepEqual(f.pasted, []);
    assert.match(f.socket.messages.at(-1)?.error, /目标窗口已关闭/u);
  }
});

test("cancellation uses the owning socket and prevents a delayed paste", async t => {
  const paste = gate(), f = fixture(t, { beforePaste: () => paste.promise });
  const [token] = await f.begin([{ name: "one", size: 3 }]);
  f.service.cancel(f.other as never, "batch");
  const receiving = f.service.receive(token!, "session-a", uploadRequest(Buffer.from("one")));
  while (!f.files.size) await new Promise(resolve => setImmediate(resolve));
  f.service.cancel(f.socket as never, "batch");
  paste.resolve();
  assert.equal(await receiving, 409);
  await f.service.closeAll();
  assert.equal(f.files.size, 0);
  assert.deepEqual(f.pasted, []);
  assert.equal(f.socket.messages.at(-1)?.state, "cancelled");
});

test("network request abort and source failure retain completed files without inserting partial paths", async t => {
  for (const action of ["abort", "close-source"] as const) {
    const f = fixture(t), tokens = await f.begin([{ name: "first", size: 3 }, { name: "pending", size: 10 }]);
    await f.service.receive(tokens[0]!, "session-a", uploadRequest(Buffer.from("one")));
    let cancelled = false;
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ start(target) { target.enqueue(Buffer.from("part")); }, cancel() { cancelled = true; } });
    const request = new Request("http://canvas.test/api/uploads/fixture", { method: "PUT", body: stream, duplex: "half", signal: controller.signal } as RequestInit);
    const receiving = f.service.receive(tokens[1]!, "session-a", request);
    await new Promise(resolve => setImmediate(resolve));
    if (action === "abort") controller.abort(); else f.service.closeSource(f.source.id);
    assert.equal(await receiving, 409);
    await f.service.closeAll();
    assert.equal(cancelled, true);
    assert.deepEqual([...f.files.values()], [Buffer.from('one')]);
    assert.deepEqual(f.pasted, []);
    assert.equal(await f.service.receive(tokens[1]!, "session-a", uploadRequest(Buffer.from("ignored"))), 404);
  }
});

test('a real WebSocket disconnect stops an unfinished batch without deleting completed files or pasting paths', async t => {
  const f = fixture(t), wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => wss.once('listening', resolve));
  const connected = new Promise<WebSocket>(resolve => wss.once('connection', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
  const server = await connected;
  const frames: Record<string, any>[] = [];
  client.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  const closed = new Promise<void>(resolve => server.once('close', () => { f.service.disconnected(server); resolve(); }));
  t.after(async () => {
    client.terminate(); server.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  });
  await f.service.begin(f.source, 'window-a', server, 'session-a', { id: 'socket-batch', files: [{ name: 'first', size: 3 }, { name: 'pending', size: 8 }] });
  for (let i = 0; i < 200 && !frames.some(frame => frame.type === 'upload-ready'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const urls = frames.find(frame => frame.type === 'upload-ready')?.urls as string[];
  assert(urls);
  const tokens = urls.map(url => url.split('/').at(-1)!);
  assert.equal(await f.service.receive(tokens[0]!, 'session-a', uploadRequest(Buffer.from('one'))), 204);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('part')); }, cancel() { cancelled = true; } });
  const receiving = f.service.receive(tokens[1]!, 'session-a', new Request('http://canvas.test/api/uploads/pending', {
    method: 'PUT', body, duplex: 'half',
  } as RequestInit));
  await new Promise(resolve => setImmediate(resolve));
  client.close(); await closed;
  assert.equal(await receiving, 409);
  assert(cancelled);
  assert.deepEqual([...f.files.values()], [Buffer.from('one')]);
  assert.deepEqual(f.removed, []); assert.deepEqual(f.pasted, []);
  assert.equal(await f.service.receive(tokens[1]!, 'session-a', uploadRequest(Buffer.from('ignored'))), 404);
});

test("validation and unavailable terminal capture never issue upload tokens", async t => {
  const f = fixture(t);
  await f.service.begin(f.source, "window-a", f.socket as never, "session-a", { id: "bad", files: [{ name: "../escape", size: 1 }] });
  assert.equal(f.socket.messages.at(-1)?.state, "failed");
  assert.equal(f.captures.length, 0);
  f.disableCapture();
  await f.service.begin(f.source, "window-a", f.socket as never, "session-a", { id: "offline", files: [{ name: "file", size: 0 }] });
  assert.equal(f.socket.messages.at(-1)?.state, "failed");
  assert.equal(f.socket.messages.some(message => message.type === "upload-ready"), false);
});

test("shutdown or source removal during terminal capture cannot create a late upload batch", async t => {
  for (const action of ["shutdown", "source-close"] as const) {
    const capturing = gate(), f = fixture(t, { capture: () => capturing.promise });
    const beginning = f.service.begin(f.source, "window-a", f.socket as never, "session-a", {
      id: "pending", files: [{ name: "never-started", size: 0 }],
    });
    await new Promise(resolve => setImmediate(resolve));
    if (action === "shutdown") await f.service.closeAll(); else f.service.closeSource(f.source.id);
    capturing.resolve();
    await beginning;
    assert.equal(f.socket.messages.some(message => message.type === "upload-ready"), false,
      `${action} must invalidate in-flight terminal capture`);
    assert.equal(f.socket.messages.at(-1)?.state, "failed");
  }
});

test("late writer progress cannot revive a cancelled upload", async t => {
  const writing = gate(), f = fixture(t, { beforeWrite: () => writing.promise, reportAfterAbort: true });
  const [token] = await f.begin([{ name: "cancelled", size: 4 }]);
  const receiving = f.service.receive(token!, "session-a", uploadRequest(Buffer.from("data")));
  await new Promise(resolve => setImmediate(resolve));
  f.service.cancel(f.socket as never, "batch");
  writing.resolve();
  assert.equal(await receiving, 409);
  assert.equal(f.socket.messages.at(-1)?.state, "cancelled");
  assert.equal(f.files.size, 0);
  assert.deepEqual(f.pasted, []);
});

test('real native terminal receives no upload paths until the whole batch succeeds, and failed later files retain earlier bytes', async t => {
  const binary = process.env.CANVAS_TEST_HERDR_SERVER_BINARY;
  if (!binary) { t.skip('Set CANVAS_TEST_HERDR_SERVER_BINARY for an isolated official server'); return; }
  const root = mkdtempSync(join(tmpdir(), 'cv-upload-batch-')), config = join(root, 'config');
  const input = join(root, 'input.bin'), receiver = join(root, 'receiver');
  mkdirSync(join(config, 'herdr'), { recursive: true });
  writeFileSync(receiver, `#!/usr/bin/python3\nimport os,tty\ntty.setraw(0)\nprint('UPLOAD_READY',flush=True)\nwith open(${JSON.stringify(input)},'ab',buffering=0) as output:\n while True:\n  data=os.read(0,4096)\n  if not data:break\n  output.write(data)\n`, { mode: 0o700 });
  writeFileSync(join(config, 'herdr/config.toml'), `onboarding=false\n[terminal]\ndefault_shell=${JSON.stringify(receiver)}\nshell_mode="non_login"\n`);
  const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(root, 'state'), LANG: 'C.UTF-8' };
  const source: Source = { id: randomUUID(), name: 'Native fixture', transport: 'local',
    herdrSocket: join(config, 'herdr/sessions/upload-batch/herdr.sock') };
  const native = spawn(binary, ['--session', 'upload-batch', 'server'], { env, stdio: 'ignore' });
  const manager = new TerminalManager(), writing = gate(), files: string[] = [];
  let writes = 0;
  const service = new UploadService(manager, {
    resources: listResources,
    remove: async (_source, paths) => { for (const path of paths) rmSync(path, { force: true }); },
    write: async (_source, file, chunks, signal, progress) => {
      const buffers: Buffer[] = []; let length = 0;
      for await (const chunk of chunks) { signal.throwIfAborted(); buffers.push(Buffer.from(chunk)); length += chunk.length; progress(length); }
      if (length !== file.size) throw new Error('Synthetic size mismatch');
      if (++writes === 2) await writing.promise;
      signal.throwIfAborted();
      const path = join(root, `0000000${files.length + 1}_${file.name}`);
      writeFileSync(path, Buffer.concat(buffers)); files.push(path); return path;
    },
  });
  t.after(async () => {
    writing.resolve(); await service.closeAll(); await manager.closeAll();
    if (native.exitCode === null && native.signalCode === null) {
      const stopped = new Promise<void>(resolve => native.once('exit', () => resolve())); native.kill();
      const kill = setTimeout(() => native.kill('SIGKILL'), 1500); await stopped; clearTimeout(kill);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const waitFor = async (ready: () => boolean | Promise<boolean>, label: string) => {
    for (let i = 0; i < 300; i++) { if (await ready()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(label);
  };
  await waitFor(async () => (await listResources(source)).status === 'online', 'Native server starts');
  await createSpace(source, 'Upload');
  const space = (await listResources(source)).spaces.find(space => space.name === 'Upload')!, windowId = space.windows[0]!.id;
  class Client extends EventEmitter {
    readyState = 1; bufferedAmount = 0; messages: Record<string, any>[] = [];
    send(value: string | Buffer) { if (typeof value === 'string') this.messages.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const client = new Client(), socket = client as unknown as WebSocket;
  client.once('close', () => service.disconnected(socket));
  await manager.connect(source, { sourceId: source.id, spaceId: space.id, windowId }, socket);
  const terminal = (await manager.entries.get(`${source.id}/${windowId}`))!;
  await waitFor(() => Array.from({ length: terminal.emulator.buffer.active.length }, (_, row) =>
    terminal.emulator.buffer.active.getLine(row)?.translateToString(true)).join('\n').includes('UPLOAD_READY'), 'Native receiver is ready');
  client.emit('message', Buffer.from(JSON.stringify({ type: 'focus' })), false);
  const actualInput = () => existsSync(input) ? readFileSync(input) : Buffer.alloc(0);
  const baseline = actualInput();
  const start = async (id: string, names: string[]) => {
    await service.begin(source, windowId, socket, 'session', { id, files: names.map(name => ({ name, size: 3 })) });
    const urls = client.messages.findLast(message => message.type === 'upload-ready' && message.id === id)?.urls;
    assert(urls); return (urls as string[]).map(url => url.split('/').at(-1)!);
  };
  const first = await start('success', ["one O'Brian.txt", 'two.txt']);
  assert.equal(await service.receive(first[0]!, 'session', uploadRequest(Buffer.from('one'))), 204);
  const last = service.receive(first[1]!, 'session', uploadRequest(Buffer.from('two')));
  await waitFor(() => writes === 2, 'Last file is in progress');
  assert.deepEqual(actualInput(), baseline, 'No path was inserted while any file was incomplete');
  writing.resolve(); assert.equal(await last, 204);
  const inserted = Buffer.from(files.map(shellQuote).join(' '));
  await waitFor(() => actualInput().length === baseline.length + inserted.length, 'The complete batch reaches native input');
  assert.deepEqual(actualInput(), Buffer.concat([baseline, inserted]));
  assert(!inserted.includes(10) && !inserted.includes(13));
  const failed = await start('failure', ['retained.txt', 'broken.txt']);
  assert.equal(await service.receive(failed[0]!, 'session', uploadRequest(Buffer.from('yes'))), 204);
  const beforeFailure = actualInput(), retained = files.at(-1)!;
  assert.equal(await service.receive(failed[1]!, 'session', uploadRequest(Buffer.from('short'))), 409);
  assert.deepEqual(actualInput(), beforeFailure, 'Failed batch inserts no partial path');
  assert.equal(readFileSync(retained, 'utf8'), 'yes');
  assert.equal(client.messages.at(-1)?.failedFile, 'broken.txt');
  const closing = await start('native-close', ['closed-retained.txt', 'never.txt']);
  assert.equal(await service.receive(closing[0]!, 'session', uploadRequest(Buffer.from('yes'))), 204);
  const closedPath = files.at(-1)!, beforeClose = actualInput();
  await closeWindow(source, space.id, windowId);
  await waitFor(() => client.readyState === 3, 'Native close retires the browser transport');
  assert.equal(await service.receive(closing[1]!, 'session', uploadRequest(Buffer.from('new'))), 404);
  assert.equal(readFileSync(closedPath, 'utf8'), 'yes');
  assert.deepEqual(actualInput(), beforeClose, 'Closing native window inserts no upload paths');
});
