import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { Source } from "./state.ts";
import type { TerminalManager } from "./terminals.ts";
import { listResources, shellQuote } from "./providers.ts";
import { validateInboxFile, writeInboxFile, removeInboxFiles, type InboxFile } from "./inbox.ts";

const beginSchema = z.object({
  id: z.string().min(1).max(100),
  files: z.array(z.object({ name: z.string(), size: z.number() }).strict()).min(1).max(64),
}).strict();

interface Batch {
  key: string; id: string; source: Source; windowId: string; session: string; socket: WebSocket;
  files: InboxFile[]; tokens: string[]; paths: string[]; next: number; busy: boolean;
  completedBytes: number; transferred: number; total: number;
  controller: AbortController; timer?: ReturnType<typeof setTimeout>; lastProgress: number;
  paste(text: string, signal: AbortSignal): Promise<void>;
}

export class UploadService {
  private batches = new Map<string, Batch>();
  private tokens = new Map<string, { batch: Batch; index: number }>();
  private closing = new Set<Promise<void>>();
  private sourceGenerations = new Map<string, number>();
  private stopped = false;
  constructor(private readonly terminals: TerminalManager, private readonly options = {
    write: writeInboxFile, remove: removeInboxFiles, resources: listResources,
  }) {}

  private send(socket: WebSocket, value: unknown) {
    if (socket.readyState === 1) socket.send(JSON.stringify(value));
  }
  private progress(batch: Batch, state: "uploading" | "completed" | "cancelled" | "failed", error?: string, failedFile?: string) {
    this.send(batch.socket, { type: "upload-progress", id: batch.id, state,
      transferred: batch.transferred, total: batch.total, ...(error ? { error } : {}),
      ...(failedFile ? { failedFile } : {}),
      ...(state === "completed" ? { paths: batch.paths } : {}) });
  }
  private deadline(batch: Batch) {
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => this.fail(batch, "上传超时", false, batch.files[batch.next]?.name), 60_000);
    batch.timer.unref();
  }
  async begin(source: Source, windowId: string, socket: WebSocket, session: string, input: unknown) {
    let id = "";
    try {
      const request = beginSchema.parse(input); id = request.id;
      for (const file of request.files) validateInboxFile(file);
      const total = request.files.reduce((sum, file) => sum + file.size, 0);
      if (!Number.isSafeInteger(total)) throw new Error("文件大小无效");
      const key = `${source.id}/${windowId}`;
      if (this.stopped || this.batches.has(key)) throw new Error("窗口已有上传任务");
      const generation = this.sourceGenerations.get(source.id) || 0;
      const paste = await this.terminals.captureFilePaste(source.id, windowId, socket);
      if (this.stopped || (this.sourceGenerations.get(source.id) || 0) !== generation) throw new Error("连接已关闭");
      if (!paste || socket.readyState !== 1) throw new Error("请先连接目标窗口");
      if (this.batches.has(key)) throw new Error("窗口已有上传任务");
      const batch: Batch = { key, id, source, windowId, socket, session, files: request.files,
        tokens: request.files.map(() => randomBytes(32).toString("base64url")), paths: [], next: 0,
        busy: false, completedBytes: 0, transferred: 0, total, controller: new AbortController(),
        lastProgress: 0, paste };
      this.batches.set(key, batch);
      batch.tokens.forEach((token, index) => this.tokens.set(token, { batch, index }));
      this.deadline(batch);
      this.send(socket, { type: "upload-ready", id, urls: batch.tokens.map(token => `/api/uploads/${token}`) });
      this.progress(batch, "uploading");
    } catch (error) {
      if (!id && input && typeof input === "object" && "id" in input && typeof input.id === "string") id = input.id.slice(0, 100);
      this.send(socket, { type: "upload-progress", id, state: "failed", transferred: 0, total: 0,
        error: error instanceof z.ZodError ? "上传参数无效" : error instanceof Error ? error.message : "无法开始上传" });
    }
  }
  private removeBatch(batch: Batch) {
    clearTimeout(batch.timer);
    for (const token of batch.tokens) this.tokens.delete(token);
    if (this.batches.get(batch.key) === batch) this.batches.delete(batch.key);
  }
  private cleanup(source: Source, paths: string[]) {
    const cleaning = this.options.remove(source, paths).catch(() => {}).finally(() => this.closing.delete(cleaning));
    this.closing.add(cleaning);
  }
  private fail(batch: Batch, error: string, cancelled = false, failedFile?: string) {
    if (this.batches.get(batch.key) !== batch) return;
    this.removeBatch(batch);
    batch.controller.abort();
    this.progress(batch, cancelled ? "cancelled" : "failed", error, failedFile);
    // A failed later file never pastes a partial batch or deletes earlier successes.
    if (cancelled) this.cleanup(batch.source, [...batch.paths]);
  }
  cancel(socket: WebSocket, id?: string) {
    for (const batch of this.batches.values())
      if (batch.socket === socket && (id === undefined || batch.id === id)) this.fail(batch, "上传已取消", true);
  }
  disconnected(socket: WebSocket) {
    for (const batch of this.batches.values())
      if (batch.socket === socket) this.fail(batch, "上传连接中断", false, batch.files[batch.next]?.name);
  }
  closeSource(sourceId: string) {
    this.sourceGenerations.set(sourceId, (this.sourceGenerations.get(sourceId) || 0) + 1);
    for (const batch of this.batches.values()) if (batch.source.id === sourceId) this.fail(batch, "连接已移除");
  }
  async receive(token: string, session: string, request: Request): Promise<204 | 404 | 409> {
    const entry = this.tokens.get(token);
    if (!entry || entry.batch.session !== session) return 404;
    const { batch, index } = entry;
    if (batch.busy || index !== batch.next) return 409;
    batch.busy = true;
    this.tokens.delete(token);
    const reader = request.body?.getReader();
    const interrupted = () => this.fail(batch, "上传连接中断", false, batch.files[index]!.name);
    request.signal.addEventListener("abort", interrupted, { once: true });
    const abortReader = () => { void reader?.cancel().catch(() => {}); };
    batch.controller.signal.addEventListener("abort", abortReader, { once: true });
    const chunks = async function* () {
      if (!reader) return;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        yield chunk.value;
      }
    };
    let written = false;
    try {
      if (request.signal.aborted) throw new Error("上传已取消");
      const path = await this.options.write(batch.source, batch.files[index]!, chunks(), batch.controller.signal, received => {
        if (this.batches.get(batch.key) !== batch || batch.controller.signal.aborted) return;
        batch.transferred = batch.completedBytes + received;
        this.deadline(batch);
        if (Date.now() - batch.lastProgress > 100) { batch.lastProgress = Date.now(); this.progress(batch, "uploading"); }
      });
      written = true;
      if (this.batches.get(batch.key) !== batch) { this.cleanup(batch.source, [path]); return 409; }
      batch.paths.push(path);
      batch.next++; batch.completedBytes += batch.files[index]!.size; batch.transferred = batch.completedBytes;
      batch.busy = false;
      this.deadline(batch);
      if (batch.next === batch.files.length) {
        const native = await this.options.resources(batch.source);
        if (!native.spaces.some(space => space.windows.some(window => window.id === batch.windowId))) throw new Error("目标窗口已关闭");
        if (this.batches.get(batch.key) !== batch) return 409;
        await batch.paste(batch.paths.map(shellQuote).join(" "), batch.controller.signal);
        this.removeBatch(batch);
        this.progress(batch, "completed");
      } else this.progress(batch, "uploading");
      return 204;
    } catch (error) {
      this.fail(batch, error instanceof Error ? error.message : "文件上传失败", false, written ? undefined : batch.files[index]!.name);
      return 409;
    } finally {
      request.signal.removeEventListener("abort", interrupted);
      batch.controller.signal.removeEventListener("abort", abortReader);
      await reader?.cancel().catch(() => {});
    }
  }
  async closeAll() {
    this.stopped = true;
    for (const batch of this.batches.values()) this.fail(batch, "连接已关闭");
    await Promise.all([...this.closing]);
  }
}
