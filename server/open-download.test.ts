import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { createServer, get } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Source, Canvas } from "./state.ts";
import { Store } from "./state.ts";
import { AssetStore } from "./assets.ts";
import { createApp } from "./app.ts";
import type { TerminalManager } from "./terminals.ts";
import { OpenDownloadService, type OpenDownloadOptions } from "./open-download.ts";

const helper = fileURLToPath(new URL("../cli/canvas", import.meta.url));
const source: Source = { id: randomUUID(), name: "Open", type: "herdr", transport: "local" };
const resources = {
  id: source.id, name: source.name, type: source.type, host: "local", status: "online" as const,
  spaces: [{ id: "space", name: "Space", windows: [{ id: "window", name: "Window", status: "unknown" as const, statusSource: "none" as const, panes: [{
    id: "pane", name: "shell", active: true, status: "unknown" as const, statusSource: "none" as const,
  }] }] }],
};

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  messages: Record<string, unknown>[] = [];
  onMessage?: (message: Record<string, unknown>) => void;
  send(value: string) {
    const message = JSON.parse(value);
    this.messages.push(message);
    this.onMessage?.(message);
  }
}

type FixtureOptions = Partial<Pick<OpenDownloadOptions, "contextTimeoutMs" | "progressTimeoutMs">> & {
  recipientAvailable?: boolean;
  autoContext?: boolean;
  customCanvas?: boolean;
  uploadFailure?: "create" | "write" | "complete";
};
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "canvas-open-service-"));
  const registry = join(root, "registry"), sockets = join(root, "sockets");
  await mkdir(registry, { mode: 0o700 }); await mkdir(sockets, { mode: 0o700 });
  const nativeSocket = join(root, "herdr.sock");
  const receiver = new FakeWebSocket();
  let resourceState = resources;
  const store = new Store(join(root, "canvas.db"));
  const assets = new AssetStore(root, store);
  const canvas = store.put<Canvas>("canvas", { id: randomUUID(), name: "Files", nodes: [{
    id: "anchor", sourceId: source.id, spaceId: "space", windowId: "window", x: 40, y: 50, width: 480, height: 302,
  }] });
  store.addSession("authenticated-session"); store.addSession("other-session");
  const observations = { uploadedBytes: 0, aborted: 0, finalized: 0 };
  const service = new OpenDownloadService({
    registryDirectory: registry,
    socketDirectory: sockets,
    idleTimeoutMs: 15,
    contextTimeoutMs: options.contextTimeoutMs,
    progressTimeoutMs: options.progressTimeoutMs,
    createUpload: async metadata => {
      if (options.uploadFailure === "create") throw new Error("fixture staging unavailable");
      const upload = await assets.begin(metadata);
      return {
        write: async chunk => {
          if (options.uploadFailure === "write") throw new Error("fixture staging disk full");
          await upload.write(chunk);
          observations.uploadedBytes += chunk.length;
        },
        complete: async context => {
          if (options.uploadFailure === "complete") throw new Error("fixture staging commit failed");
          const result = await upload.complete(context);
          observations.finalized++;
          return result;
        },
        abort: async () => { await upload.abort(); observations.aborted++; },
      };
    },
    readTemporary: id => assets.readTemporary(id),
    prepare: async (_source, localSocket) => ({ nativeSocket, remoteSocket: localSocket, cleanup: async () => {} }),
    resources: async () => resourceState,
    recipient: async () => options.recipientAvailable !== false ? {
      socket: receiver as never, sessionId: "authenticated-session", isCurrent: () => receiver.readyState === 1,
    } : undefined,
  });
  receiver.onMessage = message => {
    if (message.type === "file-context" && options.autoContext !== false) queueMicrotask(() => {
      if (receiver.readyState === 1) service.action(String(message.id), "authenticated-session", "prepare",
        options.customCanvas ? { canvasId: canvas.id, anchorId: "anchor" } : undefined);
    });
  };
  await service.ensureSource(source);
  const app = createApp(store, { username: "fixture", passwordHash: "unused" }, {} as TerminalManager, {
    openDownload: (ticket, session) => service.open(ticket, session),
    downloadAction: (ticket, session, action, context) => service.action(ticket, session, action, context),
    assets,
  });
  t.after(async () => {
    await service.closeAll();
    await assets.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const run = (path: string) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn("python3", [helper, "open", "--", path], { cwd: root, env: {
      PATH: process.env.PATH, LANG: "C.UTF-8", HERDR_SOCKET_PATH: nativeSocket,
      HERDR_PANE_ID: "pane", CANVAS_BRIDGE_REGISTRY_DIR: registry,
    } });
    let stderr = ""; child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", reject); child.once("close", code => resolve({ code, stderr }));
    const timer = setTimeout(() => { child.kill(); reject(new Error("helper timed out")); }, 10_000);
    child.once("close", () => clearTimeout(timer));
  });
  return { root, registry, sockets, nativeSocket, service, receiver, app, assets, store, canvas, observations,
    run, setResources(value: typeof resources) { resourceState = value } };
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

