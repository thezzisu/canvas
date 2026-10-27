import * as pty from "node-pty";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import type { WebSocket } from "ws";
import type { Source } from "./state.ts";
import { openTerminal } from "./providers.ts";
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
function safeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSH_AUTH_SOCK",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}
function json(ws: WebSocket, data: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}
class LiveTerminal {
  proc: pty.IPty;
  emulator: InstanceType<typeof Terminal>;
  serializer: InstanceType<typeof SerializeAddon>;
  clients = new Set<WebSocket>();
  controller?: WebSocket;
  idle?: ReturnType<typeof setTimeout>;
  queue: Promise<void> = Promise.resolve();
  pendingBytes = 0;
  paused = false;
  requestedSize?: { cols: number; rows: number };
  resizing = false;
  resizeTask?: Promise<void>;
  closed = false;
  cols: number;
  rows: number;
  constructor(
    readonly key: string,
    readonly sourceId: string,
    readonly handle: Awaited<ReturnType<typeof openTerminal>>,
    cols: number,
    rows: number,
    readonly onClose: () => void,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.emulator = new Terminal({
      cols,
      rows,
      scrollback: 2000,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.emulator.loadAddon(this.serializer);
    this.proc = pty.spawn(handle.file, handle.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME,
      env: { ...safeEnv(), ...handle.env },
    });
    let connected = false;
    this.proc.onData((data) => {
      if (this.closed) return;
      if (!connected) {
        connected = true;
        handle.connected?.();
      }
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
    this.proc.onExit(() => void this.close());
  }
  async join(ws: WebSocket) {
    clearTimeout(this.idle);
    this.queue = this.queue.then(() => {
      if (this.closed || ws.readyState !== 1) return;
      json(ws, { type: "resize", cols: this.cols, rows: this.rows });
      ws.send(Buffer.from(this.serializer.serialize(), "utf8"));
      this.clients.add(ws);
      this.controller = ws;
      this.status();
    });
    await this.queue;
    ws.on("message", (data, isBinary) => {
      if (isBinary || Buffer.byteLength(data.toString()) > 128 * 1024) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "focus") {
          this.controller = ws;
          this.status();
          return;
        }
        if (this.controller !== ws) return;
        if (
          msg.type === "input" &&
          typeof msg.data === "string" &&
          msg.data.length <= 64 * 1024
        )
          this.proc.write(msg.data);
        if (msg.type === "resize") {
          const cols = clamp(msg.cols, 20, 500, this.cols),
            rows = clamp(msg.rows, 5, 200, this.rows);
          if (cols === this.cols && rows === this.rows) return;
          this.cols = cols;
          this.rows = rows;
          this.proc.resize(cols, rows);
          this.emulator.resize(cols, rows);
          this.requestedSize = { cols, rows };
          if (!this.resizing) this.resizeTask = this.applySize();
          for (const client of this.clients)
            json(client, { type: "resize", cols, rows });
        }
      } catch {
        /* Malformed messages cannot become terminal commands. */
      }
    });
    ws.once("close", () => {
      this.clients.delete(ws);
      if (this.closed) return;
      if (this.controller === ws)
        this.controller = this.clients.values().next().value;
      this.status();
      if (!this.clients.size) {
        this.idle = setTimeout(() => void this.close(), 20_000);
        this.idle.unref();
      }
    });
  }
  async applySize() {
    if (this.resizing || this.closed) return;
    this.resizing = true;
    try {
      while (this.requestedSize && !this.closed) {
        const size = this.requestedSize;
        this.requestedSize = undefined;
        try {
          await this.handle.resize?.(size.cols, size.rows);
        } catch (error) {
          if (!this.closed)
            for (const ws of this.clients)
              json(ws, {
                type: "status",
                status: "error",
                error:
                  error instanceof Error
                    ? error.message
                    : "Terminal resize failed",
              });
        }
      }
    } finally {
      this.resizing = false;
    }
  }
  status() {
    for (const ws of this.clients)
      json(ws, {
        type: "status",
        status: "connected",
        readOnly: this.controller !== ws,
      });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    for (const ws of this.clients) {
      json(ws, { type: "status", status: "closed" });
      ws.close(1000, "Terminal detached");
    }
    this.clients.clear();
    try {
      this.proc.kill();
    } catch {}
    await this.resizeTask?.catch(() => {});
    await this.handle.cleanup().catch(() => {});
    // Complete already accepted parser writes before disposing its buffer.
    // New queued callbacks see closed and return without touching the emulator.
    void this.queue.finally(() => this.emulator.dispose()).catch(() => {});
    this.onClose();
  }
}
export class TerminalManager {
  entries = new Map<string, Promise<LiveTerminal>>();
  async connect(source: Source, target: TerminalTarget, ws: WebSocket) {
    const key = `${source.id}/${target.windowId}`;
    if (!this.entries.has(key)) {
      if (this.entries.size >= 100)
        throw new Error("At most 100 active terminal windows are supported");
      const creating = (async () => {
        const handle = await openTerminal(
          source,
          target.spaceId,
          target.windowId,
          100,
          30,
        );
        try {
          return new LiveTerminal(key, source.id, handle, 100, 30, () =>
            this.entries.delete(key),
          );
        } catch (error) {
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
    if (!terminal.clients.size && !terminal.closed) {
      terminal.idle = setTimeout(() => void terminal.close(), 20_000);
      terminal.idle.unref();
    }
  }
  async closeSource(sourceId: string) {
    await Promise.all(
      [...this.entries.values()].map(async (p) => {
        const t = await p.catch(() => undefined);
        if (t?.sourceId === sourceId) await t.close();
      }),
    );
  }
  async closeAll() {
    await Promise.all(
      [...this.entries.values()].map(async (p) =>
        (await p.catch(() => undefined))?.close(),
      ),
    );
  }
}
