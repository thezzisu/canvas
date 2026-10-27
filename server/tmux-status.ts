import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { StatusDetails, ProgramStatus } from "./status.ts";

// OSC 7501 revision 0.4. Passive reports only: capability queries are not answered.
// https://www.superlogical.com/rex/docs/build/program-status
const MAX_OSC_BYTES = 4096;
const MAX_CONTROL_LINE = 2 * 1024 * 1024;
const MAX_RECORDS = 256;
const priority: Record<ProgramStatus, number> = {
  error: 5,
  attention: 4,
  working: 3,
  done: 2,
  idle: 1,
  unknown: 0,
};
interface RecordStatus extends StatusDetails {
  id?: string;
}
interface Report {
  id?: string;
  state: "idle" | "working" | "done" | "blocked" | "error" | "clear";
  progress?: number;
}

/** Parse bounded, explicitly reported status; screen text never supplies status. */
export function parseProgramStatus(body: string): Report | undefined {
  if (Buffer.byteLength(body) > MAX_OSC_BYTES - 9) return;
  const values = new Map<string, string>();
  for (const pair of body.split(":")) {
    const equals = pair.indexOf("=");
    if (equals < 0) continue;
    const key = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (Buffer.byteLength(key) > 16) return;
    // A malformed ID must never fall back to root, even if later overwritten.
    if (
      key === "id" &&
      (value.length > 128 ||
        value.split("/").length > 8 ||
        value.split("/").some((part) => !/^[A-Za-z0-9_.+-]{1,32}$/u.test(part)))
    )
      return;
    if (
      (key === "app" && Buffer.byteLength(value) > 32) ||
      (key === "title" && Buffer.byteLength(value) > 256) ||
      (key === "msg" && Buffer.byteLength(value) > 2732)
    )
      return;
    if (/^[a-z]+$/u.test(key) && /^[A-Za-z0-9_.,+/=-]*$/u.test(value))
      values.set(key, value);
  }
  for (const [key, max] of [
    ["title", 192],
    ["msg", 2048],
  ] as const) {
    const encoded = values.get(key);
    if (encoded === undefined) continue;
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?|)$/u.test(
        encoded,
      )
    )
      return;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > max) return;
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return;
    }
    if (/[\x00-\x1f\x7f-\x9f]/u.test(decoded)) return;
  }
  const state = values.get("state");
  if (
    state !== "idle" &&
    state !== "working" &&
    state !== "done" &&
    state !== "blocked" &&
    state !== "error" &&
    state !== "clear"
  )
    return;
  const value = values.get("progress");
  const progress =
    (state === "working" || state === "blocked") &&
    value !== undefined &&
    /^\d+$/u.test(value) &&
    Number(value) <= 100
      ? Number(value)
      : undefined;
  const id = values.get("id");
  return {
    state,
    ...(id === undefined ? {} : { id }),
    ...(progress === undefined ? {} : { progress }),
  };
}

/** One bounded record set per native pane, independent of primary/alternate screen. */
export class ProgramStatusStream {
  private state:
    | "text"
    | "escape"
    | "osc"
    | "oscEscape"
    | "discard"
    | "discardEscape"
    | "string"
    | "stringEscape" = "text";
  private bytes: number[] = [];
  private records = new Map<string, RecordStatus>();
  private received = false;

  feed(data: Buffer): void {
    for (const byte of data) {
      if (byte === 0x18 || byte === 0x1a) {
        this.state = "text";
        this.bytes = [];
        continue;
      }
      switch (this.state) {
        case "text":
          if (byte === 0x1b) this.state = "escape";
          break;
        case "escape":
          if (byte === 0x5d) {
            this.state = "osc";
            this.bytes = [];
          } else if (
            byte === 0x50 ||
            byte === 0x5f ||
            byte === 0x5e ||
            byte === 0x58
          )
            this.state = "string";
          else if (byte === 0x63) {
            this.records.clear();
            this.received = false;
            this.state = "text";
          } else if (byte !== 0x1b) this.state = "text";
          break;
        case "osc":
          if (byte === 0x07) {
            this.consumeOsc();
            this.state = "text";
          } else if (byte === 0x1b) this.state = "oscEscape";
          else if (
            (byte < 0x20 && byte !== 0x09) ||
            byte > 0x7e ||
            this.bytes.length >= MAX_OSC_BYTES - 4
          ) {
            this.bytes = [];
            this.state = "discard";
          } else this.bytes.push(byte);
          break;
        case "oscEscape":
          if (byte === 0x5c) {
            this.consumeOsc();
            this.state = "text";
          } else {
            this.bytes = [];
            this.state = "text";
          }
          break;
        case "discard":
          if (byte === 0x07) this.state = "text";
          else if (byte === 0x1b) this.state = "discardEscape";
          break;
        case "discardEscape":
          this.state = byte === 0x5c ? "text" : "discard";
          break;
        case "string":
          if (byte === 0x1b) this.state = "stringEscape";
          break;
        case "stringEscape":
          this.state = byte === 0x5c ? "text" : "string";
          break;
      }
    }
  }

  /** Pane exit drops transient states, while completed/error records may remain. */
  processExited(): void {
    for (const [id, record] of this.records)
      if (record.status === "working" || record.status === "attention")
        this.records.delete(id);
  }

  snapshot(): StatusDetails | undefined {
    if (!this.received) return;
    let winner: StatusDetails = { status: "unknown", statusSource: "osc7501" };
    for (const record of this.records.values())
      if (priority[record.status] > priority[winner.status])
        winner = { ...record };
    return winner;
  }

