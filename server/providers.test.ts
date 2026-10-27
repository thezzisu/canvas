import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import {
  createSpace,
  createWindow,
  closeSpace,
  closeWindow,
  listResources,
  openTerminal,
  parseSshTarget,
  renameSpace,
  renameWindow,
  shellQuote,
  type Source,
} from "./providers.ts";

test("SSH arguments reject credentials, options and shell metacharacters", () => {
  assert.deepEqual(parseSshTarget("ssh://alice@example.test:2222"), {
    destination: "alice@example.test",
    host: "example.test:2222",
    port: "2222",
  });
  assert.deepEqual(parseSshTarget("workbox"), {
    destination: "workbox",
    host: "workbox",
  });
  assert.equal(parseSshTarget("ssh://[::1]:2200").destination, "[::1]");
  for (const target of [
    "-oProxyCommand=x",
    "host;touch-file",
    "ssh://a:EXAMPLE@host",
    "ssh://host/path",
    "ssh://host?x",
    "ssh://host#x",
    "ssh://-host",
    "ssh://a%0ab@host",
  ]) {
    assert.throws(() => parseSshTarget(target), Error, target);
  }
  const value = "a'; $(touch /tmp/not-executed) `whoami`\n";
  assert.equal(
    execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], {
      encoding: "utf8",
    }),
    value,
  );
});

