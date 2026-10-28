import { createServer, type Server, type Socket } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import type { WebSocket } from "ws";
import type { Source } from "./state.ts";
import type { SourceResource } from "./providers.ts";

const MAX_HEADER = 16 * 1024;
const MAX_TRANSFERS_PER_SOURCE = 4;
const HANDSHAKE_TIMEOUT = 30_000;
const TICKET_TIMEOUT = 60_000;
const rejected = Buffer.from('{"ok":false}\n');

type DownloadState = "offered" | "accepted" | "transferring" | "completed" | "cancelled" | "failed";
type DownloadReason = "cancelled" | "not-started" | "timed-out" | "disconnected" | "invalid-transfer";
export interface DownloadContext { canvasId?: string; anchorId?: string }
interface Upload {
  write(chunk: Buffer): Promise<void>;
  complete(target: { canvasId: string; anchorId?: string; sourceId: string; windowId: string }): Promise<unknown>;
  abort(): Promise<void>;
}
export interface DownloadProgress {
  type: "download-progress";
  id: string;
  state: DownloadState;
  transferred: number;
  size: number;
  reason?: DownloadReason;
}

export interface PreparedOpenBridge {
  nativeSocket: string;
  remoteSocket?: string;
  cleanup(): Promise<void>;
}

export interface DownloadRecipient {
  socket: WebSocket;
  sessionId: string;
  isCurrent(): boolean;
}

export interface OpenDownloadOptions {
  registryDirectory?: string;
  socketDirectory?: string;
  idleTimeoutMs?: number;
  decisionTimeoutMs?: number;
  startTimeoutMs?: number;
  progressTimeoutMs?: number;
  createUpload?(metadata: { filename: string; size: number }): Promise<Upload>;
  prepare(source: Source, localSocket: string): Promise<PreparedOpenBridge>;
  publishRemote?(source: Source, record: RegistryRecord): Promise<() => Promise<void>>;
  installHelper?(source: Source): Promise<void>;
  resources(source: Source): Promise<SourceResource>;
  recipient(sourceId: string, windowId: string): Promise<DownloadRecipient | undefined>;
}

interface RegistryRecord {
  version: 1;
  provider: Source["type"];
  nativeSocket: string;
  socket: string;
  secret: string;
}

interface Bridge {
  source: Source;
  record: RegistryRecord;
  root: string;
  server: Server;
  sockets: Set<Socket>;
  cleanupProvider: () => Promise<void>;
  cleanupRegistry: () => Promise<void>;
  signature: string;
}

interface DownloadTicket {
  id: string;
  sessionId: string;
  socket: Socket;
  sourceId: string;
  windowId: string;
  filename: string;
  size: number;
  state: DownloadState;
  transferred: number;
  recipient: WebSocket;
  helperProgress: boolean;
  lastProgressAt: number;
  body?: Transform;
  upload?: Upload;
  context?: DownloadContext;
  claimed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  removeCloseListener: () => void;
}

function jsonLine(value: unknown) {
  return Buffer.from(JSON.stringify(value) + "\n");
}

