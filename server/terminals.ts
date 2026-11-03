import { CompletionReads } from './completion-reads.ts';
import type { PaneAction, PaneContext, PanePoint } from '../shared/pane-context.ts';
import { sameCompletion, type CompletionToken } from '../shared/completion.ts';
import headless from "@xterm/headless";
import { terminalUnicodeAddon } from "../shared/terminal-unicode.ts";
import serialize from "@xterm/addon-serialize";
import type { WebSocket } from "ws";
import { sourceConnectionKey, type Source } from "./state.ts";
import { openTerminal } from "./providers.ts";
import { GeometryController, type Size } from "./geometry.ts";
import { HERDR_MOUSE_ENCODING, type HerdrClientTransport } from "./herdr/client.ts";
import type { WindowMetadata } from "../shared/window-metadata.ts";
import { randomUUID } from "node:crypto";
import type { CanvasNotification } from "../shared/notification.ts";
const { Terminal } = headless;
const { SerializeAddon } = serialize;
export type TerminalTarget = {
  sourceId: string;
  spaceId: string;
  windowId: string;
};
const clamp = (n: unknown, min: number, max: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback;
function json(ws: WebSocket, data: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}
class LiveTerminal {
  emulator: InstanceType<typeof Terminal>;
  serializer: InstanceType<typeof SerializeAddon>;
  clients = new Set<WebSocket>();
  private rendered = new Set<WebSocket>();
  private hidden = new Set<WebSocket>();
  private focused = new Set<WebSocket>();
  private maximized?: { owner: WebSocket; token: string; lease: number; releasing?: boolean };
  private presentationRevision = 0;
  private focusedPaneId?: string;
  private metadata?: WindowMetadata;
  private rawMetadata?: WindowMetadata;
  private frame?: WindowMetadata;
  private sentFrames = new WeakMap<WebSocket, WindowMetadata>();
  private readGenerations = new WeakMap<WebSocket, number>();
  private pendingFences = new WeakMap<WebSocket, number>();
  private readSubscription?: { dispose(): unknown };
  private cursorVisible = true;
  private cursorShape = 0;
  controller?: WebSocket;
  private downloadController?: WebSocket;
  idle?: ReturnType<typeof setTimeout>;
  queue: Promise<void> = Promise.resolve();
  pendingBytes = 0;
  paused = false;
  geometry: GeometryController<WebSocket>;
  closing?: Promise<void>;
  closed = false;
  cols: number;
  rows: number;
  constructor(
    readonly key: string,
    readonly sourceId: string,
    readonly connectionKey: string,
    readonly spaceId: string,
    readonly handle: Awaited<ReturnType<typeof openTerminal>>,
    cols: number,
    rows: number,
    readonly onClose: () => void,
    readonly proc: HerdrClientTransport,
    readonly source: Source,
    readonly reads?: CompletionReads,
    readonly onFocusedRemove?: () => void,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.emulator = new Terminal({
      cols,
      rows,
      scrollback: 2000,
      allowProposedApi: true,
    });
    this.emulator.loadAddon(terminalUnicodeAddon());
    this.serializer = new SerializeAddon();
    this.emulator.loadAddon(this.serializer);
    // SerializeAddon omits cursor appearance. Observe it on the same parser lane
    // as screen writes so resumed snapshots retain the completed frame's state.
    for (const final of ['h', 'l']) this.emulator.parser.registerCsiHandler({ prefix: '?', final }, params => {
      if (params.includes(25)) this.cursorVisible = final === 'h';
      return false;
    });
    this.emulator.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, params => {
      if (typeof params[0] === 'number' && params[0] >= 0 && params[0] <= 6) this.cursorShape = params[0];
      return false;
    });
    this.geometry = new GeometryController(
      { cols, rows },
      (size) => this.adoptGeometry(size),
      (reason) => {
        for (const ws of this.clients)
          json(ws, {
            ...this.geometry.state(ws),
            ...(reason ? { reason } : {}),
          });
      },
      () => { void this.close(); },
    );
    this.proc.onPaneFocus((paneId) => {
      if (this.closed || this.focusedPaneId === paneId) return;
      this.focusedPaneId = paneId;
      for (const ws of this.clients) json(ws, { type: "pane-focus", paneId });
    });
    this.readSubscription = reads?.onRead(sourceId => { if (sourceId === this.sourceId) this.publishMetadata(); });
    this.proc.onMetadata(metadata => {
      if (this.closed) return;
      this.rawMetadata = metadata;
      this.publishMetadata();
    });
    this.proc.onFrame(metadata => {
      const recipients = [...this.clients].map(ws => ({ ws, generation: this.readGenerations.get(ws) || 0, blocked: this.pendingFences.has(ws) }));
      this.queue = this.queue.then(() => {
        if (this.closed) return;
        this.frame = metadata;
        for (const { ws, generation, blocked } of recipients) if (!blocked && generation === (this.readGenerations.get(ws) || 0) && this.canRender(ws)) this.publishFrame(ws);
      }).catch(() => { void this.close(); });
    });
    this.proc.onData((data) => {
      if (this.closed) return;
      const bytes = Buffer.byteLength(data);
      this.pendingBytes += bytes;
      if (this.pendingBytes > 256 * 1024 && !this.paused) {
        this.paused = true;
        this.proc.pause();
      }
      this.queue = this.queue
        .then(async () => {
          try {
            if (this.closed) return;
            await new Promise<void>((resolve) =>
              this.emulator.write(data, () => {
                for (const ws of this.clients) {
                  if (!this.canRender(ws)) continue;
                  if (ws.bufferedAmount > 2 * 1024 * 1024) {
                    ws.close(1013, "Terminal output is too fast; reconnect");
                    continue;
                  }
                  if (ws.readyState === 1) ws.send(Buffer.from(data, "utf8"));
                }
                resolve();
              }),
            );
          } finally {
            this.pendingBytes -= bytes;
            if (this.paused && this.pendingBytes < 128 * 1024 && !this.closed) {
              this.paused = false;
              this.proc.resume();
            }
          }
        })
        .catch(() => {
          void this.close();
        });
    });
    this.proc.onExit(event => void this.close(event.reason));
  }
  private publishMetadata() {
    if (this.closed || !this.rawMetadata) return;
    this.metadata = this.reads?.project(this.source, this.rawMetadata) || this.rawMetadata;
    for (const ws of this.clients) json(ws, { type: 'metadata', window: this.metadata });
  }
  private publishFrame(ws: WebSocket) {
    if (!this.frame || this.pendingFences.has(ws)) return;
    const frame = this.reads?.project(this.source, this.frame) || this.frame;
    this.sentFrames.set(ws, frame);
    json(ws, { type: 'completion-frame', generation: this.readGenerations.get(ws) || 0, focusedPaneId: frame.panes.find(pane => pane.active)?.id, layout: frame.layout,
      panes: frame.panes.map(pane => ({ id: pane.id, ...(pane.completion ? { completion: pane.completion } : {}) })) });
  }
  private canRender(ws: WebSocket) {
    return !this.hidden.has(ws) && this.rendered.has(ws) &&
      (!this.maximized || !this.maximized.releasing && this.maximized.owner === ws);
  }
  downloadRecipient(): WebSocket | undefined {
    const ws = this.downloadController;
    return ws && ws === this.controller && ws.readyState === 1 && this.clients.has(ws) &&
      (!this.maximized || this.maximized.owner === ws) ? ws : undefined;
  }
  captureFilePaste(ws: WebSocket): ((texts: readonly string[], signal: AbortSignal) => Promise<void>) | undefined {
    if (this.closed || this.controller !== ws || !this.clients.has(ws) ||
        ws.readyState !== 1 || (this.maximized && this.maximized.owner !== ws)) return;
    // A file drop authorizes this window at its start. Canvas navigation and
    // native pane selection do not redirect its eventual paste.
    return async (texts: readonly string[], signal: AbortSignal) => {
      await this.queue;
      signal.throwIfAborted();
      if (this.closed) throw new Error("目标窗口已关闭");
      // Each file is one paste event for agents; spaces outside the brackets
      // keep ordinary shell arguments separate. Commit the completed batch once.
      this.proc.write(texts.map(text => this.emulator.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text).join(' '));
    };
  }
  private presentation(ws: WebSocket) {
    json(ws, {
      type: "presentation",
      maximized: !!this.maximized,
      owned: this.maximized?.owner === ws,
      ...(this.maximized ? { token: this.maximized.token, lease: this.maximized.lease } : {}),
    });
  }
  private snapshot(ws: WebSocket) {
    if (this.closed || !this.clients.has(ws) || ws.readyState !== 1) return;
    json(ws, { type: "pane-focus", paneId: this.focusedPaneId });
    if (this.hidden.has(ws) || this.maximized && (this.maximized.releasing || this.maximized.owner !== ws)) {
      this.rendered.delete(ws);
      this.presentation(ws);
      return;
    }
    // The caller runs in the same queue as headless writes. Reset, geometry,
    // serialized state and live output therefore form one ordered stream.
    json(ws, { type: "reset" });
    json(ws, { type: "resize", cols: this.cols, rows: this.rows });
    // SerializeAddon restores tracking but omits its wire encoding.
    const cursor = this.emulator.buffer.active;
    // Absolute positioning also avoids SerializeAddon's last-column relative
    // cursor offset when the native projection has disabled wrapping.
    ws.send(Buffer.from(this.serializer.serialize() + HERDR_MOUSE_ENCODING +
      `\x1b[${cursor.cursorY + 1};${cursor.cursorX + 1}H\x1b[${this.cursorShape} q\x1b[?25${this.cursorVisible ? 'h' : 'l'}`, "utf8"));
    this.rendered.add(ws);
    this.sentFrames.delete(ws); this.publishFrame(ws);
    this.presentation(ws);
  }
  private resume() {
    const revision = this.presentationRevision;
    this.queue = this.queue.then(() => {
      if (revision !== this.presentationRevision) return;
      for (const ws of this.clients)
        if (!this.rendered.has(ws)) this.snapshot(ws);
    }).catch(() => { void this.close(); });
  }
  private maximize(ws: WebSocket, token: string) {
    this.presentationRevision++;
    this.maximized = { owner: ws, token, lease: this.presentationRevision };
    this.controller = ws;
    this.downloadController = ws;
    for (const client of this.clients) {
      if (client !== ws) {
        this.rendered.delete(client);
        this.presentation(client);
      } else if (this.rendered.has(client)) this.presentation(client);
    }
    this.status();
    this.resume();
  }
  private async releaseMaximized(ws: WebSocket, token?: string) {
    const current = this.maximized;
    if (!current || current.releasing || current.owner !== ws || (token !== undefined && token !== current.token)) return;
    current.releasing = true;
    this.presentationRevision++;
    // Keep every view paused until viewport restoration completes.
    // A new owner can take over while it is queued; snapshots
    // re-check the current owner and never release a newer request.
    this.rendered.clear();
    await this.geometry.end(ws, current.token);
    if (this.maximized !== current) return;
    this.maximized = undefined;
    this.resume();
    this.status();
  }
  async join(ws: WebSocket) {
    clearTimeout(this.idle);
    this.queue = this.queue.then(() => {
      if (this.closed || ws.readyState !== 1) return;
      this.clients.add(ws);
      if (!this.controller) this.controller = ws;
      if (this.metadata) json(ws, { type: "metadata", window: this.metadata });
      this.snapshot(ws);
      this.status();
      json(ws, this.geometry.state(ws));
    });
    await this.queue;
    ws.on("message", (data, isBinary) => {
      if (this.closed || ws.readyState !== 1 || !this.clients.has(ws)) return;
      if (isBinary || Buffer.byteLength(data.toString()) > 128 * 1024) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "view-visible" && typeof msg.visible === "boolean") {
          if (msg.visible && msg.focused === true) this.focused.add(ws);
          else if (!msg.visible || msg.focused === false) this.focused.delete(ws);
          if (msg.visible === !this.hidden.has(ws)) return;
          if (msg.visible) { this.hidden.delete(ws); this.resume(); }
          else { this.hidden.add(ws); this.rendered.delete(ws); }
          return;
        }
        if (msg.type === 'completion-fence') {
          if (!Number.isSafeInteger(msg.generation) || msg.generation <= (this.readGenerations.get(ws) || 0)) return;
          this.readGenerations.set(ws, msg.generation); this.pendingFences.set(ws, msg.generation); this.sentFrames.delete(ws);
          void this.proc.completionFence().then(frame => {
            if (!frame || this.closed || !this.clients.has(ws) || this.pendingFences.get(ws) !== msg.generation) return;
            this.queue = this.queue.then(() => {
              if (this.closed || this.pendingFences.get(ws) !== msg.generation) return;
              this.pendingFences.delete(ws); this.frame = frame;
              if (this.canRender(ws)) this.publishFrame(ws);
            });
          }).catch(() => {});
          return;
        }
        if (msg.type === 'completion-read') {
          const frame = this.sentFrames.get(ws);
          const pane = frame?.panes.find(pane => pane.id === msg.paneId && pane.active);
          const completion: CompletionToken = { bootId: msg.bootId, sequence: msg.sequence };
          if (Number.isSafeInteger(msg.generation) && msg.generation === (this.readGenerations.get(ws) || 0) && !this.pendingFences.has(ws) &&
              this.canRender(ws) && pane && pane.id === this.focusedPaneId && pane.completion && sameCompletion(pane.completion, completion)) {
            if (this.proc.acknowledgeCompletion) void this.proc.acknowledgeCompletion(pane.id, completion).catch(() => {});
            else this.reads?.acknowledge(this.source, frame!.id, pane.id, completion);
          }
          return;
        }
        if (msg.type === "focus") {
          if (this.maximized && this.maximized.owner !== ws) return;
          this.controller = ws;
          this.downloadController = ws;
          this.status();
          return;
        }
        const size = {
          // xterm needs two columns for wide characters; one row is valid.
          cols: clamp(msg.cols, 2, 500, this.cols),
          rows: clamp(msg.rows, 1, 200, this.rows),
        };
        if (
          msg.type === "focus-resize-begin" &&
          typeof msg.token === "string" &&
          msg.token.length <= 100
        ) {
          this.maximize(ws, msg.token);
          this.geometry.begin(ws, msg.token, size);
          return;
        }
        if (
          msg.type === "focus-resize-update" &&
          typeof msg.token === "string"
        ) {
          if (this.maximized?.owner !== ws || this.maximized.token !== msg.token) return;
          this.geometry.update(ws, msg.token, size);
          return;
        }
        if (msg.type === "focus-resize-end" && typeof msg.token === "string") {
          void this.releaseMaximized(ws, msg.token);
          return;
        }
        if (msg.type === "presentation-cancel" && typeof msg.token === "string" && Number.isSafeInteger(msg.lease)) {
          const current = this.maximized;
          if (current && current.token === msg.token && current.lease === msg.lease) void this.releaseMaximized(current.owner, current.token);
          else this.presentation(ws);
          return;
        }
        if (this.controller !== ws) return;
        if (this.maximized && this.maximized.owner !== ws) return;
        if (
          msg.type === "input" &&
          typeof msg.data === "string" &&
          msg.data.length <= 64 * 1024 &&
          (msg.encoding === undefined || msg.encoding === "binary")
        ) {
          // Outer window focus reports cannot change the native pane or pixels.
          if (msg.data !== '\x1b[I' && msg.data !== '\x1b[O') this.sentFrames.delete(ws);
          this.proc.write(
            msg.encoding === "binary"
              ? Buffer.from(msg.data, "latin1")
              : msg.data,
          );
        }
        if (msg.type === "resize") this.geometry.persistent(size);
      } catch {
        /* Malformed messages cannot become terminal commands. */
      }
    });
    ws.once("close", () => {
      this.clients.delete(ws);
      this.hidden.delete(ws);
      this.focused.delete(ws);
      if (this.downloadController === ws) this.downloadController = undefined;
      this.rendered.delete(ws);
      if (this.closed) return;
      if (this.maximized?.owner === ws) void this.releaseMaximized(ws);
      else void this.geometry.end(ws);
      if (this.controller === ws)
        this.controller = this.clients.values().next().value;
      this.status();
      if (!this.clients.size) {
        this.idle = setTimeout(() => void this.close(), 20_000);
        this.idle.unref();
      }
    });
  }
  adoptGeometry(size: Size) {
    if (this.cols === size.cols && this.rows === size.rows) return;
    this.proc.resize(size.cols, size.rows);
    this.cols = size.cols;
    this.rows = size.rows;
    this.emulator.resize(size.cols, size.rows);
    for (const ws of this.clients)
      if (this.canRender(ws)) json(ws, { type: "resize", cols: size.cols, rows: size.rows });
  }
  status() {
    for (const ws of this.clients)
      json(ws, {
        type: "status",
        status: "connected",
        readOnly: this.controller !== ws || (!!this.maximized && this.maximized.owner !== ws),
      });
  }
  close(reason?: 'removed'): Promise<void> {
    if (this.closing) return this.closing;
    const focused = reason === 'removed' && [...this.focused].some(ws => ws.readyState === 1 && this.clients.has(ws) && this.canRender(ws));
    this.closed = true;
    this.readSubscription?.dispose();
    if (reason === 'removed') this.reads?.removeWindow(this.source, this.key.slice(this.sourceId.length + 1));
    if (focused) this.onFocusedRemove?.();
    clearTimeout(this.idle);
    // A native snapshot confirmed the tab is gone. Notify before asynchronous
    // viewport/tunnel cleanup so viewers never treat that cleanup as an outage.
    if (reason === 'removed') for (const ws of this.clients) {
      json(ws, { type: "status", status: "removed" });
      ws.close(1000, "Window removed");
    }
    this.closing = (async () => {
      // Restore the viewport before detaching this client.
      await this.geometry.close();
      for (const ws of this.clients) {
        if (reason !== 'removed') json(ws, { type: "status", status: "closed" });
        ws.close(1000, "Terminal detached");
      }
      this.clients.clear();
      this.hidden.clear();
      this.focused.clear();
      this.rendered.clear();
      this.maximized = undefined;
      try {
        this.proc.kill();
      } catch {}
      await this.handle.cleanup().catch(() => {});
      void this.queue.finally(() => this.emulator.dispose()).catch(() => {});
      this.onClose();
    })();
    return this.closing;
  }
}
export class TerminalManager {
  entries = new Map<string, Promise<LiveTerminal>>();
  private readonly live = new Set<LiveTerminal>();
  private readonly notificationListeners = new Set<(notification: CanvasNotification) => void>();
  private stopped = false;
  private closingSources = new Set<string>();
  private pendingCompletions = new Map<string, { source: Source; notification: CanvasNotification; timer: ReturnType<typeof setTimeout> }>();
  private deliveredCompletions = new Map<string, CompletionToken>();
  private completionBoots = new Map<string, string>();
  constructor(private readonly reads?: CompletionReads, private readonly onFocusedWindowRemoved?: (source: Source, windowId: string) => void) {}
  onNotification(listener: (notification: CanvasNotification) => void) {
    this.notificationListeners.add(listener);
    return { dispose: () => { this.notificationListeners.delete(listener); } };
  }
  private observeCompletionSource(source: Source) {
    const owner = [...this.live].find(terminal => !terminal.closed && terminal.sourceId === source.id && terminal.connectionKey === sourceConnectionKey(source));
    const snapshot = owner?.proc.completionSnapshot();
    if (owner && snapshot) {
      this.reads?.observeSnapshot(source, snapshot.windows, snapshot.state, owner);
      if (this.completionBoots.get(source.id) !== snapshot.state.bootId) {
        this.completionBoots.set(source.id, snapshot.state.bootId);
        for (const window of snapshot.windows) for (const pane of window.panes) {
          const token = this.reads?.completion(source, pane.id)?.completion || pane.completion;
          if (token) this.deliveredCompletions.set(`${source.id}/${pane.id}`, token);
        }
      }
      this.flushCompletions(source.id);
    } else if (!owner) { this.reads?.disconnected(source.id); this.completionBoots.delete(source.id); }
  }
  private publishNotification(notification: CanvasNotification) {
    for (const listener of this.notificationListeners) listener(notification);
  }
  private flushCompletions(sourceId: string) {
    if (!this.reads || this.stopped || this.closingSources.has(sourceId)) return;
    for (const [key, pending] of this.pendingCompletions) {
      if (pending.source.id !== sourceId) continue;
      const completion = this.reads.completion(pending.source, pending.notification.paneId!);
      if (!completion) continue;
      if (sameCompletion(this.deliveredCompletions.get(key), completion.completion)) continue;
      clearTimeout(pending.timer); this.pendingCompletions.delete(key);
      this.deliveredCompletions.set(key, completion.completion);
      if (this.deliveredCompletions.size > 1000) this.deliveredCompletions.delete(this.deliveredCompletions.keys().next().value!);
      this.publishNotification({ ...pending.notification, windowId: completion.windowId, completion: completion.completion });
    }
  }
  async connect(source: Source, target: TerminalTarget, ws: WebSocket) {
    if (this.stopped || this.closingSources.has(source.id))
      throw new Error("Terminal service is closing");
    const key = `${source.id}/${target.windowId}`;
    if (!this.entries.has(key)) {
      if (this.entries.size >= 100)
        throw new Error("At most 100 active terminal windows are supported");
      const creating = (async () => {
        const handle = await openTerminal(source, target.spaceId, target.windowId);
        let transport: HerdrClientTransport | undefined;
        try {
          const cols = 100, rows = 30;
          transport = await handle.connect(cols, rows);
          const terminal = new LiveTerminal(
            key,
            source.id,
            sourceConnectionKey(source),
            target.spaceId,
            handle,
            cols,
            rows,
            () => { this.entries.delete(key); this.live.delete(terminal); this.observeCompletionSource(source); },
            transport,
            source, this.reads, () => this.onFocusedWindowRemoved?.(source, target.windowId),
          );
          this.live.add(terminal);
          transport.onSnapshot(() => {
            const owner = [...this.live].find(candidate => !candidate.closed && candidate.sourceId === source.id && candidate.connectionKey === terminal.connectionKey);
            if (owner === terminal) this.observeCompletionSource(source);
          });
          transport.onNotification(notification => {
            if (this.stopped || this.closingSources.has(source.id) || terminal.closed) return;
            // Herdr broadcasts to every native shell. One existing endpoint owns
            // this connection's live intake; closing it naturally promotes the next.
            const owner = [...this.live].find(candidate => !candidate.closed && candidate.sourceId === source.id && candidate.connectionKey === terminal.connectionKey);
            if (owner !== terminal) return;
            const event: CanvasNotification = { ...notification, id: randomUUID(), sourceId: source.id };
            if (notification.kind !== 'done' || !this.reads) { this.publishNotification(event); return; }
            if (!notification.paneId) return;
            const key = `${source.id}/${notification.paneId}`;
            clearTimeout(this.pendingCompletions.get(key)?.timer);
            const timer = setTimeout(() => this.pendingCompletions.delete(key), 1000);
            timer.unref();
            this.pendingCompletions.set(key, { source, notification: event, timer });
            queueMicrotask(() => this.flushCompletions(source.id));
          });
          return terminal;
        } catch (error) {
          transport?.kill();
          await handle.cleanup();
          throw error;
        }
      })();
      this.entries.set(key, creating);
      creating.catch(() => this.entries.delete(key));
    }
    const terminal = await this.entries.get(key)!;
    if (terminal.closed)
      throw new Error("Terminal is detaching; reconnect in a moment");
    await terminal.join(ws);
    if (terminal.closed)
      throw new Error("Terminal detached while connecting; reconnect in a moment");
    if (!terminal.clients.size && !terminal.closed) {
      terminal.idle = setTimeout(() => void terminal.close(), 20_000);
      terminal.idle.unref();
    }
  }
  async downloadRecipient(sourceId: string, windowId: string): Promise<{ socket: WebSocket; isCurrent(): boolean } | undefined> {
    const pending = this.entries.get(`${sourceId}/${windowId}`);
    if (!pending) return;
    const terminal = await pending.catch(() => undefined);
    const socket = terminal?.downloadRecipient();
    if (!terminal || !socket) return;
    return { socket, isCurrent: () => terminal.downloadRecipient() === socket };
  }
  async content(source: Source, spaceId: string, windowId: string) {
    const terminal = await this.entries.get(`${source.id}/${windowId}`)?.catch(() => undefined);
    return terminal && !terminal.closed && terminal.clients.size && terminal.spaceId === spaceId
      && terminal.connectionKey === sourceConnectionKey(source) ? terminal.proc.content() : undefined;
  }
  private async paneClient(source: Source, spaceId: string, windowId: string) {
    const terminal = await this.entries.get(`${source.id}/${windowId}`)?.catch(() => undefined);
    if (!terminal || terminal.closed || !terminal.clients.size || terminal.spaceId !== spaceId ||
        terminal.connectionKey !== sourceConnectionKey(source)) throw new Error('Open this window first');
    return terminal.proc;
  }
  async paneContext(source: Source, spaceId: string, windowId: string, point: PanePoint) {
    return (await this.paneClient(source, spaceId, windowId)).paneContext(point);
  }
  async paneAction(source: Source, spaceId: string, windowId: string, context: PaneContext, action: PaneAction, authorized: () => boolean) {
    return (await this.paneClient(source, spaceId, windowId)).paneAction(context, action, authorized);
  }
  async captureFilePaste(sourceId: string, windowId: string, ws: WebSocket) {
    const pending = this.entries.get(`${sourceId}/${windowId}`);
    const terminal = await pending?.catch(() => undefined);
    return terminal?.captureFilePaste(ws);
  }
  async closeSource(sourceId: string) {
    this.closingSources.add(sourceId);
    this.completionBoots.delete(sourceId);
    for (const [key, pending] of this.pendingCompletions) if (pending.source.id === sourceId) {
      clearTimeout(pending.timer); this.pendingCompletions.delete(key);
    }
    for (const key of this.deliveredCompletions.keys()) if (key.startsWith(`${sourceId}/`)) this.deliveredCompletions.delete(key);
    try {
      await Promise.all(
        [...this.entries.values()].map(async (p) => {
          const t = await p.catch(() => undefined);
          if (t?.sourceId === sourceId) await t.close();
        }),
      );
    } finally {
      this.closingSources.delete(sourceId);
    }
  }
  async closeAll() {
    this.stopped = true;
    this.notificationListeners.clear();
    for (const pending of this.pendingCompletions.values()) clearTimeout(pending.timer);
    this.pendingCompletions.clear(); this.deliveredCompletions.clear(); this.completionBoots.clear();
    await Promise.all(
      [...this.entries.values()].map(async (p) =>
        (await p.catch(() => undefined))?.close(),
      ),
    );
  }
}
