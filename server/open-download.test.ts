import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Source } from "./state.ts";
import { Store } from "./state.ts";
import { createApp } from "./app.ts";
import type { TerminalManager } from "./terminals.ts";
import { OpenDownloadService } from "./open-download.ts";

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

async function fixture(t: TestContext, recipientAvailable = true) {
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
    prepare: async (_source, localSocket) => ({ nativeSocket, remoteSocket: localSocket, cleanup: async () => {} }),
    resources: async () => resourceState,
    recipient: async () => recipientAvailable ? { socket: receiver as never, sessionId: sessions.get(receiver)!, isCurrent: () => receiver.readyState === 1 } : undefined,
  });
  await service.ensureSource(source);
  const app = createApp(store, { username: "fixture", passwordHash: "unused" }, {} as TerminalManager, {
    openDownload: (ticket, session) => service.open(ticket, session),
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
  const response = await f.app.request(url.href, { headers: { Cookie: "canvas_session=authenticated-session" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(contents.length));
  assert.match(response.headers.get("content-disposition")!, /attachment/u);
  assert.match(response.headers.get("content-disposition")!, /filename\*=UTF-8''/u);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), contents);
  return await running;
}

test("canvas open streams arbitrary binary bytes only after binding a one-use browser ticket", async t => {
  const f = await fixture(t);
  const content = randomBytes(1024 * 1024 + 19);
  const result = await completeDownload(f, "风景 文件.bin", content);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(f.receiver.messages.filter(message => message.type === "download").length, 1);
  const ticket = String(new URL(String(f.receiver.messages[0]!.url), "http://canvas.test").pathname.split("/").at(-1));
  assert.equal(f.service.open(ticket, "authenticated-session"), undefined);
});

test("canvas open refuses panes without a live controlling browser before sending file bytes", async t => {
  const f = await fixture(t, false);
  const file = join(f.root, "not-sent"); await writeFile(file, "private bytes");
  const result = await f.run(file);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no Canvas tab/u);
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