  private consumeOsc(): void {
    const body = Buffer.from(this.bytes).toString("ascii");
    this.bytes = [];
    if (body === "133;A" || body.startsWith("133;A;")) {
      this.processExited();
      return;
    }
    if (!body.startsWith("7501;")) return;
    const report = parseProgramStatus(body.slice(5));
    if (!report) return;
    this.received = true;
    if (report.state === "clear") {
      if (report.id === undefined) this.records.clear();
      else
        for (const id of this.records.keys())
          if (id === report.id || id.startsWith(`${report.id}/`))
            this.records.delete(id);
      return;
    }
    const id = report.id ?? "";
    this.records.delete(id);
    this.records.set(id, {
      status: report.state === "blocked" ? "attention" : report.state,
      statusSource: "osc7501",
      nativeStatus: report.state,
      ...(report.progress === undefined ? {} : { progress: report.progress }),
    });
    // Insertion order is last-updated order after delete+set.
    if (this.records.size > MAX_RECORDS)
      this.records.delete(this.records.keys().next().value!);
  }
}

interface WindowObserver {
  process: ChildProcessWithoutNullStreams;
  streams: Map<string, ProgramStatusStream>;
  line: Buffer;
  droppingLine: boolean;
  stopping: boolean;
}
interface Command {
  file: string;
  args: string[];
}
const sources = new Map<string, Map<string, WindowObserver>>();

/**
 * Observe only an already-open Canvas helper after its native client produces
 * output. Attaching observers to original sessions can flush tmux's pending
 * window resizes, even with ignore-size, so resource discovery never attaches.
 */
export function observeTmuxWindow(
  sourceId: string,
  windowId: string,
  command: Command,
  env: NodeJS.ProcessEnv,
): () => void {
  let windows = sources.get(sourceId);
  if (!windows) sources.set(sourceId, (windows = new Map()));
  const previous = windows.get(windowId);
  if (previous) stopObserver(previous);
  const child = spawn(command.file, command.args, { env, stdio: "pipe" });
  const observer: WindowObserver = {
    process: child,
    streams: new Map(),
    line: Buffer.alloc(0),
    droppingLine: false,
    stopping: false,
  };
  windows.set(windowId, observer);
  child.stdout.on("data", (chunk: Buffer) => receiveControl(observer, chunk));
  // Never retain or log arbitrary server stderr (which may include shell data).
  child.stderr.resume();
  const cleanup = () => {
    stopObserver(observer);
    if (windows.get(windowId) !== observer) return;
    windows.delete(windowId);
    if (windows.size === 0 && sources.get(sourceId) === windows)
      sources.delete(sourceId);
  };
  child.on("error", cleanup);
  child.on("exit", cleanup);
  return cleanup;
}

function receiveControl(observer: WindowObserver, chunk: Buffer): void {
  let bytes = observer.line.length
    ? Buffer.concat([observer.line, chunk])
    : chunk;
  observer.line = Buffer.alloc(0);
  if (observer.droppingLine) {
    const end = bytes.indexOf(0x0a);
    if (end < 0) return;
    bytes = bytes.subarray(end + 1);
    observer.droppingLine = false;
  }
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0x0a, start);
    if (end < 0) break;
    if (end - start <= MAX_CONTROL_LINE) {
      const line = bytes.subarray(start, end).toString("latin1");
      // Without pause-after, tmux emits %output. Preserve bytes across packets.
      const output = /^%output (%\d+) (.*)$/u.exec(line);
      if (output) {
        const paneId = output[1]!;
        let stream = observer.streams.get(paneId);
        if (!stream)
          observer.streams.set(paneId, (stream = new ProgramStatusStream()));
        const raw = Buffer.from(
          output[2]!.replace(/\\([0-7]{3})/gu, (_, octal: string) =>
            String.fromCharCode(Number.parseInt(octal, 8)),
          ),
          "latin1",
        );
        stream.feed(raw);
      }
    }
    start = end + 1;
  }
  if (bytes.length - start > MAX_CONTROL_LINE) observer.droppingLine = true;
  else observer.line = bytes.subarray(start);
}

function stopObserver(observer: WindowObserver): void {
  if (observer.stopping) return;
  observer.stopping = true;
  // EOF detaches the native control client without sending terminal input.
  observer.process.stdin.end();
  const timer = setTimeout(() => observer.process.kill(), 1500);
  timer.unref();
}

export function tmuxProgramStatus(
  sourceId: string,
  windowId: string,
  paneId: string,
  dead = false,
): StatusDetails | undefined {
  const stream = sources.get(sourceId)?.get(windowId)?.streams.get(paneId);
  if (dead) stream?.processExited();
  return stream?.snapshot();
}
export function pruneTmuxStatus(
  sourceId: string,
  windowId: string,
  paneIds: ReadonlySet<string>,
): void {
  const observer = sources.get(sourceId)?.get(windowId);
  if (observer)
    for (const paneId of observer.streams.keys())
      if (!paneIds.has(paneId)) observer.streams.delete(paneId);
}
export function disposeStatusSource(sourceId: string): void {
  const source = sources.get(sourceId);
  if (source) for (const observer of source.values()) stopObserver(observer);
  sources.delete(sourceId);
}
export function closeStatusObservers(): void {
  for (const sourceId of sources.keys()) disposeStatusSource(sourceId);
}
