import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.ts";
import { Store, type Canvas, type SharedState } from "./state.ts";
import type { TerminalManager } from "./terminals.ts";
import { defaultSettings } from '../shared/settings.ts';

test("terminal presentation dimensions are shared across canvases while positions and notes stay local", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-shared-sizes-")), store = new Store(join(dir, "state.db"));
  const app = createApp(store, { username: "fixture", passwordHash: "unused" }, { closeSource: async () => {} } as unknown as TerminalManager);
  store.addSession("test");
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = (path: string, method = "GET", body?: unknown) => app.request(`http://localhost${path}`, {
    method, headers: { Host: "localhost", Authorization: "Bearer test", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const sourceId = randomUUID(), windowId = "generation:@1", key = `${sourceId}/${windowId}`;
  store.put("source", { id: sourceId, name: "Source", transport: "local" });
  const node = (id: string, width = 900) => ({ id, type: "terminal" as const, sourceId, spaceId: id, windowId, x: 10, y: 20, width, height: 600 });
  const create = async (name: string, nodes: unknown[]) => {
    const response = await request("/api/canvases", "POST", { name, nodes });
    assert.equal(response.status, 201);
    return await response.json() as Canvas;
  };
  const first = await create("First", [node("first")]);
  const second = await create("Second", [node("second"), { id: "note", type: "note", title: "Notes", content: "stay", color: "yellow", x: 5, y: 6, width: 300, height: 200 }]);
  assert.equal(first.nodes[0]!.width, 1082);
  assert.equal(second.nodes[0]!.height, 672);
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
    const terminal = canvas.nodes.find(item => item.type === "terminal")!;
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

test("canonical window sizes persist across restarts and missing sizes stay at the shared default", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-size-persistence-")), path = join(dir, "state.db");
  let store = new Store(path);
  const sourceId = randomUUID(), windowId = "tab", key = `${sourceId}/${windowId}`;
  try {
    assert.deepEqual(store.windowSize(sourceId, windowId), { width: 1082, height: 672 });
    for (const [index, width] of [640, 800].entries()) {
      const id = randomUUID();
      store.put<Canvas>("canvas", { id, name: `Canvas ${index}`, nodes: [{ id: `node-${index}`, type: "terminal", sourceId, spaceId: "s", windowId, x: index * 100, y: 0, width, height: 420 }] });
    }
    store.close(); store = new Store(path);
    assert.equal(store.snapshot().windowSizes[key], undefined, "opening a store does not create dimensions from canvas references");
    assert.ok(store.snapshot().canvases.every(canvas => canvas.nodes[0]!.width === 1082 && canvas.nodes[0]!.height === 672));
    store.setWindowSize(sourceId, windowId, { width: 700, height: 420 });
    store.close(); store = new Store(path);
    assert.deepEqual(store.snapshot().windowSizes[key], { width: 700, height: 420 });
    store.remove("source", sourceId);
    store.close(); store = new Store(path);
    assert.equal(store.snapshot().windowSizes[key], undefined, "orphan canvas refs recreated a removed source's size");
    assert.deepEqual(store.windowSize(sourceId, windowId), { width: 1082, height: 672 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('normal native geometry derives from the latest shared dimensions and atomically saved font metrics', t => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-normal-grid-')), path = join(dir, 'state.db');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(store.normalTerminalSize('source', 'window'), { cols: 150, rows: 40 });
  store.setWindowSize('source', 'window', { width: 802, height: 572 });
  const snapshots: unknown[] = [];
  store.on('change', () => snapshots.push({ settings: store.settings(), grid: store.normalTerminalSize('source', 'window') }));
  const settings = { contentFont: { stack: [{ family: 'Fixture Mono' }], ligatures: false }, terminalCell: { width: 8, height: 18 } };
  store.updateSettings(settings);
  assert.deepEqual(snapshots, [{ settings, grid: { cols: 100, rows: 30 } }]);
  // A font change uses current dimensions rather than a browser's stale map.
  store.setWindowSize('source', 'window', { width: 962 });
  store.updateSettings({ ...settings, terminalCell: { width: 9.6, height: 18 } });
  assert.deepEqual(store.normalTerminalSize('source', 'window'), { cols: 100, rows: 30 });
  store.close(); store = new Store(path);
  assert.deepEqual(store.normalTerminalSize('source', 'window'), { cols: 100, rows: 30 });
  assert.deepEqual(store.windowSize('source', 'window'), { width: 962, height: 572 });
  store.updateSettings(defaultSettings());
  assert.deepEqual(store.normalTerminalSize('source', 'window'), { cols: 133, rows: 33 });
  assert.deepEqual(store.snapshot().windowSizes['source/window'], { width: 962, height: 572 }, 'no duplicate stored grid is created');
});

test('only committed terminal dimensions and canonical cell changes invalidate normal geometry', t => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-geometry-events-')), store = new Store(join(dir, 'state.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const id = randomUUID(), sourceId = randomUUID(), windowId = 'tab';
  store.put('source', { id: sourceId, name: 'Fixture', transport: 'local' });
  store.put<Canvas>('canvas', { id, name: 'Fixture', nodes: [
    { id: 'terminal', type: 'terminal', sourceId, spaceId: 'space', windowId, x: 0, y: 0, width: 1082, height: 672 },
    { id: 'note', type: 'note', title: 'Note', content: '', color: 'blue', x: 0, y: 0, width: 320, height: 240 },
  ] });
  const flags: boolean[] = [], grids: unknown[] = [];
  store.on('change', (flag: boolean) => { flags.push(flag); grids.push(store.normalTerminalSize(sourceId, windowId)); });
  store.updateNote(id, 'note', { content: 'Typing does not fit native terminals' });
  store.applyLayout(id, [{ id: 'note', width: 400 }, { id: 'terminal', x: 100, y: 200 }]);
  const otherId = randomUUID(); store.put<Canvas>('canvas', { id: otherId, name: 'Other', nodes: [] });
  store.updateNavigationOrder('canvases', [otherId, id]);
  store.applyLayout(id, [{ id: 'terminal', width: 1082, height: 672 }]);
  store.updateSettings({ ...defaultSettings(), contentFont: { stack: [{ family: 'Same Metrics Font' }], ligatures: false } });
  assert(flags.length >= 5 && flags.every(flag => flag === false));
  flags.length = 0; grids.length = 0;
  store.applyLayout(id, [{ id: 'terminal', width: 1154 }]);
  assert.deepEqual(flags, [true]);
  assert.deepEqual(grids, [{ cols: 160, rows: 40 }], 'listeners see committed shared dimensions');
  store.updateSettings({ ...store.settings(), terminalCell: { width: 8, height: 16 } });
  assert.deepEqual(flags, [true, true], 'the same font with changed canonical metrics recomputes normal geometry');
  assert.deepEqual(grids[1], { cols: 144, rows: 40 });
  const before = store.snapshot();
  assert.throws(() => store.applyLayout(id, [{ id: 'terminal', width: 1300, expected: { width: 999 } }]));
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(flags, [true, true], 'rolled-back layout edits emit no geometry event');
});
