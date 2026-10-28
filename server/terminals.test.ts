import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { TerminalManager } from "./terminals.ts";
import { listResources, type Source } from "./providers.ts";

class Client extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  received: (string | Buffer)[] = [];
  send(data: string | Buffer) {
    this.received.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  command(data: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(data)), false);
  }
  get socket() {
    return this as unknown as WebSocket;
  }
}

test("file downloads require explicit interaction and never follow passive controller fallback", async (t) => {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); }
  catch { t.skip("tmux is not installed"); return; }
  const root = mkdtempSync(join(tmpdir(), "canvas-download-owner-")), socket = join(root, "socket");
  const source: Source = { id: "download-owner", name: "Download owner", type: "tmux", transport: "local", tmuxSocket: socket };
  const manager = new TerminalManager(), first = new Client(), second = new Client(), reconnected = new Client();
  const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "download-owner", "-x", "100", "-y", "30");
    const space = (await listResources(source)).spaces[0]!, windowId = space.windows[0]!.id;
    const target = { sourceId: source.id, spaceId: space.id, windowId };
    await manager.connect(source, target, first.socket);
    await manager.connect(source, target, second.socket);
    assert.equal(await manager.downloadRecipient(source.id, windowId), undefined, "opening viewers alone selected a file recipient");

    second.command({ type: "focus" });
    const secondRecipient = await manager.downloadRecipient(source.id, windowId);
    assert.equal(secondRecipient?.socket, second.socket);
    assert.equal(secondRecipient?.isCurrent(), true);
    first.command({ type: "focus" });
    assert.equal(secondRecipient?.isCurrent(), false, "an in-flight recipient snapshot survived another viewer taking control");
    assert.equal((await manager.downloadRecipient(source.id, windowId))?.socket, first.socket);

    first.close();
    assert.equal(await manager.downloadRecipient(source.id, windowId), undefined, "controller fallback inherited file delivery without a fresh interaction");
    await manager.connect(source, target, reconnected.socket);
    assert.equal(await manager.downloadRecipient(source.id, windowId), undefined, "reconnecting a browser automatically reclaimed file delivery");
    second.command({ type: "focus" });
    assert.equal((await manager.downloadRecipient(source.id, windowId))?.socket, second.socket);

    reconnected.command({ type: "focus-resize-begin", token: "fixture-download-maximized", cols: 100, rows: 30 });
    const maximizedRecipient = await manager.downloadRecipient(source.id, windowId);
    assert.equal(maximizedRecipient?.socket, reconnected.socket, "maximizing a window did not count as explicit interaction");
    second.command({ type: "focus" });
    assert.equal(maximizedRecipient?.isCurrent(), true, "a paused viewer stole the maximized window's file recipient");
    reconnected.close();
    assert.equal(maximizedRecipient?.isCurrent(), false);
    assert.equal(await manager.downloadRecipient(source.id, windowId), undefined, "closing the maximized recipient handed files to a passive viewer");
  } finally {
    await manager.closeAll();
    try { tmux("kill-server"); } catch { /* fixture already stopped */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("one native window has one maximized view, pauses other streams and resumes complete current snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-presentation-")), socket = join(root, "socket");
  const source: Source = { id: "presentation", name: "Presentation", type: "tmux", transport: "local", tmuxSocket: socket };
  const manager = new TerminalManager(), first = new Client(), second = new Client(), late = new Client(), independent = new Client();
  const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
  const messages = (client: Client) => client.received.filter((data): data is string => typeof data === "string").map(data => JSON.parse(data));
  const presentation = (client: Client) => messages(client).filter(item => item.type === "presentation").at(-1);
  const waitFor = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(label);
  };
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "native", "-x", "90", "-y", "28");
    const space = (await listResources(source)).spaces[0]!, windowId = space.windows[0]!.id, rawWindow = windowId.split(":")[1]!;
    const target = { sourceId: source.id, spaceId: space.id, windowId };
    const size = () => tmux("display-message", "-p", "-t", rawWindow, "#{window_width}x#{window_height}");
    const screen = () => tmux("capture-pane", "-p", "-t", rawWindow);
    const pid = tmux("display-message", "-p", "-t", rawWindow, "#{pane_pid}");
    await manager.connect(source, target, first.socket);
    await manager.connect(source, target, second.socket);
    first.command({ type: "focus-resize-begin", token: "first", cols: 130, rows: 40 });
    assert.deepEqual(presentation(second), { type: "presentation", maximized: true, owned: false, token: "first" });
    await waitFor(() => size() === "130x40", "first maximize did not resize native window");
    const secondMark = second.received.length;
    second.command({ type: "focus" });
    second.command({ type: "input", data: "printf 'BLOCKED_%s\\n' VIEW\r" });
    second.command({ type: "resize", cols: 70, rows: 20 });
    first.command({ type: "input", data: "printf 'CURRENT_%s\\n' SCREEN\r" });
    await waitFor(() => screen().includes("CURRENT_SCREEN"), "owner input did not reach terminal");
    assert.ok(!screen().includes("BLOCKED_VIEW"));
    assert.equal(size(), "130x40");
    assert.ok(second.received.slice(secondMark).every(data => typeof data === "string" && JSON.parse(data).type !== "resize"), "paused viewer received native output or size");
    await manager.connect(source, target, late.socket);
    assert.equal(manager.entries.size, 1);
    assert.ok(late.received.every(data => typeof data === "string" && JSON.parse(data).type !== "resize"));
    assert.equal(presentation(late).maximized, true);
    tmux("new-window", "-d", "-t", "native", "-n", "independent");
    const otherSpace = (await listResources(source)).spaces.find(item => item.id === space.id)!;
    const otherWindow = otherSpace.windows.find(item => item.id !== windowId)!;
    await manager.connect(source, { ...target, windowId: otherWindow.id }, independent.socket);
    independent.command({ type: "focus-resize-begin", token: "fixture-independent", cols: 100, rows: 32 });
    await waitFor(() => presentation(independent)?.owned === true, "independent native window did not maximize");
    assert.equal(presentation(first).owned, true, "another native window displaced this window's owner");
    assert.equal(manager.entries.size, 2);

    const takeoverMark = second.received.length;
    second.command({ type: "focus-resize-begin", token: "second", cols: 144, rows: 44 });
    assert.equal(presentation(first).owned, false);
    await waitFor(() => size() === "144x44" && presentation(second)?.owned === true, "second view could not take over");
    const takeover = second.received.slice(takeoverMark);
    const resetIndex = takeover.findIndex(data => typeof data === "string" && JSON.parse(data).type === "reset");
    const replayIndex = takeover.findIndex(data => Buffer.isBuffer(data) && data.toString().includes("CURRENT_SCREEN"));
    const shownIndex = takeover.findIndex(data => typeof data === "string" && JSON.parse(data).type === "presentation" && JSON.parse(data).owned);
    assert.ok(resetIndex >= 0 && replayIndex > resetIndex && shownIndex > replayIndex, "takeover became visible before its complete reset/snapshot");
    first.command({ type: "focus-resize-end", token: "first" });
    first.command({ type: "focus-resize-update", token: "first", cols: 80, rows: 24 });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(size(), "144x44", "stale owner changed the new owner's geometry");

    tmux("resize-window", "-t", rawWindow, "-x", "111", "-y", "36");
    await waitFor(() => messages(second).some(item => item.type === "focus-resize" && item.reason === "external-resize"), "external geometry change was not detected");
    assert.equal(presentation(second).owned, true, "external geometry incorrectly released presentation ownership");
    assert.equal(presentation(first).maximized, true);
    const resumeMark = late.received.length;
    second.command({ type: "focus-resize-end", token: "second" });
    await waitFor(() => presentation(late)?.maximized === false, "paused viewer did not resume");
    assert.equal(size(), "111x36", "release overwrote the external size");
    const resumedFrames = late.received.slice(resumeMark);
    const resume = resumedFrames.slice(resumedFrames.findIndex(data => typeof data === "string" && JSON.parse(data).type === "reset"));
    assert.deepEqual(JSON.parse(resume[0] as string), { type: "reset" });
    assert.deepEqual(JSON.parse(resume[1] as string), { type: "resize", cols: 111, rows: 36 });
    assert.ok(Buffer.isBuffer(resume[2]) && resume[2].toString().includes("CURRENT_SCREEN"));
    assert.deepEqual(JSON.parse(resume[3] as string), { type: "presentation", maximized: false, owned: false });

    second.command({ type: "focus-resize-begin", token: "fixture-disconnect", cols: 150, rows: 45 });
    await waitFor(() => size() === "150x45", "disconnect setup did not maximize");
    second.close();
    await waitFor(() => size() === "111x36" && presentation(first)?.maximized === false, "disconnect did not restore baseline and resume viewers");
    first.command({ type: "focus-resize-begin", token: "fixture-cancelled", cols: 160, rows: 48 });
    first.command({ type: "focus-resize-end", token: "fixture-cancelled" });
    late.command({ type: "focus-resize-begin", token: "latest", cols: 140, rows: 42 });
    await waitFor(() => size() === "140x42" && presentation(late)?.owned === true, "rapid release and takeover lost the latest owner");
    assert.equal(presentation(first).maximized, true);
    assert.equal(presentation(first).owned, false);
    late.command({ type: "focus-resize-end", token: "latest" });
    await waitFor(() => size() === "111x36" && presentation(first)?.maximized === false, "rapid takeover did not restore the original baseline");
    assert.equal(tmux("display-message", "-p", "-t", rawWindow, "#{pane_pid}"), pid);
    assert.equal(presentation(independent).owned, true, "presentation ownership leaked across native windows");
  } finally {
    await manager.closeAll();
    try { tmux("kill-server"); } catch { /* fixture already stopped */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared native terminals serialize screen to late viewers and keep last resize", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "canvas-terminal-manager-"));
  const socket = join(root, "socket");
  const source: Source = {
    id: "shared",
    name: "Shared",
    type: "tmux",
    transport: "local",
    tmuxSocket: socket,
  };
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const manager = new TerminalManager();
  const first = new Client(),
    second = new Client();
  const waitFor = async (check: () => boolean, message: string) => {
    for (let i = 0; i < 150; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(message);
  };
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "shared");
    const space = (await listResources(source)).spaces[0]!;
    const windowId = space.windows[0]!.id,
      rawWindow = windowId.split(":")[1]!;
    const target = { sourceId: source.id, spaceId: space.id, windowId };
    await manager.connect(source, target, first.socket);
    first.command({ type: "input", data: "printf 'SHARED_%s\\n' SCREEN\r" });
    await waitFor(
      () =>
        first.received.some(
          (data) =>
            Buffer.isBuffer(data) && data.toString().includes("SHARED_SCREEN"),
        ),
      "first viewer did not receive shell output",
    );
    await manager.connect(source, target, second.socket);
    assert.equal(manager.entries.size, 1);
    assert.ok(
      second.received.some(
        (data) =>
          Buffer.isBuffer(data) && data.toString().includes("SHARED_SCREEN"),
      ),
      "late viewer received no serialized screen",
    );
    assert.ok(
      second.received.some(
        (data) =>
          typeof data === "string" && JSON.parse(data).readOnly === true,
      ),
      "opening a viewer must not steal input ownership",
    );
    second.command({ type: "focus" });
    assert.ok(
      first.received.some(
        (data) =>
          typeof data === "string" && JSON.parse(data).readOnly === true,
      ),
    );
    first.readyState = 2;
    first.command({ type: "focus" });
    first.command({ type: "input", data: "printf 'BLOCKED_%s\\n' INPUT\r" });
    second.command({ type: "input", data: "printf 'ALLOWED_%s\\n' INPUT\r" });
    await waitFor(
      () =>
        tmux("capture-pane", "-p", "-t", rawWindow).includes("ALLOWED_INPUT"),
      "controller input did not reach window",
    );
    assert.ok(
      !tmux("capture-pane", "-p", "-t", rawWindow).includes("BLOCKED_INPUT"),
    );
    for (let size = 110; size <= 132; size++)
      second.command({ type: "resize", cols: size, rows: 42 });
    await waitFor(
      () =>
        tmux(
          "display-message",
          "-p",
          "-t",
          rawWindow,
          "#{window_width}x#{window_height}",
        ) === "132x42",
      "rapid resize did not end at latest dimensions",
    );
    second.command({ type: "input", data: "seq 1 40000\r" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await manager.closeAll();
    await assert.rejects(
      manager.connect(source, target, new Client().socket),
      /service is closing/,
    );
    assert.equal(manager.entries.size, 0);
    assert.equal(tmux("list-sessions", "-F", "#{session_name}"), "shared");
  } finally {
    await manager.closeAll();
    try {
      tmux("kill-server");
    } catch {
      /* Already stopped. */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("binary terminal input reaches a real PTY byte-for-byte without changing UTF-8 text input", async () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-input-bytes-"));
  const socket = join(root, "socket"),
    receiver = join(root, "receiver.py");
  writeFileSync(
    receiver,
    "import os,tty\ntty.setraw(0)\nprint('\\x1b[?1003hREADY',flush=True)\nwhile True:\n data=os.read(0,4096)\n print('HEX:'+data.hex(),flush=True)\n",
  );
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const source: Source = {
    id: "bytes",
    name: "Bytes",
    type: "tmux",
    transport: "local",
    tmuxSocket: socket,
  };
  const manager = new TerminalManager(),
    client = new Client();
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 150; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("native byte receiver timed out");
  };
  try {
    tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "bytes",
      `python3 -u '${receiver}'`,
    );
    const space = (await listResources(source)).spaces[0]!,
      windowId = space.windows[0]!.id;
    const screen = () => tmux("capture-pane", "-p", "-t", "bytes:0.0");
    await manager.connect(
      source,
      { sourceId: source.id, spaceId: space.id, windowId },
      client.socket,
    );
    await waitFor(() => screen().includes("READY"));
    client.command({ type: "resize", cols: 220, rows: 60 });
    await waitFor(
      () =>
        tmux("display-message", "-p", "-t", "bytes:0", "#{window_width}") ===
        "220",
    );
    // A valid legacy mouse report has a non-ASCII column byte at column 168.
    client.command({
      type: "input",
      encoding: "binary",
      data: "\x1b[M" + String.fromCharCode(67, 200, 70),
    });
    await waitFor(() => screen().includes("HEX:1b5b4d43c846"));
    client.command({ type: "input", data: "中文" });
    await waitFor(() => screen().includes("HEX:e4b8ade69687"));
  } finally {
    await manager.closeAll();
    try {
      tmux("kill-server");
    } catch {
      /* fixture already stopped */
    }
    rmSync(root, { recursive: true, force: true });
  }
});
