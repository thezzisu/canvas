import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";

export const sourceSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(100),
    type: z.enum(["tmux", "herdr"]),
    transport: z.enum(["local", "ssh"]),
    target: z.string().max(500).optional(),
    sshIdentityFile: z.string().max(1000).optional(),
    sshKnownHostsFile: z.string().max(1000).optional(),
    binary: z.string().max(1000).optional(),
    tmuxSocket: z.string().max(1000).optional(),
    herdrSession: z.string().max(100).optional(),
  })
  .strict()
  .refine(
    (s) => s.transport !== "ssh" || !!s.target?.trim(),
    "SSH target is required",
  );
export type Source = z.infer<typeof sourceSchema> & { id: string };
export const nodeLayoutSchema = z.object({
  id: z.string().min(1).max(150),
  x: z.number().finite().min(-1e7).max(1e7),
  y: z.number().finite().min(-1e7).max(1e7),
  width: z.number().min(240).max(4000),
  height: z.number().min(160).max(3000),
}).strict();
export const terminalNodeSchema = nodeLayoutSchema.extend({
  // Existing saved canvases omit type; they remain terminal nodes.
  type: z.literal("terminal").optional(),
  sourceId: z.string().uuid(),
  spaceId: z.string().max(300),
  windowId: z.string().max(300),
}).strict();
export const noteColorSchema = z.enum(["yellow", "blue", "green", "pink", "neutral"]);
export const noteNodeSchema = nodeLayoutSchema.extend({
  type: z.literal("note"),
  title: z.string().max(200).default("便签"),
  content: z.string().max(200_000).default(""),
  color: noteColorSchema.default("yellow"),
  minimized: z.boolean().default(false),
}).strict();
export const itemSchema = z.union([terminalNodeSchema, noteNodeSchema]);
export const canvasSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(100),
    nodes: z.array(itemSchema).max(500).default([]),
    snapToGrid: z.boolean().optional(),
  })
  .strict();
