import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.ts";
import { Store, type Canvas } from "./state.ts";
import type { TerminalManager } from "./terminals.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "canvas-notes-"));
  const store = new Store(join(dir, "canvas.db"));
  const app = createApp(store, { username: "fixture", passwordHash: "unused" }, {
    closeAll: async () => {}, closeSource: async () => {},
  } as unknown as TerminalManager);
  store.addSession("test");
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const headers = { Host: "localhost", Cookie: "canvas_session=test", "Content-Type": "application/json" };
  const request = (path: string, method = "GET", body?: unknown) => app.request(`http://localhost${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  function delayed(path: string, method: string, value: unknown) {
    let release!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close(); };
    } });
    const result = app.request(`http://localhost${path}`, { method, headers, body, duplex: "half" } as RequestInit);
    return { result, release };
  }
  return { store, request, delayed, app };
}
const terminal = () => ({ id: "terminal", type: "terminal" as const, sourceId: randomUUID(), spaceId: "space", windowId: "window", x: 0, y: 0, width: 500, height: 300 });
const note = () => ({ id: "note", type: "note" as const, title: "A", content: "A", color: "yellow" as const, minimized: false, x: 0, y: 0, width: 320, height: 240 });
const findNote = (canvas: Canvas, id = "note") => canvas.nodes.filter(node => node.type === "note").find(node => node.id === id)!;

test("notes persist alongside terminal nodes with validated editable fields", async (t) => {
  const f = fixture(t);
  const created = await f.request("/api/canvases", "POST", { name: "Ideas", nodes: [terminal()] });
  assert.equal(created.status, 201);
  const canvas = (await created.json()) as Canvas;
  const path = `/api/canvases/${canvas.id}`;
  const response = await f.request(`${path}/notes`, "POST", { title: "Ship", content: "first", color: "blue" });
  assert.equal(response.status, 201);
  const noteCanvas = (await response.json()) as Canvas;
  const added = noteCanvas.nodes.find(node => node.type === "note")!;
  assert.equal(added.width, 320);
  assert.equal(noteCanvas.nodes[0]?.type, "terminal");
  assert.equal((await f.request(`${path}/notes/${added.id}`, "PATCH", { content: "second", minimized: true })).status, 200);
  const stored = f.store.get<Canvas>("canvas", canvas.id)!;
  assert.equal(findNote(stored, added.id).title, "Ship");
  assert.equal(findNote(stored, added.id).content, "second");
  assert.equal(findNote(stored, added.id).minimized, true);
  assert.equal((await f.request(`${path}/notes/${added.id}`, "PATCH", { color: "invalid" })).status, 400);
  assert.equal((await f.request(`${path}/notes/${added.id}`, "PATCH", { x: 50 })).status, 400);
  assert.equal((await f.request(`${path}/notes/terminal`, "PATCH", { content: "bad" })).status, 404);
  assert.equal((await f.request(`${path}`, "PATCH", { snapToGrid: true })).status, 200);
  assert.equal(f.store.get<Canvas>("canvas", canvas.id)!.snapToGrid, true);
});

test("canvas nodes require an explicit supported type before persistence", async t => {
  const f = fixture(t), { type: _type, ...untyped } = terminal();
  for (const node of [untyped, { ...untyped, type: "unknown" }]) {
    const response = await f.request("/api/canvases", "POST", { name: "Invalid", nodes: [node] });
    assert.equal(response.status, 400);
  }
  assert.equal(f.store.list<Canvas>("canvas").length, 0);
});

test("note creation and edits require authentication and overview remains immutable", async (t) => {
  const f = fixture(t);
  assert.equal((await f.app.request("http://localhost/api/canvases/overview/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  for (const [path, method, body] of [["notes", "POST", {}], ["notes/note", "PATCH", { content: "bad" }], ["nodes/note", "DELETE", undefined], ["layout", "PATCH", { nodes: [] }]] as const)
    assert.equal((await f.request(`/api/canvases/overview/${path}`, method, body)).status, 403);
  assert.equal(f.store.get<Canvas>("canvas", "overview")!.nodes.length, 0);
});

test("delayed note edits merge against current layout and cannot resurrect removed nodes", async (t) => {
  const f = fixture(t);
  const canvas = f.store.put<Canvas>("canvas", { id: randomUUID(), name: "Shared", nodes: [note(), terminal()] });
  const path = `/api/canvases/${canvas.id}`;
  const edit = f.delayed(`${path}/notes/note`, "PATCH", { content: "B" });
  await f.request(`${path}/layout`, "PATCH", { nodes: [{ id: "terminal", x: 90 }, { id: "note", width: 480 }] });
  await f.request(path, "PATCH", { name: "Renamed" });
  edit.release();
  assert.equal((await edit.result).status, 200);
  const saved = f.store.get<Canvas>("canvas", canvas.id)!;
  assert.equal(saved.name, "Renamed");
  assert.equal(saved.nodes.find(n => n.id === "terminal")?.x, 90);
  assert.equal(findNote(saved).width, 480);
  assert.equal(findNote(saved).content, "B");
  const late = f.delayed(`${path}/notes/note`, "PATCH", { content: "Resurrect" });
  await f.request(`${path}/nodes/note`, "DELETE");
  late.release();
  assert.equal((await late.result).status, 404);
  assert.equal(f.store.get<Canvas>("canvas", canvas.id)!.nodes.length, 1);
  const create = f.delayed(`${path}/notes`, "POST", { title: "Delayed" });
  await f.request(path, "DELETE");
  create.release();
  assert.equal((await create.result).status, 404);
});

test("multiple notes do not deduplicate as windows and content changes publish live snapshots", async (t) => {
  const f = fixture(t);
  const canvas = f.store.put<Canvas>("canvas", { id: randomUUID(), name: "Shared", nodes: [note()] });
  const path = `/api/canvases/${canvas.id}`;
  const events = await f.request("/api/events"), reader = events.body!.getReader();
  t.after(() => reader.cancel());
  await reader.read();
  await f.request(`${path}/nodes`, "POST", { nodes: [{ ...note(), id: "other" }, terminal()] });
  assert.equal(f.store.get<Canvas>("canvas", canvas.id)!.nodes.length, 3);
  await reader.read();
  await f.request(`${path}/notes/note`, "PATCH", { content: "Synced" });
  const payload = new TextDecoder().decode((await reader.read()).value);
  assert.match(payload, /Synced/);
  await f.request(`${path}/notes/other`, "PATCH", { color: "green" });
  assert.equal(findNote(f.store.get<Canvas>("canvas", canvas.id)!).content, "Synced");
});
