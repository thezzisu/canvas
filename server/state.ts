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
export const itemSchema = z
  .object({
    id: z.string().max(150),
    sourceId: z.string().uuid(),
    spaceId: z.string().max(300),
    windowId: z.string().max(300),
    x: z.number().finite().min(-1e7).max(1e7),
    y: z.number().finite().min(-1e7).max(1e7),
    width: z.number().min(240).max(4000),
    height: z.number().min(160).max(3000),
  })
  .strict();
export const canvasSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(100),
    nodes: z.array(itemSchema).max(500).default([]),
  })
  .strict();
export type Canvas = z.infer<typeof canvasSchema> & { id: string };
export type CanvasBackground = { url: string; opacity: number };
export type CanvasView = Canvas & { background: CanvasBackground | null };
export type SharedState = {
  instanceId: string;
  revision: number;
  sources: Source[];
  canvases: CanvasView[];
  overviewBackground: CanvasBackground | null;
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
    const result = { ...obj, id: obj.id ?? randomUUID() };
    this.db
      .prepare(
        "INSERT INTO documents(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, result.id, JSON.stringify(result));
    this.changed();
    return result;
  }
  remove(kind: string, id: string) {
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
      background: background
        ? {
            url: `/api/backgrounds/${String(background.image_id)}`,
            opacity: Number(background.opacity),
          }
        : null,
    };
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
