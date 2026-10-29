import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { UploadService } from "./uploads.ts";
import type { Source } from "./state.ts";
import type { TerminalManager } from "./terminals.ts";
import type { SourceResource } from "./providers.ts";
import { shellQuote } from "./providers.ts";
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
  const source: Source = { id: randomUUID(), name: "Fixture", type: "tmux", transport: "local" };
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
    resources: async () => ({ ...source, host: "fixture", status: "online", spaces: [{ id: "space", name: "Space",
      windows: [...windows].map(id => ({ id, name: id, panes: [], status: "unknown", statusSource: "none" })),
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

test("short or oversized later files remove the earlier batch files and never paste partial results", async t => {
  for (const [size, bytes] of [[10, Buffer.from("short")], [1, Buffer.from("long")]] as const) {
    const f = fixture(t), tokens = await f.begin([{ name: "first", size: 3 }, { name: "bad", size }]);
    assert.equal(await f.service.receive(tokens[0]!, "session-a", uploadRequest(Buffer.from("one"))), 204);
    const firstPath = [...f.files.keys()][0]!;
    assert.equal(await f.service.receive(tokens[1]!, "session-a", uploadRequest(bytes)), 409);
    await f.service.closeAll();
    assert.equal(f.files.size, 0);
    assert(f.removed.some(call => call.paths.includes(firstPath)));
    assert.deepEqual(f.pasted, []);
    assert.equal(f.socket.messages.at(-1)?.state, "failed");
  }
});

test("closed native windows and failed paste callbacks remove uploaded files", async t => {
  for (const unavailable of ["resource", "paste"] as const) {
    const f = fixture(t), [token] = await f.begin([{ name: "one", size: 3 }]);
    if (unavailable === "resource") f.windows.delete("window-a"); else f.setPasteFailure();
    assert.equal(await f.service.receive(token!, "session-a", uploadRequest(Buffer.from("one"))), 409);
    await f.service.closeAll();
    assert.equal(f.files.size, 0);
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

test("request abort and source removal cancel blocked bodies and clean completed files", async t => {
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
    assert.equal(f.files.size, 0);
    assert.deepEqual(f.pasted, []);
    assert.equal(await f.service.receive(tokens[1]!, "session-a", uploadRequest(Buffer.from("ignored"))), 404);
  }
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
