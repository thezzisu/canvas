import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.ts";
import { Store, type Canvas, type SharedState } from "./state.ts";
import type { TerminalManager } from "./terminals.ts";

test("terminal presentation dimensions are shared across canvases while positions and notes stay local", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-shared-sizes-")), store = new Store(join(dir, "state.db"));
  const app = createApp(store, { username: "fixture", passwordHash: "unused" }, { closeSource: async () => {} } as unknown as TerminalManager);
  store.addSession("test");
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = (path: string, method = "GET", body?: unknown) => app.request(`http://localhost${path}`, {
    method, headers: { Host: "localhost", Cookie: "canvas_session=test", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const sourceId = randomUUID(), windowId = "generation:@1", key = `${sourceId}/${windowId}`;
  store.put("source", { id: sourceId, name: "Source", type: "tmux", transport: "local" });
  const node = (id: string, width = 900) => ({ id, sourceId, spaceId: id, windowId, x: 10, y: 20, width, height: 600 });
  const create = async (name: string, nodes: unknown[]) => {
    const response = await request("/api/canvases", "POST", { name, nodes });
    assert.equal(response.status, 201);
    return await response.json() as Canvas;
  };
  const first = await create("First", [node("first")]);
  const second = await create("Second", [node("second"), { id: "note", type: "note", title: "Notes", content: "stay", color: "yellow", minimized: false, x: 5, y: 6, width: 300, height: 200 }]);
  assert.equal(first.nodes[0]!.width, 480);
  assert.equal(second.nodes[0]!.height, 302);
  const firstPath = `/api/canvases/${first.id}`, secondPath = `/api/canvases/${second.id}`;
  await request(`${firstPath}/layout`, "PATCH", { nodes: [{ id: "first", width: 720, height: 410 }] });
  await request(`${secondPath}/layout`, "PATCH", { nodes: [{ id: "second", x: 77, y: 88 }, { id: "note", width: 360 }] });
  // A stale whole-canvas save and a new reference cannot rewrite shared size.
  await request(firstPath, "PATCH", { name: "Renamed", nodes: first.nodes });
  const third = await create("Third", [node("third", 1200)]);
  assert.equal(third.nodes[0]!.width, 720);
  const state = await (await request("/api/state")).json() as SharedState;
  assert.deepEqual(state.windowSizes[key], { width: 720, height: 410 });
  for (const canvas of state.canvases) {
    const terminal = canvas.nodes.find(item => item.type !== "note")!;
    assert.equal(terminal.width, 720);
    assert.equal(terminal.height, 410);
  }
  const secondView = state.canvases.find(canvas => canvas.id === second.id)!;
  assert.equal(secondView.nodes[0]!.x, 77);
  assert.equal(secondView.nodes[0]!.y, 88);
  assert.equal(secondView.nodes[1]!.width, 360);
  assert.equal(secondView.nodes[1]!.height, 200);
  assert.equal(state.canvases.find(canvas => canvas.id === first.id)!.nodes[0]!.x, 10);
  await request(`${secondPath}/layout`, "PATCH", { nodes: [{ id: "second", height: 450 }] });
  assert.deepEqual(store.snapshot().windowSizes[key], { width: 720, height: 450 });
  await request(`/api/sources/${sourceId}`, "DELETE");
  assert.equal(store.snapshot().windowSizes[key], undefined);
});

test("legacy sizes are seeded once from the first existing reference and remain authoritative after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-size-migration-")), path = join(dir, "state.db");
  let store = new Store(path);
  const sourceId = randomUUID(), windowId = "tab", key = `${sourceId}/${windowId}`;
  try {
    store.db.prepare("DELETE FROM documents WHERE kind='migration' AND id='window-sizes-v1'").run();
    for (const [index, width] of [640, 800].entries()) {
      const id = randomUUID();
      store.db.prepare("INSERT INTO documents(kind,id,body) VALUES('canvas',?,?)").run(id, JSON.stringify({ id, name: `Legacy ${index}`, nodes: [{ id: `node-${index}`, sourceId, spaceId: "s", windowId, x: index * 100, y: 0, width, height: 420 }] }));
    }
    store.close(); store = new Store(path);
    assert.deepEqual(store.snapshot().windowSizes[key], { width: 640, height: 420 });
    assert.ok(store.snapshot().canvases.every(canvas => canvas.nodes[0]!.width === 640));
    store.setWindowSize(sourceId, windowId, { width: 700 });
    store.close(); store = new Store(path);
    assert.deepEqual(store.snapshot().windowSizes[key], { width: 700, height: 420 });
    store.remove("source", sourceId);
    store.close(); store = new Store(path);
    assert.equal(store.snapshot().windowSizes[key], undefined, "orphan canvas refs recreated a removed source's size");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
