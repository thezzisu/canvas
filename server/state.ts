import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
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
const itemSchema = z
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
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS documents (kind TEXT, id TEXT, body TEXT, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER);",
    );
  }
  list<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT body FROM documents WHERE kind=? ORDER BY rowid")
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
    return result;
  }
  remove(kind: string, id: string) {
    this.db
      .prepare("DELETE FROM documents WHERE kind=? AND id=?")
      .run(kind, id);
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
  }
  close() {
    this.db.close();
  }
}
