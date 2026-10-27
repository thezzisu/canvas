import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateStatus, herdrStatus, tmuxProgressStatus } from "./status.ts";
import { listResources, type Source } from "./providers.ts";

test("native agent states preserve unseen completion and prioritize every pane", () => {
  assert.deepEqual(herdrStatus("done"), {
    status: "done",
    statusSource: "herdr",
    nativeStatus: "done",
  });
  assert.equal(herdrStatus("blocked").status, "attention");
  assert.equal(herdrStatus("future-status").status, "unknown");
  assert.equal(
    aggregateStatus([herdrStatus("working"), herdrStatus("blocked")]).status,
    "attention",
  );
  assert.equal(
    aggregateStatus([herdrStatus("idle"), herdrStatus("unknown")]).status,
    "idle",
  );
  assert.equal(
    aggregateStatus([herdrStatus("done"), tmuxProgressStatus("error", "0")])
      .status,
    "error",
  );
  assert.deepEqual(tmuxProgressStatus("hidden", "0"), {
    status: "unknown",
    statusSource: "none",
    nativeStatus: "hidden",
  });
  assert.equal(tmuxProgressStatus(undefined, undefined).status, "unknown");
  assert.equal(tmuxProgressStatus("indeterminate", "0").progress, undefined);
  assert.equal(tmuxProgressStatus("normal", "101").progress, undefined);
});

test("tmux pane OSC9;4 changes update window status without altering selections or pipes", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "canvas-status-"));
  const socket = join(root, "socket");
  const source: Source = {
    id: "status",
    name: "Status",
    type: "tmux",
    transport: "local",
    tmuxSocket: socket,
  };
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 80; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("status update was not observed");
  };
  try {
    tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "status",
      "-n",
      "one",
      "/bin/sh",
    );
    tmux("split-window", "-h", "-t", "status:0", "/bin/sh");
    tmux("new-window", "-t", "status:", "-n", "two", "/bin/sh");
    tmux("new-session", "-d", "-s", "linked", "/bin/sh");
    tmux("link-window", "-s", "status:0", "-t", "linked:1");
    const originalSelection = tmux(
      "display-message",
      "-p",
      "-t",
      "status:",
      "#{window_id}",
    );
    const originalPipes = tmux(
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}:#{pane_pipe}",
    );
    const originalDimensions = tmux(
      "list-windows",
      "-a",
      "-F",
      "#{window_id}:#{window_width}x#{window_height}",
    );
    if (
      !tmux("display-message", "-p", "-t", "status:0.0", "#{pane_pb_state}")
    ) {
      t.skip("tmux does not expose OSC9;4 pane progress");
      return;
    }
    const getWindow = async () =>
      (await listResources(source)).spaces
        .find((s) => s.name === "status")!
        .windows.find((w) => w.name === "one")!;
    assert.equal((await getWindow()).panes.length, 2);
    assert.equal((await getWindow()).status, "unknown");
    tmux(
      "send-keys",
      "-t",
      "status:0.0",
      'printf "\\033]9;4;1;42\\007"',
      "Enter",
    );
    await waitFor(async () =>
      (await getWindow()).panes.some(
        (p) => p.status === "working" && p.progress === 42,
      ),
    );
    tmux(
      "send-keys",
      "-t",
      "status:0.1",
      'printf "\\033]9;4;4;15\\033\\\\"',
      "Enter",
    );
    await waitFor(async () => (await getWindow()).status === "attention");
    tmux(
      "send-keys",
      "-t",
      "status:0.1",
      'printf "\\033]9;4;2;15\\007"',
      "Enter",
    );
    await waitFor(async () => (await getWindow()).status === "error");
    tmux(
      "send-keys",
      "-t",
      "status:0.1",
      'printf "\\033]9;4;0;0\\007"',
      "Enter",
    );
    await waitFor(async () => (await getWindow()).status === "working");
    const linked = (await listResources(source)).spaces
      .find((s) => s.name === "linked")!
      .windows.find((w) => w.name === "one")!;
    assert.equal(linked.panes.length, 2);
    assert.equal(linked.status, "working");
    assert.equal(
      tmux("display-message", "-p", "-t", "status:", "#{window_id}"),
      originalSelection,
    );
    assert.equal(
      tmux("list-panes", "-a", "-F", "#{pane_id}:#{pane_pipe}"),
      originalPipes,
    );
    assert.equal(
      tmux(
        "list-windows",
        "-a",
        "-F",
        "#{window_id}:#{window_width}x#{window_height}",
      ),
      originalDimensions,
    );
  } finally {
    try {
      tmux("kill-server");
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