async function sender(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, size: number, progress = true) {
  const record = JSON.parse(await readFile(join(f.registry, (await readdir(f.registry))[0]!), "utf8"));
  const socket = createConnection(record.socket);
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  let replies = "";
  socket.on("data", data => replies += data.toString());
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(JSON.stringify({ version: 1, progress, secret: record.secret, provider: "herdr", nativeSocket: f.nativeSocket,
    paneId: "pane", filename: "file.bin", size }) + "\n");
  await waitFor(() => f.receiver.messages.some(message => message.type === "file-context"), "browser received no context request");
  const context = f.receiver.messages.find(message => message.type === "file-context")!;
  return { socket, id: String(context.id), responses: () => replies.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}

async function serveFixture(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const server = createServer(getRequestListener(f.app.fetch));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${address.port}`;
}

async function copyFile(f: Awaited<ReturnType<typeof fixture>>, filename: string, content: Buffer) {
  await writeFile(join(f.root, filename), content);
  const result = await f.run(filename);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result;
}

test("overview copy succeeds before any HTTP request and stages exact retryable bytes", async t => {
  const f = await fixture(t), content = randomBytes(1024 * 1024 + 19);
  await copyFile(f, "风景 文件.bin", content);
  assert.equal(f.observations.finalized, 1, "CLI completion requires committed server storage");
  assert.equal(f.observations.uploadedBytes, content.length);
  const notice = f.receiver.messages.find(message => message.type === "download")!;
  assert(notice, "native download starts only after server staging completes");
  assert.deepEqual(f.receiver.messages.map(message => message.type), ["file-context", "download"]);
  const url = `http://canvas.test${notice.url}`;
  assert.equal((await f.app.request(url, { headers: { Cookie: "canvas_session=other-session" } })).status, 404);
  assert.equal((await f.app.request(url)).status, 401);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await f.app.request(url, { headers: { Cookie: "canvas_session=authenticated-session" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), String(content.length));
    assert.match(response.headers.get("content-disposition")!, /filename\*=UTF-8''/u);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  }
  assert.equal(f.service.action(String(notice.id), "authenticated-session", "prepare")?.state, "completed");
  assert.equal(f.service.action(String(notice.id), "other-session", "prepare"), undefined);
});

test("custom canvas copy adds one persistent card without starting a browser download", async t => {
  const f = await fixture(t, { customCanvas: true }), content = Buffer.from("saved to canvas\n");
  await copyFile(f, "report.txt", content);
  assert.equal(f.receiver.messages.some(message => message.type === "download"), false);
  assert.deepEqual(f.receiver.messages.map(message => message.type), ["file-context"]);
  const canvas = f.store.canvasView(f.store.get<Canvas>("canvas", f.canvas.id)!);
  const card = canvas.nodes.find(node => node.type === "file");
  assert(card && card.type === "file");
  const response = await f.app.request(`http://canvas.test/api/files/${card.assetId}?download=1`, { headers: { Cookie: "canvas_session=authenticated-session" } });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
});

test("browser context is bound once and copying never starts through a GET request", async t => {
  const f = await fixture(t, { autoContext: false }), transfer = await sender(t, f, 4);
  assert.equal(await f.service.open(transfer.id, "authenticated-session"), undefined);
  assert.equal(f.service.action(transfer.id, "other-session", "prepare"), undefined);
  assert.equal(f.observations.uploadedBytes, 0);
  const response = await f.app.request(`http://canvas.test/api/downloads/${transfer.id}`, {
    method: "POST", headers: { Cookie: "canvas_session=authenticated-session", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "prepare", canvasId: f.canvas.id, anchorId: "anchor" }),
  });
  assert.equal(response.status, 200);
  f.service.action(transfer.id, "authenticated-session", "prepare", undefined);
  await waitFor(() => transfer.responses().some(reply => reply.ok === true), "copy did not start after context binding");
  transfer.socket.end("done");
  await waitFor(() => transfer.responses().some(reply => reply.state === "completed"), "copy did not finish");
  assert.equal(f.receiver.messages.some(message => message.type === "download"), false);
  assert(f.store.get<Canvas>("canvas", f.canvas.id)!.nodes.some(node => node.type === "file"));
});