export type Canvas = z.infer<typeof canvasSchema> & { id: string };
export type CanvasBackground = { url: string; opacity: number };
export type CanvasView = Canvas & { background: CanvasBackground | null };
export type WindowSize = { width: number; height: number };
const defaultWindowSize: WindowSize = { width: 480, height: 302 };
export type SharedState = {
  instanceId: string;
  revision: number;
  sources: Source[];
  canvases: CanvasView[];
  overviewBackground: CanvasBackground | null;
  windowSizes: Record<string, WindowSize>;
};
export class Store extends EventEmitter {
  db: DatabaseSync;
  readonly instanceId = randomUUID();
  revision = 0;
  constructor(path: string) {
    super();
    this.setMaxListeners(0);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS documents (kind TEXT, id TEXT, body TEXT, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER); CREATE TABLE IF NOT EXISTS canvas_backgrounds (canvas_id TEXT PRIMARY KEY, image_id TEXT NOT NULL UNIQUE, opacity REAL NOT NULL CHECK(opacity >= 0 AND opacity <= 1), data BLOB NOT NULL, document_kind TEXT NOT NULL DEFAULT 'canvas' CHECK(document_kind = 'canvas'), FOREIGN KEY(document_kind, canvas_id) REFERENCES documents(kind, id) ON DELETE CASCADE);",
    );
    // The overview only owns its background. Its name and generated window
    // layout never enter the editable canvas collection.
    this.db
      .prepare(
        "INSERT OR IGNORE INTO documents(kind,id,body) VALUES('canvas','overview',?)",
      )
      .run(JSON.stringify({ id: "overview", name: "总览", nodes: [] }));
    // Existing references establish one shared presentation size. Later stale
    // canvas documents must never become writers of that size merely by saving.
    if (!this.get("migration", "window-sizes-v1")) {
      const seed = this.db.prepare(
        "INSERT OR IGNORE INTO documents(kind,id,body) VALUES('window-size',?,?)",
      );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const canvas of this.list<Canvas>("canvas"))
          for (const node of canvas.nodes)
            if (node.type !== "note") {
              const id = `${node.sourceId}/${node.windowId}`;
              seed.run(id, JSON.stringify({ id, width: node.width, height: node.height }));
            }
        this.db.prepare("INSERT INTO documents(kind,id,body) VALUES('migration','window-sizes-v1','{}')").run();
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }
  list<T>(kind: string): T[] {
    return this.db
      .prepare(
        "SELECT body FROM documents WHERE kind=? AND NOT(kind='canvas' AND id='overview') ORDER BY rowid",
      )
      .all(kind)
      .map((r) => JSON.parse(String(r.body)));
  }
  get<T>(kind: string, id: string): T | undefined {
    const r = this.db
      .prepare("SELECT body FROM documents WHERE kind=? AND id=?")
      .get(kind, id);
    return r ? JSON.parse(String(r.body)) : undefined;
  }
  put<T extends { id?: string }>(kind: string, obj: T): T & { id: string } {
    let result = { ...obj, id: obj.id ?? randomUUID() };
    if (kind === "canvas") {
      const canvas = result as unknown as Canvas;
      result = { ...result, nodes: this.normalizeNodes(canvas.nodes) };
    }
    this.db
      .prepare(
        "INSERT INTO documents(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, result.id, JSON.stringify(result));
    this.changed();
    return result;
  }
  remove(kind: string, id: string) {
    if (kind === "source")
      this.db.prepare("DELETE FROM documents WHERE kind='window-size' AND substr(id,1,?)=?")
        .run(id.length + 1, `${id}/`);
    this.db
      .prepare("DELETE FROM documents WHERE kind=? AND id=?")
      .run(kind, id);
    this.changed();
  }
  private changed() {
    this.revision++;
    this.emit("change");
  }
  snapshot(): SharedState {
    return {
      instanceId: this.instanceId,
      revision: this.revision,
      sources: this.list<Source>("source"),
      canvases: this.list<Canvas>("canvas").map((canvas) =>
        this.canvasView(canvas),
      ),
      overviewBackground: this.canvasView(
        this.get<Canvas>("canvas", "overview")!,
      ).background,
      windowSizes: Object.fromEntries(this.list<WindowSize & { id: string }>("window-size")
        .map(({ id, width, height }) => [id, { width, height }])),
    };
  }
  canvasView(canvas: Canvas): CanvasView {
    const background = this.db
      .prepare(
        "SELECT image_id, opacity FROM canvas_backgrounds WHERE canvas_id=?",
      )
      .get(canvas.id);
    return {
      ...canvas,
      nodes: this.normalizeNodes(canvas.nodes),
      background: background
        ? {
            url: `/api/backgrounds/${String(background.image_id)}`,
            opacity: Number(background.opacity),
          }
        : null,
    };
  }
  windowSize(sourceId: string, windowId: string): WindowSize {
    const stored = this.get<WindowSize>("window-size", `${sourceId}/${windowId}`);
    return stored ? { width: stored.width, height: stored.height } : { ...defaultWindowSize };
  }
  setWindowSize(sourceId: string, windowId: string, patch: Partial<WindowSize>) {
    const id = `${sourceId}/${windowId}`;
    const value = { id, ...this.windowSize(sourceId, windowId), ...patch };
    this.db.prepare("INSERT INTO documents(kind,id,body) VALUES('window-size',?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body")
      .run(id, JSON.stringify(value));
    // The owning canvas write publishes the combined geometry/layout snapshot.
  }
  private normalizeNodes(nodes: Canvas["nodes"]): Canvas["nodes"] {
    return nodes.map(node => node.type === "note" ? node : {
      ...node, ...this.windowSize(node.sourceId, node.windowId),
    });
  }
  setCanvasBackground(canvasId: string, data: Uint8Array, opacity: number) {
    this.db
      .prepare(
        "INSERT INTO canvas_backgrounds(canvas_id,image_id,opacity,data) VALUES(?,?,?,?) ON CONFLICT(canvas_id) DO UPDATE SET image_id=excluded.image_id, opacity=excluded.opacity, data=excluded.data",
      )
      .run(canvasId, randomUUID(), opacity, data);
    this.changed();
  }
  setCanvasBackgroundOpacity(canvasId: string, opacity: number) {
    this.db
      .prepare("UPDATE canvas_backgrounds SET opacity=? WHERE canvas_id=?")
      .run(opacity, canvasId);
    this.changed();
  }
  removeCanvasBackground(canvasId: string) {
    this.db
      .prepare("DELETE FROM canvas_backgrounds WHERE canvas_id=?")
      .run(canvasId);
    this.changed();
  }
  getBackground(imageId: string): Uint8Array | undefined {
    const result = this.db
      .prepare("SELECT data FROM canvas_backgrounds WHERE image_id=?")
      .get(imageId);
    return result?.data as Uint8Array | undefined;
  }
  addSession(id: string) {
    this.db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?)")
      .run(id, Date.now() + 7 * 86400000);
  }
  hasSession(id: string) {
    return !!this.db
      .prepare("SELECT id FROM sessions WHERE id=? AND expires>?")
      .get(id, Date.now());
  }
  removeSession(id: string) {
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    this.emit("sessions");
  }
  close() {
    this.emit("close");
    this.removeAllListeners();
    this.db.close();
  }
}
