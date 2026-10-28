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
const accepted = Buffer.from('{"ok":true}\n');
const rejected = Buffer.from('{"ok":false}\n');

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
  filename: string;
  size: number;
  timer: ReturnType<typeof setTimeout>;
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
    if (!recipient || !recipient.isCurrent() || recipient.socket.readyState !== 1 || !recipient.sessionId) { socket.end(rejected); return; }
    const ticket = randomBytes(32).toString("base64url");
    const pending: DownloadTicket = {
      id: ticket, sessionId: recipient.sessionId, socket, sourceId: source.id,
      filename, size: header.size as number,
      timer: setTimeout(() => this.cancelTicket(ticket), TICKET_TIMEOUT),
      removeCloseListener: () => {},
    };
    pending.timer.unref();
    const onClose = () => { this.cancelTicket(ticket); socket.destroy(); };
    const onHelperClose = () => this.cancelTicket(ticket);
    recipient.socket.once("close", onClose);
    socket.once("close", onHelperClose);
    pending.removeCloseListener = () => {
      recipient.socket.off("close", onClose);
      socket.off("close", onHelperClose);
    };
    this.tickets.set(ticket, pending);
    socket.setTimeout(0);
    socket.pause();
    try {
      recipient.socket.send(JSON.stringify({ type: "download", url: `/api/downloads/${ticket}`, filename }));
      socket.write(accepted);
    } catch {
      this.cancelTicket(ticket);
    }
  }

  private cancelTicket(id: string): void {
    const ticket = this.tickets.get(id);
    if (!ticket) return;
    this.tickets.delete(id);
    clearTimeout(ticket.timer);
    ticket.removeCloseListener();
    ticket.socket.destroy();
  }

  open(ticketId: string, sessionId: string): { body: Readable; size: number; filename: string; headers: Record<string, string> } | undefined {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.sessionId !== sessionId || ticket.socket.destroyed) return;
    this.tickets.delete(ticketId);
    clearTimeout(ticket.timer);
    const socket = ticket.socket;
    socket.setTimeout(0);
    const body = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > ticket.size) callback(new Error("File transfer exceeded declared length"));
        else callback(null, chunk);
      },
      flush(callback) {
        if (received !== ticket.size) { callback(new Error("File transfer ended before declared length")); return; }
        socket.end(jsonLine({ ok: true }));
        callback();
      },
    });
    let received = 0;
    const onError = (error: Error) => body.destroy(error);
    const onClose = () => {
      if (!socket.readableEnded) body.destroy(new Error("File transfer connection closed"));
    };
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.pipe(body);
    body.once("close", () => {
      ticket.removeCloseListener();
      socket.off("error", onError);
      socket.off("close", onClose);
      if (!body.readableEnded) socket.destroy();
    });
    body.once("error", () => socket.destroy());
    return {
      body,
      size: ticket.size,
      filename: ticket.filename,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": contentDisposition(ticket.filename),
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    };
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