test("empty files complete staging and a real native HTTP response", async t => {
  const f = await fixture(t), base = await serveFixture(t, f);
  await copyFile(f, "empty", Buffer.alloc(0));
  const notice = f.receiver.messages.find(message => message.type === "download")!;
  const response = await fetch(`${base}${notice.url}`, { headers: { Cookie: "canvas_session=authenticated-session", Connection: "close" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "0");
  assert.equal((await response.arrayBuffer()).byteLength, 0);
});

test("staging waits for validated helper EOF after all declared bytes arrive", async t => {
  for (const content of [Buffer.alloc(0), Buffer.from("complete bytes awaiting EOF")]) {
    const f = await fixture(t), transfer = await sender(t, f, content.length);
    await waitFor(() => transfer.responses().some(reply => reply.ok === true), "copy never started");
    transfer.socket.write(content);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(f.observations.finalized, 0);
    assert.equal(await f.service.open(transfer.id, "authenticated-session"), undefined);
    assert.equal(f.receiver.messages.some(message => message.type === "download"), false);
    transfer.socket.end();
    await waitFor(() => transfer.responses().some(reply => reply.state === "completed"), "copy was not finalized after EOF");
    assert.equal(f.observations.finalized, 1);
  }
});

test("cancelling a native HTTP download does not affect the completed CLI copy", async t => {
  const f = await fixture(t), base = await serveFixture(t, f), content = randomBytes(8 * 1024 * 1024);
  const result = await copyFile(f, "large.bin", content);
  const notice = f.receiver.messages.find(message => message.type === "download")!;
  await new Promise<void>((resolve, reject) => {
    const request = get(`${base}${notice.url}`, { headers: { Cookie: "canvas_session=authenticated-session" } }, response => {
      response.on("error", () => {});
      response.once("data", () => { response.destroy(); resolve(); });
    });
    request.once("error", reject);
    t.after(() => request.destroy());
  });
  assert.equal(result.code, 0);
  assert.equal(f.observations.aborted, 0);
  const retry = await f.service.open(String(notice.id), "authenticated-session");
  assert(retry);
  const chunks: Buffer[] = [];
  for await (const chunk of retry.body) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), content);
});

test("a missing browser context fails with not-attached without sending file data", async t => {
  const f = await fixture(t, { autoContext: false, contextTimeoutMs: 60 });
  await writeFile(join(f.root, "copy.txt"), "private data");
  const began = Date.now(), result = await f.run("copy.txt");
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "canvas: no browser attached to this window\n");
  assert(Date.now() - began < 2000);
  assert.equal(f.observations.uploadedBytes, 0);
});

test("no controlling browser fails immediately without a context round trip", async t => {
  const f = await fixture(t, { recipientAvailable: false });
  await writeFile(join(f.root, "copy.txt"), "private data");
  const began = Date.now(), result = await f.run("copy.txt");
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "canvas: no browser attached to this window\n");
  assert(Date.now() - began < 2000);
  assert.deepEqual(f.receiver.messages, []);
});

test("copy inactivity times out and removes partial staging", async t => {
  const f = await fixture(t, { progressTimeoutMs: 70 }), transfer = await sender(t, f, 10);
  await waitFor(() => transfer.responses().some(reply => reply.ok === true), "copy never started");
  transfer.socket.write("part");
  await waitFor(() => transfer.responses().some(reply => reply.ok === false), "stalled copy did not time out");
  assert.equal(transfer.responses().at(-1).reason, "timed-out");
  await waitFor(() => f.observations.aborted === 1, "staging upload was not aborted");
  assert.deepEqual(await readdir(join(f.root, "tmp")), ["staged"]);
  assert.deepEqual(await readdir(join(f.root, "tmp", "staged")), []);
});

test("browser disconnect before context fails, but an already bound copy finishes on the server", async t => {
  const unbound = await fixture(t, { autoContext: false }), first = await sender(t, unbound, 4);
  unbound.receiver.readyState = 3; unbound.receiver.emit("close");
  await waitFor(() => first.responses().some(reply => reply.ok === false), "unbound copy did not fail");
  assert.equal(first.responses().at(-1).reason, "not-attached");
  const bound = await fixture(t), second = await sender(t, bound, 4);
  await waitFor(() => second.responses().some(reply => reply.ok === true), "bound copy never started");
  bound.receiver.readyState = 3; bound.receiver.emit("close");
  second.socket.end("done");
  await waitFor(() => second.responses().some(reply => reply.state === "completed"), "bound copy did not survive browser disconnect");
  assert.equal(bound.observations.finalized, 1);
  assert.equal(bound.receiver.messages.some(message => message.type === "download"), false);
  const staged = await bound.service.open(second.id, "authenticated-session");
  assert(staged);
  staged.body.destroy();
});

