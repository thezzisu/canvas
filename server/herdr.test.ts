import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
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
  shellQuote,
  type Source,
} from "./providers.ts";

test("herdr client works with an unmodified server: split rendering, keyboard, mouse and PTY resize", async (t) => {
  const binary = process.env.CANVAS_TEST_HERDR_BINARY;
  const serverBinary = process.env.CANVAS_TEST_HERDR_SERVER_BINARY;
  if (!binary || !serverBinary) {
    t.skip(
      "Set CANVAS_TEST_HERDR_BINARY to the client fork and CANVAS_TEST_HERDR_SERVER_BINARY to an unmodified upstream server",
    );
    return;
  }
  assert.notEqual(
    realpathSync(binary),
    realpathSync(serverBinary),
    "Compatibility requires a separate unmodified server binary",
  );
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
  const requests = join(root, "client-requests");
  const recordedClient = join(root, "herdr-client");
  writeFileSync(
    recordedClient,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(requests)}
exec ${shellQuote(binary)} "$@"
`,
    { mode: 0o700 },
  );
  const source: Source = {
    id: "herdr-test",
    name: "Herdr test",
    type: "herdr",
    transport: "local",
    binary: recordedClient,
    herdrSession: session,
  };
  const server = spawn(serverBinary, ["--session", session, "server"], {
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
  const assertSplitGeometry = async (cols: number, rows: number) => {
    await waitFor(() => {
      const top =
        screen.buffer.active.getLine(0)?.translateToString(false, 0, cols) ??
        "";
      const bottom =
        screen.buffer.active
          .getLine(rows - 1)
          ?.translateToString(false, 0, cols) ?? "";
      return (
        top.startsWith("┌") &&
        top.endsWith("┐") &&
        top.length === cols &&
        bottom.startsWith("└") &&
        bottom.endsWith("┘") &&
        bottom.length === cols
      );
    }, "bare tab frame did not reach every edge of the native viewport");
  };
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
    assert.equal(command.geometryMode, "client");
    assert.equal(command.readSize, undefined);
    assert.equal(command.resize, undefined);
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
    await assertSplitGeometry(90, 25);
    terminal.write("printf 'HERDR_NATIVE_%s\\n' OK\r");
    await waitFor(
      () => screenText().includes("HERDR_NATIVE_OK"),
      "bare herdr client did not accept native input",
    );
    screen.resize(112, 32);
    terminal.resize(112, 32);
    data = snapshot();
    assert.equal(
      data.panes.filter((p: { tab_id: string }) => p.tab_id === window.id)
        .length,
      2,
    );
    await assertSplitGeometry(112, 32);
    // SGR mouse reports select each native pane; keyboard input must follow it.
    terminal.write("\x1b[<0;5;3M\x1b[<0;5;3m");
    terminal.write("printf 'LEFT_%s\\n' MOUSE\r");
    await waitFor(
      () => screenText().includes("LEFT_MOUSE"),
      "mouse did not select the left pane",
    );
    // Each half reserves two border columns and one native scrollbar column.
    terminal.write("printf 'LEFT_TTY_%s\\n' \"$(stty size)\"\r");
    await waitFor(
      () => screenText().includes("LEFT_TTY_30 53"),
      "left pane PTY did not fill its half of the resized tab",
    );
    terminal.write("\x1b[<0;80;3M\x1b[<0;80;3m");
    terminal.write("printf 'RIGHT_%s\\n' MOUSE\r");
    await waitFor(
      () => screenText().includes("RIGHT_MOUSE"),
      "mouse did not select the right pane",
    );
    const leftText = () =>
      Array.from(
        { length: screen.rows },
        (_, i) =>
          screen.buffer.active.getLine(i)?.translateToString(true, 0, 56) ?? "",
      ).join("\n");
    const rightText = () =>
      Array.from(
        { length: screen.rows },
        (_, i) =>
          screen.buffer.active.getLine(i)?.translateToString(true, 56, 112) ??
          "",
      ).join("\n");
    assert.ok(leftText().includes("LEFT_MOUSE"));
    assert.ok(!leftText().includes("RIGHT_MOUSE"));
    assert.ok(rightText().includes("RIGHT_MOUSE"));
    assert.ok(!rightText().includes("LEFT_MOUSE"));
    terminal.write("printf 'RIGHT_TTY_%s\\n' \"$(stty size)\"\r");
    await waitFor(
      () => screenText().includes("RIGHT_TTY_30 53"),
      "right pane PTY did not fill its half of the resized tab",
    );
    screen.resize(70, 18);
    terminal.resize(70, 18);
    await assertSplitGeometry(70, 18);
    screen.resize(112, 32);
    terminal.resize(112, 32);
    await assertSplitGeometry(112, 32);
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
    const invocationLog = readFileSync(requests, "utf8");
    assert.equal(
      invocationLog
        .split("\n")
        .filter((line) => /tab attach .* --bare$/u.test(line)).length,
      2,
    );
    assert.doesNotMatch(
      invocationLog,
      /(?:--follow-size|--expected-revision|--expected-boot-id|--operation-id|tab geometr(?:y|ies)|tab resize)/u,
      "Client integration invoked a server extension",
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
