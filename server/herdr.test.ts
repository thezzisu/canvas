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
  NativeGeometryConflictError,
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
  let externalTerminal: pty.IPty | undefined;
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
  const nativeGeometry = (tabId: string) =>
    JSON.parse(cli("tab", "geometry", tabId)).result.geometry;
  const assertSplitGeometry = async (
    tabId: string,
    cols: number,
    rows: number,
  ) => {
    await waitFor(() => {
      const geometry = nativeGeometry(tabId);
      return geometry.cols === cols && geometry.rows === rows;
    }, "split panes did not cover the complete native viewport");
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
    const originalGeometry = await command.readSize!();
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
    assert.equal(
      (await command.readSize!()).token,
      originalGeometry.token,
      "opening the passive view changed native geometry",
    );
    await command.resize!(90, 25);
    await command.commitSize!();
    await assertSplitGeometry(window.id, 90, 25);
    terminal.write("printf 'HERDR_NATIVE_%s\\n' OK\r");
    await waitFor(
      () => screenText().includes("HERDR_NATIVE_OK"),
      "bare herdr client did not accept native input",
    );
    screen.resize(112, 32);
    terminal.resize(112, 32);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      nativeGeometry(window.id).cols,
      90,
      "passive PTY resize changed native geometry",
    );
    await command.resize!(112, 32);
    await command.commitSize!();
    await waitFor(
      () =>
        nativeGeometry(window.id).cols === 112 &&
        nativeGeometry(window.id).rows === 32,
      "bare herdr tab did not resize to full viewport",
    );
    data = snapshot();
    assert.equal(
      data.panes.filter((p: { tab_id: string }) => p.tab_id === window.id)
        .length,
      2,
    );
    await assertSplitGeometry(window.id, 112, 32);
    screen.resize(70, 18);
    terminal.resize(70, 18);
    await command.resize!(70, 18);
    await command.commitSize!();
    await assertSplitGeometry(window.id, 70, 18);
    screen.resize(112, 32);
    terminal.resize(112, 32);
    await command.resize!(112, 32);
    await command.commitSize!();
    await assertSplitGeometry(window.id, 112, 32);
    secondCommand = await openTerminal(source, space.id, other.id, 90, 25);
    await secondCommand.resize!(90, 25);
    await secondCommand.commitSize!();
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
    externalTerminal = pty.spawn(
      binary,
      ["--session", session, "tab", "attach", window.id, "--bare"],
      {
        cols: 100,
        rows: 28,
        name: "xterm-256color",
        cwd: root,
        env,
      },
    );
    externalTerminal.onData(() => {});
    await waitFor(
      () =>
        nativeGeometry(window.id).cols === 100 &&
        nativeGeometry(window.id).rows === 28,
      "external native client did not control tab geometry",
    );
    const externalBeforeInput = await command.readSize!();
    terminal.write("printf 'PASSIVE_INPUT_%s\\n' OK\r");
    await waitFor(
      () => screenText().includes("PASSIVE_INPUT_OK"),
      "passive view input did not reach its pane",
    );
    assert.equal(
      (await command.readSize!()).token,
      externalBeforeInput.token,
      "passive input stole geometry from the native client",
    );
    const focused = await command.resize!(150, 45, externalBeforeInput.token);
    externalTerminal.resize(130, 38);
    await waitFor(
      () =>
        nativeGeometry(window.id).cols === 130 &&
        nativeGeometry(window.id).rows === 38,
      "external native resize did not take over focused geometry",
    );
    const external = await command.restoreSize!(
      externalBeforeInput,
      focused.token,
    );
    assert.equal(
      `${external.cols}x${external.rows}`,
      "130x38",
      "collapse overwrote newer external geometry",
    );
    const next = await command.resize!(150, 45, external.token);
    cli("tab", "resize", window.id, "--cols", "140", "--rows", "40");
    cli("tab", "resize", window.id, "--cols", "150", "--rows", "45");
    assert.notEqual(
      (await command.readSize!()).token,
      next.token,
      "A→B→A native geometry changes lost their revision",
    );
    await command.restoreSize!(external, next.token);
    assert.equal(nativeGeometry(window.id).cols, 150);
    const receiptWrapper = join(root, "herdr-response-loss");
    const receiptArmed = join(root, "receipt-armed");
    writeFileSync(
      receiptWrapper,
      `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2), armed=${JSON.stringify(receiptArmed)}, real=${JSON.stringify(binary)};
const result=cp.spawnSync(real,args,{encoding:'utf8'});
if (result.status===0 && args.includes('--operation-id') && fs.existsSync(armed)) {
 const mode=fs.readFileSync(armed,'utf8');fs.unlinkSync(armed);
 if (mode==='external') { const external=args.slice(0,args.indexOf('--expected-revision'));cp.execFileSync(real,external,{stdio:'ignore'}); }
 process.stderr.write('synthetic response loss after native resize');process.exit(75);
}
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);
`,
      { mode: 0o700 },
    );
    const receiptCommand = await openTerminal(
      { ...source, id: "herdr-receipt", binary: receiptWrapper },
      space.id,
      other.id,
      90,
      25,
    );
    try {
      const receiptBaseline = await receiptCommand.readSize!(true);
      writeFileSync(receiptArmed, "drop");
      const recovered = await receiptCommand.resize!(
        140,
        40,
        receiptBaseline.token,
      );
      assert.equal(recovered.recoveredFromToken, receiptBaseline.token);
      assert.ok(recovered.operationId);
      const restoredReceipt = await receiptCommand.restoreSize!(
        receiptBaseline,
        recovered.token,
      );
      assert.equal(
        `${restoredReceipt.cols}x${restoredReceipt.rows}`,
        `${receiptBaseline.cols}x${receiptBaseline.rows}`,
      );
      const receiptExternalBaseline = await receiptCommand.readSize!(true);
      writeFileSync(receiptArmed, "external");
      await assert.rejects(
        receiptCommand.resize!(140, 40, receiptExternalBaseline.token),
        NativeGeometryConflictError,
      );
      const receiptExternal = await receiptCommand.readSize!(true);
      assert.equal(`${receiptExternal.cols}x${receiptExternal.rows}`, "140x40");
      assert.equal(receiptExternal.recoveredFromToken, undefined);
    } finally {
      await receiptCommand.cleanup();
    }
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
    externalTerminal?.kill();
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
