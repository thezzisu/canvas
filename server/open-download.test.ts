import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { createServer, get } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Source } from "./state.ts";
import { Store } from "./state.ts";
import { createApp } from "./app.ts";
import type { TerminalManager } from "./terminals.ts";
import { OpenDownloadService, type OpenDownloadOptions } from "./open-download.ts";

const helper = fileURLToPath(new URL("../cli/canvas", import.meta.url));
const source: Source = { id: "open-source", name: "Open", type: "herdr", transport: "local" };
const resources = {
  id: source.id, name: source.name, type: source.type, host: "local", status: "online" as const,
  spaces: [{ id: "space", name: "Space", windows: [{ id: "window", name: "Window", status: "unknown" as const, statusSource: "none" as const, panes: [{
    id: "pane", name: "shell", active: true, status: "unknown" as const, statusSource: "none" as const,
  }] }] }],
};

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  messages: Record<string, unknown>[] = [];
  send(value: string) { this.messages.push(JSON.parse(value)); }
}

async function fixture(t: TestContext, recipientAvailable = true, timeouts: Partial<Pick<OpenDownloadOptions, "decisionTimeoutMs" | "startTimeoutMs" | "progressTimeoutMs">> = {}) {
  const root = await mkdtemp(join(tmpdir(), "canvas-open-service-"));
  const registry = join(root, "registry"), sockets = join(root, "sockets");
  await mkdir(registry, { mode: 0o700 }); await mkdir(sockets, { mode: 0o700 });
  const nativeSocket = join(root, "herdr.sock");
  const receiver = new FakeWebSocket();
  const sessions = new Map<FakeWebSocket, string>([[receiver, "authenticated-session"]]);
  let resourceState = resources;
  const store = new Store(join(root, "canvas.db"));
  store.addSession("authenticated-session"); store.addSession("other-session");
  const service = new OpenDownloadService({
    registryDirectory: registry,
    socketDirectory: sockets,
    idleTimeoutMs: 15,
    ...timeouts,
    prepare: async (_source, localSocket) => ({ nativeSocket, remoteSocket: localSocket, cleanup: async () => {} }),
    resources: async () => resourceState,
    recipient: async () => recipientAvailable ? { socket: receiver as never, sessionId: sessions.get(receiver)!, isCurrent: () => receiver.readyState === 1 } : undefined,
  });
  await service.ensureSource(source);
  const app = createApp(store, { username: "fixture", passwordHash: "unused" }, {} as TerminalManager, {
    openDownload: (ticket, session, context) => service.open(ticket, session, context),
    downloadAction: (ticket, session, action, context) => service.action(ticket, session, action, context),
  });
  t.after(async () => {
    await service.closeAll();
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
  return { root, registry, sockets, nativeSocket, service, receiver, app, run, setResources(value: typeof resources) { resourceState = value } };
}

async function completeDownload(f: Awaited<ReturnType<typeof fixture>>, filename: string, contents: Buffer) {
  const file = join(f.root, filename);
  await writeFile(file, contents);
  const running = f.run(filename);
  for (let i = 0; i < 150 && !f.receiver.messages.some(message => message.type === "download"); i++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const notice = f.receiver.messages.find(message => message.type === "download");
  assert.ok(notice, "one download notice reaches the controlling WebSocket");
  const url = new URL(String(notice.url), "http://canvas.test");
  const id = url.pathname.split("/").at(-1)!;
  const wrongSession = await f.app.request(url.href, { headers: { Cookie: "canvas_session=other-session" } });
  assert.equal(wrongSession.status, 404, "a different browser session cannot consume the ticket");
  const accepted = await f.app.request(url.href, { method: "POST", headers: { Cookie: "canvas_session=authenticated-session", "Content-Type": "application/json" }, body: JSON.stringify({ action: "accept" }) });
  assert.equal(accepted.status, 200);
  const response = await f.app.request(url.href, { headers: { Cookie: "canvas_session=authenticated-session" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), null, "completion waits for validated helper EOF");
  assert.match(response.headers.get("content-disposition")!, /attachment/u);
  assert.match(response.headers.get("content-disposition")!, /filename\*=UTF-8''/u);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), contents);
  return await running;
}

async function serveFixture(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const server = createServer(getRequestListener(f.app.fetch));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(check: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

async function sender(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, size: number, progress = true) {
  const record = JSON.parse(await readFile(join(f.registry, (await readdir(f.registry))[0]!), "utf8"));
  const socket = createConnection(record.socket);
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  let responses = "";
  socket.on("data", data => responses += data.toString());
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(JSON.stringify({ version: 1, progress, secret: record.secret, provider: "herdr", nativeSocket: f.nativeSocket,
    paneId: "pane", filename: "file.bin", size }) + "\n");
  await waitFor(() => f.receiver.messages.some(message => message.type === "download"), "browser received no download offer");
  if (progress) {
    await waitFor(() => responses.includes("\n"), "helper received no offered state");
    assert.deepEqual(JSON.parse(responses.trim()), { state: "offered", transferred: 0, size });
  } else assert.equal(responses, "", "legacy helper must wait for HTTP consumption before acceptance");
  const notice = f.receiver.messages.find(message => message.type === "download");
  assert.ok(notice);
  return { socket, id: String(notice.id), url: String(notice.url), responses: () => responses.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}

test("canvas open streams arbitrary binary bytes only after binding a one-use browser ticket", async t => {
  const f = await fixture(t);
  const content = randomBytes(1024 * 1024 + 19);
  const result = await completeDownload(f, "风景 文件.bin", content);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(f.receiver.messages.filter(message => message.type === "download").length, 1);
  const ticket = String(new URL(String(f.receiver.messages[0]!.url), "http://canvas.test").pathname.split("/").at(-1));
  assert.equal(await f.service.open(ticket, "authenticated-session"), undefined);
  assert.equal(f.service.action(ticket, "authenticated-session", "cancel")?.state, "completed",
    "a late cancel must not overwrite an already completed transfer");
  assert.equal(f.service.action(ticket, "other-session", "cancel"), undefined,
    "completed ticket state remains private to its receiving browser session");
});

test("an empty file completes a real HTTP response and helper acknowledgement", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const base = await serveFixture(t, f);
  await writeFile(join(f.root, "empty"), "");
  const running = f.run("empty");
  await waitFor(() => f.receiver.messages.some(message => message.type === "download"), "helper emitted no download notice");
  const notice = f.receiver.messages.find(message => message.type === "download")!;
  const response = await fetch(`${base}${notice.url}`, { headers: { Cookie: "canvas_session=authenticated-session", Connection: "close" } });
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  const result = await running;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("accepting an offer does not send file bytes until the browser starts HTTP consumption", async t => {
  const f = await fixture(t), transfer = await sender(t, f, 4);
  assert.equal(f.service.action(transfer.id, "other-session", "accept"), undefined);
  assert.equal(f.service.action(transfer.id, "authenticated-session", "accept")?.state, "accepted");
  await waitFor(() => transfer.responses().some(response => response.state === "accepted"), "helper did not receive the accepted state");
  assert(!transfer.responses().some(response => response.ok === true), "acceptance alone must not unblock file transmission");
  const response = await f.app.request(`http://canvas.test${transfer.url}`, { headers: { Cookie: "canvas_session=authenticated-session" } });
  const reading = response.arrayBuffer();
  await waitFor(() => transfer.responses().some(response => response.ok === true), "HTTP consumption did not unblock the helper");
  transfer.socket.end("done");
  assert.equal(Buffer.from(await reading).toString(), "done");
  await waitFor(() => transfer.responses().some(response => response.state === "completed"), "helper did not receive completion");
});

test("the browser can reject an offer and the helper exits without transferring its file", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "decline.bin"), randomBytes(1024 * 1024));
  const running = f.run("decline.bin");
  await waitFor(() => f.receiver.messages.some(message => message.type === "download"), "browser received no offer");
  const notice = f.receiver.messages.find(message => message.type === "download")!;
  const response = await f.app.request(`http://canvas.test${notice.url}`, {
    method: "POST", headers: { Cookie: "canvas_session=authenticated-session", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "cancel" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "cancelled");
  const result = await running;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /download cancelled/u);
  assert(!f.receiver.messages.some(message => message.state === "transferring"));
  assert.equal(await f.service.open(String(notice.id), "authenticated-session"), undefined);
});

test("accepted downloads expire when the browser never starts its HTTP request", async t => {
  const f = await fixture(t, true, { startTimeoutMs: 80 }), transfer = await sender(t, f, 10);
  f.service.action(transfer.id, "authenticated-session", "accept");
  await waitFor(() => transfer.responses().some(response => response.ok === false), "accepted download did not expire");
  const failure = transfer.responses().at(-1);
  assert.equal(failure.reason, "not-started");
  assert.equal(failure.transferred, 0);
  assert(!transfer.responses().some(response => response.ok === true));
  assert.equal(await f.service.open(transfer.id, "authenticated-session"), undefined);
});

test("an unanswered offer expires and releases its helper", async t => {
  const f = await fixture(t, true, { decisionTimeoutMs: 80 }), transfer = await sender(t, f, 10);
  await waitFor(() => transfer.responses().some(response => response.ok === false), "offer did not expire");
  assert.equal(transfer.responses().at(-1).reason, "not-started");
  assert.equal(f.service.action(transfer.id, "authenticated-session", "accept")?.state, "failed");
});

test("a started transfer with no byte progress times out instead of hanging", async t => {
  const f = await fixture(t, true, { progressTimeoutMs: 80 }), transfer = await sender(t, f, 10);
  const response = await f.app.request(`http://canvas.test${transfer.url}`, { headers: { Cookie: "canvas_session=authenticated-session" } });
  const failed = assert.rejects(response.arrayBuffer(), /File transfer timed-out/u);
  await waitFor(() => transfer.responses().some(response => response.ok === false), "stalled transfer did not time out");
  assert.equal(transfer.responses().at(-1).reason, "timed-out");
  await failed;
});

test("legacy helpers receive only actual start and final acknowledgements", async t => {
  const f = await fixture(t), transfer = await sender(t, f, 4, false);
  f.service.action(transfer.id, "authenticated-session", "accept");
  assert.deepEqual(transfer.responses(), []);
  const response = await f.app.request(`http://canvas.test${transfer.url}`, { headers: { Cookie: "canvas_session=authenticated-session" } });
  const reading = response.arrayBuffer();
  await waitFor(() => transfer.responses().some(response => response.ok === true), "legacy helper received no acceptance");
  transfer.socket.end("done");
  assert.equal(Buffer.from(await reading).toString(), "done");
  await waitFor(() => transfer.responses().length === 2, "legacy helper received no completion");
  assert.deepEqual(transfer.responses().map(response => response.ok), [true, true]);
});

test("real HTTP downloads wait for helper EOF even after all declared bytes arrive", { timeout: 10_000 }, async t => {
  for (const content of [Buffer.alloc(0), Buffer.from("complete payload awaiting EOF")]) {
    const f = await fixture(t);
    const base = await serveFixture(t, f);
    const transfer = await sender(t, f, content.length);
    let received = false, completed = false;
    const reading = new Promise<Buffer>((resolve, reject) => {
      const request = get(base + transfer.url, { headers: { Cookie: "canvas_session=authenticated-session", Connection: "close" } }, response => {
        assert.equal(response.statusCode, 200);
        received = true;
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          completed = true;
          resolve(Buffer.concat(chunks));
        });
      });
      request.once("error", reject);
      t.after(() => request.destroy());
    });
    await waitFor(() => transfer.responses().some(response => response.ok === true), "helper was not accepted after the HTTP request");
    transfer.socket.write(content);
    await waitFor(() => received, "HTTP download did not begin");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(completed, false, "HTTP completed before the helper's validated EOF");
    assert.equal(transfer.socket.destroyed, false, "HTTP completion cancelled the helper before final acknowledgement");
    transfer.socket.end();
    assert.deepEqual(await reading, content);
    await waitFor(() => transfer.responses().some(response => response.state === "completed"), "helper received no final acknowledgement");
    assert.deepEqual(transfer.responses().filter(response => "ok" in response).map(response => response.ok), [true, true]);
    assert.equal(transfer.responses().at(-1).transferred, content.length);
  }
});

test("cancelling an active real HTTP download closes its helper connection", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const base = await serveFixture(t, f);
  const transfer = await sender(t, f, 8 * 1024 * 1024);
  const cancelled = new Promise<void>((resolve, reject) => {
    const request = get(base + transfer.url, { headers: { Cookie: "canvas_session=authenticated-session" } }, response => {
      response.on("error", () => {});
      response.once("data", () => { response.destroy(); resolve(); });
    });
    request.once("error", reject);
    t.after(() => request.destroy());
  });
  await waitFor(() => transfer.responses().some(response => response.ok === true), "helper was not accepted after the HTTP request");
  transfer.socket.write(Buffer.alloc(64 * 1024));
  await cancelled;
  await waitFor(() => transfer.socket.destroyed, "cancelled HTTP download retained the helper connection");
  assert(!transfer.responses().some(response => response.state === "completed"), "cancelled downloads must not acknowledge successful completion");
  assert.equal(transfer.responses().at(-1).ok, false);
});

test("malformed and oversized socket headers cannot affect the service or generate a download", async t => {
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
  assert.equal(f.receiver.messages.length, 0);
  assert.equal((await completeDownload(f, "still-working", Buffer.from("ok"))).code, 0);
});

test("truncated or disconnected helper streams reject the HTTP body instead of hanging", async t => {
  const f = await fixture(t);
  for (const abrupt of [false, true]) {
    f.receiver.messages.length = 0;
    const transfer = await sender(t, f, 10);
    const response = await f.app.request(`http://canvas.test${transfer.url}`, { headers: { Cookie: "canvas_session=authenticated-session" } });
    const reading = response.arrayBuffer();
    const failed = assert.rejects(reading, /File transfer/u);
    await waitFor(() => transfer.responses().some(response => response.ok === true), "helper was not accepted");
    if (abrupt) transfer.socket.destroy(); else transfer.socket.end("short");
    await failed;
    transfer.socket.destroy();
  }
});

test("canvas open refuses panes without a live controlling browser before sending file bytes", async t => {
  const f = await fixture(t, false);
  const file = join(f.root, "not-sent"); await writeFile(file, "private bytes");
  const began = Date.now();
  const result = await f.run(file);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "canvas: no browser attached to this window\n");
  assert(Date.now() - began < 2000, "no active browser must fail before the decision timeout");
  assert.deepEqual(f.receiver.messages, []);
});