test("tmux native bare client preserves source selection, resize, panes and lifecycle", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "canvas-provider-"));
  const socket = join(root, "socket");
  const source: Source = {
    id: "test",
    name: "Test",
    type: "tmux",
    transport: "local",
    tmuxSocket: socket,
  };
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const raw = (id: string) => id.split(":")[1]!;
  const opened: Awaited<ReturnType<typeof openTerminal>>[] = [];
  let terminal: pty.IPty | undefined;
  try {
    // Discovery on an empty socket must not launch the daemon.
    assert.deepEqual((await listResources(source)).spaces, []);
    assert.throws(() => tmux("list-sessions"));
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "first", "-n", "one");
    tmux("new-window", "-t", "first:", "-n", "two");
    const snapshot = await listResources(source);
    assert.equal(snapshot.status, "online");
    const space = snapshot.spaces[0]!;
    const one = space.windows.find((w) => w.name === "one")!;
    const beforeSelection = tmux(
      "display-message",
      "-p",
      "-t",
      "first:",
      "#{window_id}",
    );
    tmux("split-window", "-h", "-t", raw(one.id));
    const initialPolicy = tmux(
      "show-options",
      "-w",
      "-t",
      raw(one.id),
      "window-size",
    );
    const command = await openTerminal(source, space.id, one.id, 90, 25);
    opened.push(command);
    assert.equal(
      tmux("display-message", "-p", "-t", "first:", "#{window_id}"),
      beforeSelection,
    );
    assert.equal(
      (await listResources(source)).spaces.length,
      1,
      "helper sessions are hidden",
    );
    const helper = tmux("list-sessions", "-F", "#{session_name}")
      .split("\n")
      .find((s) => s.startsWith("__canvas_"))!;
    assert.equal(tmux("show-options", "-t", helper, "status"), "status off");
    assert.equal(
      tmux("list-windows", "-t", helper, "-F", "#{window_id}"),
      raw(one.id),
    );
    assert.equal(
      tmux("list-panes", "-t", raw(one.id), "-F", "#{pane_id}").split("\n")
        .length,
      2,
    );
    const env = {
      PATH: process.env.PATH!,
      HOME: root,
      SHELL: "/bin/sh",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      ...command.env,
    };
    terminal = pty.spawn(command.file, command.args, {
      name: "xterm-256color",
      cols: 90,
      rows: 25,
      cwd: root,
      env,
    });
    let output = "";
    terminal.onData((data) => {
      output += data;
    });
    const waitFor = async (check: () => boolean, message: string) => {
      for (let i = 0; i < 100; i++) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.fail(message);
    };
    await waitFor(
      () => output.length > 0,
      "native client produced no terminal output",
    );
    terminal.write("printf 'CANVAS_NATIVE_%s\\n' OK\r");
    await waitFor(
      () =>
        tmux("capture-pane", "-p", "-t", raw(one.id)).includes(
          "CANVAS_NATIVE_OK",
        ),
      "PTY input did not reach pane",
    );
    terminal.resize(112, 32);
    await command.resize!(112, 32);
    assert.equal(
      tmux(
        "display-message",
        "-p",
        "-t",
        raw(one.id),
        "#{window_width}x#{window_height}",
      ),
      "112x32",
    );
    assert.equal(
      tmux("display-message", "-p", "-t", "first:", "#{window_id}"),
      beforeSelection,
    );
    await command.cleanup();
    assert.equal(
      tmux("show-options", "-w", "-t", raw(one.id), "window-size"),
      initialPolicy,
      "size policy restored",
    );
    assert.equal(tmux("list-sessions", "-F", "#{session_name}"), "first");
    await renameSpace(source, space.id, "renamed space");
    await renameWindow(source, space.id, one.id, "name with 'quotes'");
    assert.equal(
      (await listResources(source)).spaces[0]!.name,
      "renamed space",
    );
    assert.equal(
      (await listResources(source)).spaces[0]!.windows.find(
        (w) => w.id === one.id,
      )!.name,
      "name with 'quotes'",
    );
    await renameWindow(source, space.id, one.id, "semi;");
    assert.equal(
      (await listResources(source)).spaces[0]!.windows.find(
        (w) => w.id === one.id,
      )!.name,
      "semi;",
    );
    await createWindow(source, space.id, "third");
    const third = (await listResources(source)).spaces[0]!.windows.find(
      (w) => w.name === "third",
    )!;
    await assert.rejects(
      openTerminal(source, "0.0:$0", third.id, 80, 24),
      /Space no longer exists/u,
    );
    await closeWindow(source, space.id, third.id);
    await createSpace(source, "second");
    const second = (await listResources(source)).spaces.find(
      (s) => s.name === "second",
    )!;
    await assert.rejects(
      closeWindow(source, second.id, one.id),
      /Window no longer belongs/u,
    );
    const orphan = await openTerminal(source, space.id, one.id, 80, 24);
    opened.push(orphan);
    tmux("kill-session", "-t", raw(space.id));
    await waitFor(
      () =>
        !tmux("list-sessions", "-F", "#{session_name}").includes("__canvas_"),
      "helper kept deleted source session alive",
    );
    await closeSpace(source, second.id);
    assert.deepEqual((await listResources(source)).spaces, []);
  } finally {
    terminal?.kill();
    await Promise.all(opened.map((command) => command.cleanup()));
    try {
      tmux("kill-server");
    } catch {
      /* Server can exit with its last session. */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("tmux cleanup preserves unexpected helper windows and external size policy changes", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "canvas-provider-cleanup-"));
  const socket = join(root, "socket");
  const source: Source = {
    id: "cleanup",
    name: "Cleanup",
    type: "tmux",
    transport: "local",
    tmuxSocket: socket,
  };
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  let command: Awaited<ReturnType<typeof openTerminal>> | undefined;
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "original");
    const space = (await listResources(source)).spaces[0]!;
    command = await openTerminal(
      source,
      space.id,
      space.windows[0]!.id,
      80,
      24,
    );
    const helper = tmux("list-sessions", "-F", "#{session_name}")
      .split("\n")
      .find((s) => s.startsWith("__canvas_"))!;
    tmux("new-window", "-d", "-t", `${helper}:`, "-n", "keep-me");
    const window = space.windows[0]!.id.split(":")[1]!;
    tmux("set-option", "-w", "-t", window, "window-size", "largest");
    await command.cleanup();
    const snapshot = await listResources(source);
    assert.equal(snapshot.spaces.length, 2);
    assert.ok(
      snapshot.spaces.some(
        (s) =>
          s.name.startsWith("canvas-detached-") &&
          s.windows.some((w) => w.name === "keep-me"),
      ),
    );
    assert.equal(
      tmux("show-options", "-w", "-t", window, "window-size"),
      "window-size largest",
    );
  } finally {
    await command?.cleanup();
    try {
      tmux("kill-server");
    } catch {
      /* Already stopped. */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("tmux named sockets and abrupt native client exit clean the helper", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const socketName = `canvas-test-${randomUUID()}`;
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-L", socketName, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const source: Source = {
    id: "named",
    name: "Named",
    type: "tmux",
    transport: "local",
    tmuxSocket: socketName,
  };
  let command: Awaited<ReturnType<typeof openTerminal>> | undefined;
  let terminal: pty.IPty | undefined;
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "original");
    const space = (await listResources(source)).spaces[0]!;
    assert.equal(space.name, "original");
    const window = space.windows[0]!.id.split(":")[1]!;
    const originalPolicy = tmux(
      "show-options",
      "-w",
      "-t",
      window,
      "window-size",
    );
    command = await openTerminal(
      source,
      space.id,
      space.windows[0]!.id,
      80,
      24,
    );
    terminal = pty.spawn(command.file, command.args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      env: {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        TERM: "xterm-256color",
      },
    });
    let attached = false;
    terminal.onData(() => {
      attached = true;
    });
    for (let i = 0; !attached && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(attached);
    terminal.kill();
    for (
      let i = 0;
      i < 100 &&
      tmux("list-sessions", "-F", "#{session_name}").includes("__canvas_");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      tmux("list-sessions", "-F", "#{session_name}"),
      "original",
      "native detach hook did not remove helper",
    );
    assert.equal(
      tmux("show-options", "-w", "-t", window, "window-size"),
      originalPolicy,
    );
  } finally {
    terminal?.kill();
    await command?.cleanup();
    try {
      tmux("kill-server");
    } catch {
      /* Already stopped. */
    }
  }
});
