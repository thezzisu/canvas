import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { defaultSettings, type GlobalSettings } from "../shared/settings.ts";
import { settingsPatchSchema } from "./settings.ts";

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
    herdrSession: z.preprocess(
      value => typeof value === "string" && !value.trim() ? undefined : value,
      z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/u).refine(value => value !== "." && value !== "..").optional(),
    ),
    herdrSocket: z.preprocess(
      value => typeof value === "string" && !value.trim() ? undefined : value,
      z.string().trim().max(1000).refine(value => value.startsWith("/") && !/[:\x00-\x1f\x7f]/u.test(value), "Use an absolute herdr socket path").optional(),
    ),
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
  type: z.literal("terminal"),
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
export const fileAssetSchema = z.object({
  id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mime: z.string().max(100),
  preview: z.enum(["image", "pdf", "text", "file"]),
  createdAt: z.number().int().nonnegative(),
}).strict();
export const fileNodeSchema = nodeLayoutSchema.extend({
  type: z.literal("file"),
  assetId: z.string().uuid(),
  asset: fileAssetSchema.optional(),
}).strict();
export const itemSchema = z.discriminatedUnion("type", [terminalNodeSchema, noteNodeSchema, fileNodeSchema]);
export type TerminalNode = z.infer<typeof terminalNodeSchema>;
export type NoteNode = z.infer<typeof noteNodeSchema>;
export type FileNode = z.infer<typeof fileNodeSchema>;
export type CanvasNode = z.infer<typeof itemSchema>;
export type FileAsset = {
  id: string;
  filename: string;
  size: number;
  mime: string;
  preview: "image" | "pdf" | "text" | "file";
  createdAt: number;
};
export type FileNodeView = FileNode & { asset: FileAsset };
export type FileNodeContext = {
  canvasId?: string;
  anchorId?: string;
  sourceId: string;
  windowId: string;
};
export const isTerminalNode = (node: CanvasNode): node is TerminalNode =>
  node.type === "terminal";
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
export type CanvasView = Omit<Canvas, "nodes"> & {
  nodes: Array<Exclude<CanvasNode, FileNode> | FileNodeView>;
  background: CanvasBackground | null;
};
export type WindowSize = { width: number; height: number };
const defaultWindowSize: WindowSize = { width: 480, height: 302 };
export type SharedState = {
  settings: GlobalSettings;
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
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS documents (kind TEXT, id TEXT, body TEXT, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER); CREATE TABLE IF NOT EXISTS canvas_backgrounds (canvas_id TEXT PRIMARY KEY, image_id TEXT NOT NULL UNIQUE, opacity REAL NOT NULL CHECK(opacity >= 0 AND opacity <= 1), data BLOB NOT NULL, document_kind TEXT NOT NULL DEFAULT 'canvas' CHECK(document_kind = 'canvas'), FOREIGN KEY(document_kind, canvas_id) REFERENCES documents(kind, id) ON DELETE CASCADE); CREATE TABLE IF NOT EXISTS canvas_files (id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0), mime TEXT NOT NULL, preview TEXT NOT NULL, created_at INTEGER NOT NULL);",
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
    let result = { ...obj, id: obj.id ?? randomUUID() };
    if (kind === "canvas") {
      const canvas = result as unknown as Canvas;
      this.validateFileNodes(canvas);
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
      settings: this.settings(),
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
  settings(): GlobalSettings {
    const stored = this.get<unknown>("settings", "global");
    return stored === undefined ? defaultSettings() : settingsPatchSchema.parse(stored);
  }
  updateSettings(value: GlobalSettings): GlobalSettings {
    const settings = settingsPatchSchema.parse(value);
    if (isDeepStrictEqual(settings, this.settings())) return settings;
    this.db.prepare("INSERT INTO documents(kind,id,body) VALUES('settings','global',?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body")
      .run(JSON.stringify(settings));
    this.changed();
    return settings;
  }
  canvasView(canvas: Canvas): CanvasView {
    const background = this.db
      .prepare(
        "SELECT image_id, opacity FROM canvas_backgrounds WHERE canvas_id=?",
      )
      .get(canvas.id);
    return {
      ...canvas,
      nodes: canvas.nodes.map(node => node.type === "file"
        ? { ...node, asset: this.fileAssetForCanvas(node.assetId, canvas.id)! }
        : node.type === "note" ? node : { ...node, ...this.windowSize(node.sourceId, node.windowId) }),
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
    return nodes.map(node => {
      if (node.type === "note") return node;
      if (node.type === "file") {
        const { asset: _asset, ...stored } = node;
        return stored;
      }
      return { ...node, ...this.windowSize(node.sourceId, node.windowId) };
    });
  }

  private validateFileNodes(canvas: Canvas) {
    for (const node of canvas.nodes)
      if (node.type === "file" && !this.fileAssetForCanvas(node.assetId, canvas.id))
        throw new Error("File asset not found in this canvas");
  }

  addFileNode(asset: FileAsset, context: FileNodeContext): boolean {
    const canvasId = context.canvasId;
    if (!canvasId || canvasId === "overview" || !context.anchorId) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT body FROM documents WHERE kind='canvas' AND id=?").get(canvasId);
      if (!row) { this.db.exec("ROLLBACK"); return false; }
      const canvas = JSON.parse(String(row.body)) as Canvas;
      const anchor = canvas.nodes.find(node => isTerminalNode(node) && node.id === context.anchorId &&
        node.sourceId === context.sourceId && node.windowId === context.windowId);
      if (!anchor) { this.db.exec("ROLLBACK"); return false; }
      if (canvas.nodes.length >= 500) throw new Error("Canvas contains too many items");
      this.db.prepare("INSERT INTO canvas_files(id,canvas_id,filename,size,mime,preview,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(asset.id, canvasId, asset.filename, asset.size, asset.mime, asset.preview, asset.createdAt);
      const x = Math.min(1e7, anchor.x + this.windowSize(context.sourceId, context.windowId).width + 24);
      const occupied = canvas.nodes.filter(node => node.type === "file" &&
        Math.abs(node.x - x) < 1)
        .reduce((bottom, node) => Math.max(bottom, node.y + node.height), anchor.y);
      const dimensions = asset.preview === "pdf" ? { width: 420, height: 480 }
        : asset.preview === "file" ? { width: 320, height: 160 }
        : { width: 360, height: 280 };
      const node: FileNode = {
        id: randomUUID(), type: "file", assetId: asset.id,
        x,
        y: Math.min(1e7, occupied === anchor.y ? anchor.y : occupied + 16),
        ...dimensions,
      };
      canvas.nodes.push(node);
      this.db.prepare("UPDATE documents SET body=? WHERE kind='canvas' AND id=?")
        .run(JSON.stringify(canvas), canvasId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.changed();
    return true;
  }

  fileAsset(id: string): FileAsset | undefined {
    const row = this.db.prepare("SELECT id,filename,size,mime,preview,created_at FROM canvas_files WHERE id=?")
      .get(id);
    return row ? this.fileAssetFromRow(row) : undefined;
  }

  fileAssetForCanvas(id: string, canvasId: string): FileAsset | undefined {
    const row = this.db.prepare("SELECT id,filename,size,mime,preview,created_at FROM canvas_files WHERE id=? AND canvas_id=?")
      .get(id, canvasId);
    return row ? this.fileAssetFromRow(row) : undefined;
  }

  private fileAssetFromRow(row: Record<string, unknown>): FileAsset {
    return {
      id: String(row.id), filename: String(row.filename), size: Number(row.size),
      mime: String(row.mime), preview: String(row.preview) as FileAsset["preview"],
      createdAt: Number(row.created_at),
    };
  }

  fileAssetIds(): string[] {
    return this.db.prepare("SELECT id FROM canvas_files").all().map(row => String(row.id));
  }

  fileAssetReferenced(id: string): boolean {
    const canvases = this.db.prepare("SELECT body FROM documents WHERE kind='canvas'").all()
      .map(row => JSON.parse(String(row.body)) as Canvas);
    return canvases.some(canvas => canvas.nodes.some(node => node.type === "file" && node.assetId === id));
  }

  removeFileAssetIfUnreferenced(id: string): boolean {
    if (this.fileAssetReferenced(id)) return false;
    return this.db.prepare("DELETE FROM canvas_files WHERE id=?").run(id).changes > 0;
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