test("copy retains its source until server staging finishes even after the last viewer leaves", async t => {
  const f = await fixture(t), releaseViewer = f.service.retainSource(source.id), transfer = await sender(t, f, 4);
  await waitFor(() => transfer.responses().some(reply => reply.ok === true), "copy never started");
  releaseViewer();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await readdir(f.registry)).length, 1, "in-flight copy owns a source lease");
  transfer.socket.end("done");
  await waitFor(() => transfer.responses().some(reply => reply.state === "completed"), "copy did not finish");
  await waitFor(async () => (await readdir(f.registry)).length === 0, "completed copy leaked the source lease");
});

test("staging creation, write and commit failures fail the helper and clean partial data", async t => {
  for (const uploadFailure of ["create", "write", "complete"] as const) {
    await t.test(uploadFailure, async t => {
      const f = await fixture(t, { uploadFailure });
      await writeFile(join(f.root, "copy.txt"), "copy bytes");
      const result = await f.run("copy.txt");
      assert.equal(result.code, 1);
      assert.match(result.stderr, /file transfer failed/u);
      assert.equal(f.receiver.messages.some(message => message.type === "download"), false);
      if (uploadFailure !== "create") {
        await waitFor(() => f.observations.aborted === 1, "failed staging upload was not aborted");
        assert.deepEqual(await readdir(join(f.root, "tmp")), ["staged"]);
        assert.deepEqual(await readdir(join(f.root, "tmp", "staged")), []);
      }
      assert.deepEqual(f.store.fileAssetIds(), []);
    });
  }
});

test("truncated and disconnected helpers cannot publish a file", async t => {
  for (const abrupt of [false, true]) {
    const f = await fixture(t), transfer = await sender(t, f, 10);
    await waitFor(() => transfer.responses().some(reply => reply.ok === true), "copy never started");
    if (abrupt) transfer.socket.destroy(); else transfer.socket.end("short");
    await waitFor(() => f.observations.aborted === 1, "invalid stream did not abort staging");
    assert.equal(f.receiver.messages.some(message => message.type === "download"), false);
    assert.deepEqual(await readdir(join(f.root, "tmp", "staged")), []);
  }
});

test("legacy helpers receive only actual copy start and completion acknowledgements", async t => {
  const f = await fixture(t), transfer = await sender(t, f, 4, false);
  await waitFor(() => transfer.responses().length === 1, "legacy helper received no copy acknowledgement");
  assert.equal(transfer.responses()[0].ok, true);
  transfer.socket.end("done");
  await waitFor(() => transfer.responses().length === 2, "legacy helper received no copy completion");
  assert.deepEqual(transfer.responses().map(reply => reply.ok), [true, true]);
});

test("malformed and oversized socket headers cannot generate a file transfer", async t => {
  const f = await fixture(t);
  const record = JSON.parse(await readFile(join(f.registry, (await readdir(f.registry))[0]!), "utf8"));
  for (const input of ["null\n", "[]\n", "1\n", "bad json\n", "x".repeat(17 * 1024)]) {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(record.socket);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("malformed header did not close")); }, 1000);
      socket.once("connect", () => socket.end(input));
      socket.resume(); socket.on("error", () => {});
      socket.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
  assert.deepEqual(f.receiver.messages, []);
  await copyFile(f, "still-working", Buffer.from("ok"));
});

test("linked tmux references for one native window resolve to one destination", async t => {
  const f = await fixture(t);
  f.setResources({ ...resources, spaces: [...resources.spaces, { id: "linked-space", name: "Linked", windows: [{ ...resources.spaces[0]!.windows[0]!, panes: [...resources.spaces[0]!.windows[0]!.panes] }] }] });
  await copyFile(f, "linked.bin", Buffer.from("one native window"));
  assert.equal(f.receiver.messages.filter(message => message.type === "download").length, 1);
});

test("two independent Canvas backends on the same native socket fail closed", async t => {
  const f = await fixture(t);
  const other = new OpenDownloadService({
    registryDirectory: f.registry, socketDirectory: f.sockets,
    createUpload: metadata => f.assets.begin(metadata), readTemporary: id => f.assets.readTemporary(id),
    prepare: async (_source, localSocket) => ({ nativeSocket: f.nativeSocket, remoteSocket: localSocket, cleanup: async () => {} }),
    resources: async () => resources,
    recipient: async () => ({ socket: f.receiver as never, sessionId: "authenticated-session", isCurrent: () => f.receiver.readyState === 1 }),
  });
  t.after(() => other.closeAll());
  await other.ensureSource({ ...source, id: "second-backend" });
  await writeFile(join(f.root, "ambiguous"), "must not be duplicated");
  const result = await f.run("ambiguous");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /multiple Canvas connections/u);
  assert.deepEqual(f.receiver.messages, []);
});