test("linked tmux references for one native window resolve to one controller", async t => {
  const f = await fixture(t);
  f.setResources({ ...resources, spaces: [...resources.spaces, { id: "linked-space", name: "Linked", windows: [{ ...resources.spaces[0]!.windows[0]!, panes: [...resources.spaces[0]!.windows[0]!.panes] }] }] });
  const result = await completeDownload(f, "linked.bin", Buffer.from("one native window"));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.receiver.messages.filter(message => message.type === "download").length, 1);
});

test("closing the controlling browser cancels a pending one-use download", async t => {
  const f = await fixture(t);
  const file = join(f.root, "cancelled"); await writeFile(file, randomBytes(256 * 1024));
  const running = f.run(file);
  for (let i = 0; i < 150 && !f.receiver.messages.some(message => message.type === "download"); i++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert(f.receiver.messages.some(message => message.type === "download"));
  f.receiver.emit("close");
  const result = await running;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /file transfer failed|download connection closed|no Canvas tab/u);
});

test("two independent Canvas backends on the same native socket fail closed", async t => {
  const f = await fixture(t);
  const other = new OpenDownloadService({
    registryDirectory: f.registry,
    socketDirectory: f.sockets,
    prepare: async (_source, localSocket) => ({ nativeSocket: f.nativeSocket, remoteSocket: localSocket, cleanup: async () => {} }),
    resources: async () => resources,
    recipient: async () => ({ socket: f.receiver as never, sessionId: "authenticated-session", isCurrent: () => f.receiver.readyState === 1 }),
  });
  await other.ensureSource({ ...source, id: "second-backend" });
  const file = join(f.root, "ambiguous"); await writeFile(file, "must not be duplicated");
  const result = await f.run(file);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /multiple Canvas connections/u);
  assert.deepEqual(f.receiver.messages, []);
  await other.closeAll();
});

test("the last viewer releases its bridge after an idle grace period; a returning viewer retains it", async t => {
  const f = await fixture(t);
  const releaseFirst = f.service.retainSource(source.id);
  releaseFirst();
  const releaseSecond = f.service.retainSource(source.id);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await readdir(f.registry)).length, 1);
  releaseSecond();
  for (let i = 0; i < 100 && (await readdir(f.registry)).length; i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await readdir(f.registry)).length, 0);
  await f.service.ensureSource(source);
  assert.equal((await readdir(f.registry)).length, 1);
});
