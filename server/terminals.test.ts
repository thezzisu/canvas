import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
