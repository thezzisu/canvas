import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import headless from "@xterm/headless";
import {
  createSpace,
  createWindow,
  renameSpace,
  renameWindow,
  closeSpace,
  closeWindow,
  listResources,
  openTerminal,
  type Source,
} from "./providers.ts";

test("herdr adapter displays a complete bare tab, accepts input and resizes", async (t) => {
  const binary = process.env.CANVAS_TEST_HERDR_BINARY;
  if (!binary) {
    t.skip(
      "Set CANVAS_TEST_HERDR_BINARY to the Canvas herdr fork to run native integration",
    );
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "canvas-herdr-test-"));
  const before = {
    config: process.env.XDG_CONFIG_HOME,
    state: process.env.XDG_STATE_HOME,
  };
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_STATE_HOME = join(root, "state");
  for (const flavor of ["herdr", "herdr-dev"]) {
    mkdirSync(join(root, "config", flavor), { recursive: true });
    writeFileSync(
      join(root, "config", flavor, "config.toml"),
      'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n',
    );
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH!,
    HOME: root,
    USER: process.env.USER ?? "test",
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
  const session = "canvas-test";
  const cli = (...args: string[]) =>
    execFileSync(binary, ["--session", session, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
  const source: Source = {
    id: "herdr-test",
    name: "Herdr test",
    type: "herdr",
    transport: "local",
    binary,
    herdrSession: session,
  };
  const server = spawn(binary, ["--session", session, "server"], {
    env,
    stdio: "ignore",
  });
  let terminal: pty.IPty | undefined;
  let secondTerminal: pty.IPty | undefined;
  let command: Awaited<ReturnType<typeof openTerminal>> | undefined;
  let secondCommand: Awaited<ReturnType<typeof openTerminal>> | undefined;
  const screen = new headless.Terminal({
    cols: 90,
    rows: 25,
    allowProposedApi: true,
  });
  const screenText = () =>
    Array.from(
      { length: screen.buffer.active.length },
      (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) ?? "",
    ).join("\n");
  const secondScreen = new headless.Terminal({
    cols: 90,
    rows: 25,
    allowProposedApi: true,
  });
  const secondText = () =>
    Array.from(
      { length: secondScreen.buffer.active.length },
      (_, i) =>
        secondScreen.buffer.active.getLine(i)?.translateToString(true) ?? "",
    ).join("\n");
  const waitFor = async (
    check: () => boolean | Promise<boolean>,
    message: string,
  ) => {
    for (let i = 0; i < 150; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.fail(`${message}: ${screenText()}`);
  };
  const snapshot = () => JSON.parse(cli("api", "snapshot")).result.snapshot;
  try {
    await waitFor(
      async () => (await listResources(source)).status === "online",
      "isolated herdr server did not start",
    );
    await createSpace(source, "Synthetic");
    let space = (await listResources(source)).spaces.find(
      (s) => s.name === "Synthetic",
    )!;
    assert.ok(space);
    const window = space.windows[0]!;
    let data = snapshot();
    const pane = data.panes.find(
      (p: { tab_id: string }) => p.tab_id === window.id,
    );
    cli("pane", "split", pane.pane_id, "--direction", "right");
    data = snapshot();
    const nativePanes = data.panes.filter(
      (p: { tab_id: string }) => p.tab_id === window.id,
    );
    cli(
      "pane",
      "report-agent",
      nativePanes[0].pane_id,
      "--source",
      "canvas-test",
      "--agent",
      "fixture",
      "--state",
      "working",
    );
    cli(
      "pane",
      "report-agent",
      nativePanes[1].pane_id,
      "--source",
      "canvas-test",
      "--agent",
      "fixture",
      "--state",
      "blocked",
    );
    const statusWindow = (await listResources(source)).spaces
      .find((s) => s.id === space.id)!
      .windows.find((w) => w.id === window.id)!;
    assert.equal(statusWindow.panes.length, 2);
    assert.equal(
      statusWindow.panes.find((p) => p.id === nativePanes[0].pane_id)!.status,
      "working",
    );
    assert.equal(
      statusWindow.panes.find((p) => p.id === nativePanes[1].pane_id)!.status,
      "attention",
    );
    assert.equal(statusWindow.status, "attention");
    assert.equal(statusWindow.statusSource, "herdr");

    await createWindow(source, space.id, "Other tab");
    const other = (await listResources(source)).spaces
      .find((s) => s.id === space.id)!
      .windows.find((w) => w.name === "Other tab")!;
    cli("tab", "focus", other.id);
    command = await openTerminal(source, space.id, window.id, 90, 25);
    terminal = pty.spawn(command.file, command.args, {
      cols: 90,
      rows: 25,
      name: "xterm-256color",
      cwd: root,
      env: { ...env, ...command.env },
    });
    terminal.onData((chunk) => {
      screen.write(chunk);
    });
    await waitFor(
      () => screenText().includes("sh-"),
      "bare herdr client produced no shell frame",
    );
    terminal.write("printf 'HERDR_NATIVE_%s\\n' OK\r");
    await waitFor(
      () => screenText().includes("HERDR_NATIVE_OK"),
      "bare herdr client did not accept native input",
    );
    screen.resize(112, 32);
    terminal.resize(112, 32);
    await waitFor(
      () =>
        snapshot().layouts.some(
          (layout: {
            tab_id: string;
            area: { width: number; height: number };
          }) =>
            layout.tab_id === window.id &&
            layout.area.width === 112 &&
            layout.area.height === 32,
        ),
      "bare herdr tab did not resize to full viewport",
    );
    data = snapshot();
    assert.equal(
      data.panes.filter((p: { tab_id: string }) => p.tab_id === window.id)
        .length,
      2,
    );
    secondCommand = await openTerminal(source, space.id, other.id, 90, 25);
    secondTerminal = pty.spawn(secondCommand.file, secondCommand.args, {
      cols: 90,
      rows: 25,
      name: "xterm-256color",
      cwd: root,
      env: { ...env, ...secondCommand.env },
    });
    secondTerminal.onData((chunk) => secondScreen.write(chunk));
    await waitFor(
      () => secondText().includes("sh-"),
      "second bare tab produced no shell frame",
    );
    secondTerminal.write("printf 'SECOND_TAB_%s\\n' ONLY\r");
    await waitFor(
      () => secondText().includes("SECOND_TAB_ONLY"),
      "second bare tab input did not reach its window",
    );
    terminal.write("printf 'FIRST_TAB_%s\\n' ONLY\r");
    await waitFor(
      () => screenText().includes("FIRST_TAB_ONLY"),
      "first bare tab lost its pinned input target",
    );
    assert.ok(
      !screenText().includes("SECOND_TAB_ONLY"),
      "second tab output leaked to first",
    );
    assert.ok(
      !secondText().includes("FIRST_TAB_ONLY"),
      "first tab output leaked to second",
    );
    await renameSpace(source, space.id, "Renamed space");
    await renameWindow(source, space.id, window.id, "Renamed tab");
    space = (await listResources(source)).spaces.find(
      (s) => s.id === space.id,
    )!;
    assert.equal(space.name, "Renamed space");
    assert.equal(
      space.windows.find((w) => w.id === window.id)!.name,
      "Renamed tab",
    );
    await closeWindow(source, space.id, other.id);
    await closeSpace(source, space.id);
    assert.ok(
      !(await listResources(source)).spaces.some((s) => s.id === space.id),
    );
  } finally {
    terminal?.kill();
    secondTerminal?.kill();
    await command?.cleanup();
    await secondCommand?.cleanup();
    try {
      cli("server", "stop");
    } catch {
      /* Already stopped. */
    }
    server.kill();
    if (before.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before.config;
    if (before.state === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = before.state;
    screen.dispose();
    secondScreen.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