function safeFilename(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 255) return;
  if (Buffer.from(value, "utf8").toString("utf8") !== value) return;
  if (value === "." || value === ".." || /[/\\\x00-\x1f\x7f]/u.test(value)) return;
  return value;
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/gu, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export class OpenDownloadService {
  private bridges = new Map<string, Bridge>();
  private preparing = new Map<string, { signature: string; promise: Promise<void> }>();
  private closing = new Map<string, Promise<void>>();
  private users = new Map<string, number>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private tickets = new Map<string, DownloadTicket>();
  private finished = new Map<string, { sessionId: string; progress: DownloadProgress; expires: number }>();
  private stopping = false;
  private readonly registryDirectory: string;
  private readonly socketDirectory: string;

  constructor(private readonly options: OpenDownloadOptions) {
    this.registryDirectory = options.registryDirectory ?? join(homedir(), ".local/state/canvas/bridges");
    this.socketDirectory = options.socketDirectory ?? tmpdir();
  }

  retainSource(sourceId: string): () => void {
    clearTimeout(this.idleTimers.get(sourceId));
    this.idleTimers.delete(sourceId);
    this.users.set(sourceId, (this.users.get(sourceId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = Math.max(0, (this.users.get(sourceId) || 0) - 1);
      if (count) { this.users.set(sourceId, count); return; }
      this.users.delete(sourceId);
      if (this.stopping) return;
      const timer = setTimeout(() => {
        this.idleTimers.delete(sourceId);
        if (!this.users.has(sourceId)) void this.closeSource(sourceId);
      }, this.options.idleTimeoutMs ?? 20_000);
      timer.unref();
      this.idleTimers.set(sourceId, timer);
    };
  }

  async ensureSource(source: Source): Promise<void> {
    if (this.stopping) throw new Error("File transfer service is stopping");
    const signature = JSON.stringify(source);
    const closing = this.closing.get(source.id);
    if (closing) { await closing; return await this.ensureSource(source); }
    const pending = this.preparing.get(source.id);
    if (pending) {
      if (pending.signature === signature) return await pending.promise;
      await pending.promise.catch(() => {});
      return await this.ensureSource(source);
    }
    const current = this.bridges.get(source.id);
    if (current?.signature === signature) return;
    const promise = this.startSource(source, signature);
    const task = { signature, promise };
    this.preparing.set(source.id, task);
    try { await promise; }
    finally { if (this.preparing.get(source.id) === task) this.preparing.delete(source.id); }
  }

  private async startSource(source: Source, signature: string): Promise<void> {
    const current = this.bridges.get(source.id);
    if (current) await this.closeBridge(current);
    if (this.options.installHelper) await this.options.installHelper(source);

    const root = await mkdtemp(join(this.socketDirectory, "cv-open-"));
    await chmod(root, 0o700);
    const localSocket = join(root, "bridge.sock");
    const secret = randomBytes(32).toString("base64url");
    const sockets = new Set<Socket>();
    let prepared: PreparedOpenBridge | undefined;
    let cleanupRegistry = async () => {};
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      this.accept(source, secret, socket);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(localSocket, resolve);
      });
      await chmod(localSocket, 0o600);
      prepared = await this.options.prepare(source, localSocket);
      const record: RegistryRecord = {
        version: 1,
        provider: source.type,
        nativeSocket: prepared.nativeSocket,
        socket: source.transport === "ssh" ? prepared.remoteSocket! : localSocket,
        secret,
      };
      if (!record.socket || !record.nativeSocket.startsWith("/"))
        throw new Error("Native terminal file bridge could not be identified");
      const bridge: Bridge = {
        source, record, root, server, sockets,
        cleanupProvider: prepared.cleanup,
        cleanupRegistry: async () => {},
        signature,
      };
      this.bridges.set(source.id, bridge);
      if (source.transport === "ssh") {
        if (!this.options.publishRemote) throw new Error("Remote file bridge registry is unavailable");
        bridge.cleanupRegistry = cleanupRegistry = await this.options.publishRemote(source, record);
      } else bridge.cleanupRegistry = cleanupRegistry = await this.publishLocal(record);
    } catch (error) {
      if (this.bridges.get(source.id)?.root === root) this.bridges.delete(source.id);
      await cleanupRegistry().catch(() => {});
      if (prepared) await prepared.cleanup().catch(() => {});
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  private async publishLocal(record: RegistryRecord): Promise<() => Promise<void>> {
    await mkdir(this.registryDirectory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.registryDirectory);
    const uid = typeof process.getuid === "function" ? process.getuid() : directory.uid;
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 || directory.uid !== uid)
      throw new Error("Canvas helper registry permissions are unsafe");
    const filename = join(this.registryDirectory, `${randomUUID()}.json`);
    const handle = await open(filename, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    return async () => {
      try {
        if ((await readFile(filename, "utf8")) === JSON.stringify(record)) await unlink(filename);
      } catch {}
    };
  }

  private accept(source: Source, secret: string, socket: Socket): void {
    socket.pause();
    socket.setTimeout(HANDSHAKE_TIMEOUT, () => socket.destroy());
    let bytes = Buffer.alloc(0);
    let headerReceived = false;
    socket.once("end", () => { if (!headerReceived && !socket.destroyed) socket.end(rejected); });
    const readHeader = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      const end = bytes.indexOf(0x0a);
      if (end < 0) {
        if (bytes.length > MAX_HEADER) socket.destroy();
        return;
      }
      headerReceived = true;
      socket.off("data", readHeader);
      socket.pause();
      const line = bytes.subarray(0, end);
      if (end + 1 !== bytes.length || end + 1 > MAX_HEADER) {
        socket.end(rejected);
        return;
      }
      void this.acceptHeader(source, secret, socket, line).catch(() => socket.destroy());
    };
    socket.on("data", readHeader);
    socket.resume();
  }

  private async acceptHeader(source: Source, secret: string, socket: Socket, line: Buffer): Promise<void> {
    let header: Record<string, unknown>;
    try { header = JSON.parse(line.toString("utf8")); }
    catch { socket.end(rejected); return; }
    if (!header || typeof header !== "object" || Array.isArray(header)) { socket.end(rejected); return; }
    const givenSecret = typeof header.secret === "string" ? Buffer.from(header.secret) : Buffer.alloc(0);
    const expectedSecret = Buffer.from(secret);
    if (givenSecret.length !== expectedSecret.length || !timingSafeEqual(givenSecret, expectedSecret)) {
      socket.end(rejected); return;
    }
    const filename = safeFilename(header.filename);
    if (header.version !== 1 || header.provider !== source.type || header.nativeSocket !== this.bridges.get(source.id)?.record.nativeSocket ||
        typeof header.paneId !== "string" || !header.paneId || header.paneId.length > 256 ||
        !Number.isSafeInteger(header.size) || (header.size as number) < 0 || !filename) {
      socket.end(rejected); return;
    }
    const bridge = this.bridges.get(source.id);
    if (!bridge || bridge.source !== source || bridge.sockets.size > MAX_TRANSFERS_PER_SOURCE) {
      socket.end(rejected); return;
    }
    let resources: SourceResource;
    try { resources = await this.options.resources(source); }
    catch { socket.end(rejected); return; }
    const matches = new Map(resources.spaces.flatMap((space) => space.windows
      .filter((window) => window.panes.some((pane) =>
        pane.id === header.paneId || (source.type === "tmux" && pane.id.endsWith(`:${header.paneId}`)),
      ))
      .map((window) => [window.id, { spaceId: space.id, windowId: window.id }] as const)));
    if (matches.size !== 1) { socket.end(rejected); return; }
    const target = matches.values().next().value as { spaceId: string; windowId: string } | undefined;
    if (!target) { socket.end(rejected); return; }
    const recipient = await this.options.recipient(source.id, target.windowId).catch(() => undefined);
    if (socket.destroyed) return;
    if (!recipient || !recipient.isCurrent() || recipient.socket.readyState !== 1 || !recipient.sessionId) {
      socket.end(jsonLine({ ok: false, reason: "not-attached" })); return;
    }
    const id = randomBytes(32).toString("base64url");
    const ticket: DownloadTicket = {
      id, sessionId: recipient.sessionId, socket, sourceId: source.id, windowId: target.windowId,
      filename, size: header.size as number, state: "offered", transferred: 0,
      recipient: recipient.socket, helperProgress: header.progress === true,
      lastProgressAt: 0, claimed: false, removeCloseListener: () => {},
    };
    const onClose = () => this.finish(ticket, "failed", "disconnected");
    recipient.socket.once("close", onClose);
    socket.once("close", onClose);
    ticket.removeCloseListener = () => {
      recipient.socket.off("close", onClose);
      socket.off("close", onClose);
    };
    this.tickets.set(id, ticket);
    socket.setTimeout(0);
    this.deadline(ticket, this.options.decisionTimeoutMs ?? TICKET_TIMEOUT, "not-started");
    try {
      recipient.socket.send(JSON.stringify({ type: "download", url: `/api/downloads/${id}`, id, filename,
        size: ticket.size, transferred: 0, state: "offered" }));
      if (ticket.helperProgress) socket.write(jsonLine({ state: "offered", transferred: 0, size: ticket.size }));
    } catch { this.finish(ticket, "failed", "disconnected"); }
  }

  private snapshot(ticket: DownloadTicket, reason?: DownloadReason): DownloadProgress {
    return { type: "download-progress", id: ticket.id, state: ticket.state,
      transferred: ticket.transferred, size: ticket.size, ...(reason ? { reason } : {}) };
  }

  private notify(ticket: DownloadTicket, reason?: DownloadReason): void {
    if (ticket.recipient.readyState === 1) {
      try { ticket.recipient.send(JSON.stringify(this.snapshot(ticket, reason))); } catch {}
    }
  }

  private deadline(ticket: DownloadTicket, milliseconds: number, reason: DownloadReason): void {
    clearTimeout(ticket.timer);
    ticket.timer = setTimeout(() => this.finish(ticket, "failed", reason), milliseconds);
    ticket.timer.unref();
  }

  private finish(ticket: DownloadTicket, state: "completed" | "cancelled" | "failed", reason?: DownloadReason): void {
    if (this.tickets.get(ticket.id) !== ticket) return;
    this.tickets.delete(ticket.id);
    ticket.state = state;
    clearTimeout(ticket.timer);
    ticket.removeCloseListener();
    const now = Date.now();
    for (const [id, result] of this.finished) if (result.expires <= now) this.finished.delete(id);
    this.finished.set(ticket.id, { sessionId: ticket.sessionId, progress: this.snapshot(ticket, reason), expires: now + 60_000 });
    while (this.finished.size > 256) this.finished.delete(this.finished.keys().next().value!);
    this.notify(ticket, reason);
    const socket = ticket.socket;
    if (!socket.destroyed && !socket.writableEnded) {
      socket.end(jsonLine({ ok: state === "completed", state, transferred: ticket.transferred,
        size: ticket.size, ...(reason ? { reason } : {}) }));
    }
    if (state !== "completed") {
      ticket.body?.destroy(new Error(`File transfer ${reason || "failed"}`));
      void ticket.upload?.abort().catch(() => {});
      // Deliver the rejection even while the peer is blocked sending, then
      // release a peer which does not read it. Never leave a paused socket open.
      const destroy = setTimeout(() => socket.destroy(), 500);
      destroy.unref();
      socket.once("close", () => clearTimeout(destroy));
    }
  }

  private cancelTicket(id: string): void {
    const ticket = this.tickets.get(id);
    if (ticket) this.finish(ticket, "cancelled", "cancelled");
  }

  action(ticketId: string, sessionId: string, action: "accept" | "cancel", context?: DownloadContext): DownloadProgress | undefined {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      const result = this.finished.get(ticketId);
      return result && result.sessionId === sessionId && result.expires > Date.now() ? result.progress : undefined;
    }
    if (ticket.sessionId !== sessionId) return;
    if (action === "cancel") this.finish(ticket, "cancelled", "cancelled");
    else if (ticket.state === "offered") {
      ticket.context = context;
      ticket.state = "accepted";
      this.deadline(ticket, this.options.startTimeoutMs ?? 15_000, "not-started");
      this.notify(ticket);
      if (ticket.helperProgress) ticket.socket.write(jsonLine({ state: "accepted", transferred: 0, size: ticket.size }));
    }
    return this.snapshot(ticket, action === "cancel" ? "cancelled" : undefined);
  }

  async open(ticketId: string, sessionId: string, context?: DownloadContext): Promise<{ body: Readable; size: number; filename: string; headers: Record<string, string> } | undefined> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.sessionId !== sessionId || ticket.claimed || ticket.socket.destroyed) return;
    // A native link can reach HTTP before its asynchronous accept notification.
    if (ticket.state === "offered") ticket.context = context;
    ticket.claimed = true;
    ticket.state = "accepted";
    this.deadline(ticket, this.options.startTimeoutMs ?? 15_000, "not-started");
    if (ticket.context?.canvasId && ticket.context.canvasId !== "overview" && this.options.createUpload) {
      try {
        ticket.upload = await this.options.createUpload({ filename: ticket.filename, size: ticket.size });
        if (this.tickets.get(ticket.id) !== ticket) { await ticket.upload.abort(); return; }
      } catch { this.finish(ticket, "failed", "invalid-transfer"); return; }
    }
    const socket = ticket.socket;
    ticket.state = "transferring";
    this.deadline(ticket, this.options.progressTimeoutMs ?? 60_000, "timed-out");
    this.notify(ticket);
    let received = 0;
    const body = ticket.body = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length;
        if (received > ticket.size) { callback(new Error("File transfer exceeded declared length")); return; }
        const advance = () => {
          if (this.tickets.get(ticket.id) !== ticket) { callback(new Error("File transfer cancelled")); return; }
          ticket.transferred = received;
          this.deadline(ticket, this.options.progressTimeoutMs ?? 60_000, "timed-out");
          const now = Date.now();
          if (now - ticket.lastProgressAt >= 100) {
            ticket.lastProgressAt = now;
            this.notify(ticket);
            if (ticket.helperProgress && !socket.destroyed) socket.write(jsonLine({ state: "transferring", transferred: received, size: ticket.size }));
          }
          callback(null, chunk);
        };
        if (ticket.upload) void ticket.upload.write(chunk).then(advance, error => callback(error));
        else advance();
      },
      flush: callback => {
        if (received !== ticket.size) { callback(new Error("File transfer ended before declared length")); return; }
        const complete = async () => {
          if (ticket.upload && ticket.context?.canvasId) await ticket.upload.complete({ ...ticket.context,
            canvasId: ticket.context.canvasId, sourceId: ticket.sourceId, windowId: ticket.windowId });
          if (this.tickets.get(ticket.id) !== ticket) { callback(new Error("File transfer cancelled")); return; }
          this.finish(ticket, "completed");
          callback();
        };
        void complete().catch(error => callback(error));
      },
    });
    const onError = (error: Error) => body.destroy(error);
    const onClose = () => { if (!socket.readableEnded) body.destroy(new Error("File transfer connection closed")); };
    socket.once("error", onError);
    socket.once("close", onClose);
    body.once("error", (error: Error & { code?: string }) => {
      if (error.name === "AbortError" || error.code === "ABORT_ERR") this.finish(ticket, "cancelled", "cancelled");
      else this.finish(ticket, "failed", "invalid-transfer");
    });
    body.once("close", () => {
      socket.off("error", onError);
      socket.off("close", onClose);
      if (!body.readableEnded) this.finish(ticket, "cancelled", "cancelled");
    });
    // Acceptance acknowledges actual HTTP consumption, never just an offer.
    socket.write(jsonLine({ ok: true, state: "transferring", transferred: 0, size: ticket.size }));
    socket.pipe(body);
    return { body, size: ticket.size, filename: ticket.filename, headers: {
      "Cache-Control": "no-store", "Content-Disposition": contentDisposition(ticket.filename),
      "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff",
    } };
  }

  async closeSource(sourceId: string): Promise<void> {
    clearTimeout(this.idleTimers.get(sourceId));
    this.idleTimers.delete(sourceId);
    const existing = this.closing.get(sourceId);
    if (existing) return await existing;
    const operation = (async () => {
      await this.preparing.get(sourceId)?.promise.catch(() => {});
      const bridge = this.bridges.get(sourceId);
      if (bridge) await this.closeBridge(bridge);
    })();
    this.closing.set(sourceId, operation);
    try { await operation; }
    finally { if (this.closing.get(sourceId) === operation) this.closing.delete(sourceId); }
  }

  private async closeBridge(bridge: Bridge): Promise<void> {
    const sourceId = bridge.source.id;
    if (this.bridges.get(sourceId) === bridge) this.bridges.delete(sourceId);
    for (const [id, ticket] of this.tickets) if (ticket.sourceId === sourceId) this.cancelTicket(id);
    for (const socket of bridge.sockets) socket.destroy();
    await bridge.cleanupRegistry().catch(() => {});
    await bridge.cleanupProvider().catch(() => {});
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    await rm(bridge.root, { recursive: true, force: true });
  }

  async closeAll(): Promise<void> {
    this.stopping = true;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.users.clear();
    await Promise.all([...this.preparing.values()].map(({ promise }) => promise.catch(() => {})));
    await Promise.all([...this.bridges.keys()].map((id) => this.closeSource(id)));
    for (const id of this.tickets.keys()) this.cancelTicket(id);
  }
}
