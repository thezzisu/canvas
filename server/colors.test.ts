import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import {
  listResources,
  openTerminal,
  shellQuote,
  type Source,
} from "./providers.ts";

test("tmux preserves application colors and replay, while respecting the pane environment", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "canvas-colors-"));
  const socket = join(root, "socket");
  // Reproduce a server launched from a noninteractive automation environment.
  // The native client having truecolor support must not override a pane's
  // explicit NO_COLOR preference. Fixing that environment restores app colors.
  const env: Record<string, string> = {
    PATH: process.env.PATH!,
    HOME: root,
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  };
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const source: Source = {
    id: "colors",
    name: "Colors",
    type: "tmux",
    transport: "local",
    tmuxSocket: socket,
  };
  const script = join(root, "sample.cjs");
  writeFileSync(
    script,
    `const depth = process.stdout.getColorDepth();
process.stdout.write("\\x1b[2J\\x1b[HDEPTH=" + depth + "\\r\\n");
const colors = [["ANSI_RED", "31"], ["PALETTE_ORANGE", "38;5;208"], ["RGB_GREEN", "38;2;12;171;94"]];
for (const [word, sgr] of colors) {
  process.stdout.write((depth > 1 ? "\\x1b[" + sgr + "m" : "") + word + "\\x1b[0m\\r\\n");
}
`,
  );
  const screen = new headless.Terminal({
    cols: 80,
    rows: 24,
    allowProposedApi: true,
  });
  const replay = new headless.Terminal({
    cols: 80,
    rows: 24,
    allowProposedApi: true,
  });
  const serializer = new serialize.SerializeAddon();
  screen.loadAddon(serializer);
  const text = () =>
    Array.from(
      { length: screen.buffer.active.length },
      (_, y) => screen.buffer.active.getLine(y)?.translateToString(true) ?? "",
    ).join("\n");
  const waitFor = async (check: () => boolean, message: string) => {
    for (let i = 0; i < 150; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(message);
  };
  let command: Awaited<ReturnType<typeof openTerminal>> | undefined;
  let terminal: pty.IPty | undefined;
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "colors", "/bin/sh");
    const space = (await listResources(source)).spaces[0]!;
    command = await openTerminal(
      source,
      space.id,
      space.windows[0]!.id,
      80,
      24,
    );
    assert.ok(!command.connect);
    terminal = pty.spawn(command.file, command.args, {
      name: "xterm-256color",
      cwd: root,
      cols: 80,
      rows: 24,
      env: {
        PATH: env.PATH!,
        HOME: root,
        SHELL: "/bin/sh",
        TERM: "xterm-256color",
        ...command.env,
      },
    });
    terminal.onData((data) => screen.write(data));
    screen.onData((data) => terminal?.write(data));
    const launch = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    terminal.write(`${launch}\r`);
    await waitFor(
      () => text().includes("DEPTH=1\n"),
      "NO_COLOR did not disable app colors",
    );
    await waitFor(
      () => text().includes("RGB_GREEN"),
      "application did not finish drawing",
    );
    assert.equal(
      screen.buffer.active.getLine(1)!.getCell(0)!.isFgDefault(),
      true,
    );
    terminal.write(`unset NO_COLOR; ${launch}\r`);
    await waitFor(
      () => text().includes("DEPTH=24\n"),
      "truecolor support was not restored",
    );
    await waitFor(
      () => screen.buffer.active.getLine(3)?.getCell(0)?.isFgRGB() === true,
      "native client did not preserve RGB color",
    );
    await new Promise<void>((resolve) =>
      replay.write(serializer.serialize(), resolve),
    );
    for (const rendered of [screen, replay]) {
      const red = rendered.buffer.active.getLine(1)!.getCell(0)!;
      const orange = rendered.buffer.active.getLine(2)!.getCell(0)!;
      const green = rendered.buffer.active.getLine(3)!.getCell(0)!;
      assert.equal(red.isFgPalette(), true);
      assert.equal(red.getFgColor(), 1);
      assert.equal(orange.isFgPalette(), true);
      assert.equal(orange.getFgColor(), 208);
      assert.equal(green.isFgRGB(), true);
      assert.equal(green.getFgColor(), 0x0cab5e);
    }
  } finally {
    terminal?.kill();
    await command?.cleanup();
    screen.dispose();
    replay.dispose();
    try {
      tmux("kill-server");
    } catch {
      /* Already stopped. */
    }
    rmSync(root, { recursive: true, force: true });
  }
});
