import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { TerminalMouseEncoding } from "./terminal-modes.ts";

test("late terminal replay preserves mouse encoding across fragmented mode changes and reset", async () => {
  const source = new headless.Terminal({ allowProposedApi: true });
  const addon = new serialize.SerializeAddon();
  source.loadAddon(addon);
  const mouse = new TerminalMouseEncoding(source);
  const write = (
    terminal: InstanceType<typeof headless.Terminal>,
    data: string,
  ) => new Promise<void>((resolve) => terminal.write(data, resolve));
  const mode = async (
    terminal: InstanceType<typeof headless.Terminal>,
    code: number,
  ) => {
    let response = "";
    const sub = terminal.onData((data) => {
      response += data;
    });
    await write(terminal, `\x1b[?${code}$p`);
    sub.dispose();
    return response;
  };
  try {
    for (const [chunks, expected] of [
      [["\x1b[?1003;10", "06h"], 1006],
      [["\x1b[?1016h"], 1016],
      [["\x1b[?1016l"], 0],
      [["\x1b[?1006h", "\x1bc"], 0],
    ] as const) {
      for (const chunk of chunks) await write(source, chunk);
      const replay = new headless.Terminal({ allowProposedApi: true });
      try {
        await write(replay, addon.serialize() + mouse.serialize());
        for (const code of [1006, 1016])
          assert.equal(
            await mode(replay, code),
            `\x1b[?${code};${code === expected ? 1 : 2}$y`,
          );
        assert.equal(
          replay.modes.mouseTrackingMode,
          source.modes.mouseTrackingMode,
        );
      } finally {
        replay.dispose();
      }
    }
  } finally {
    source.dispose();
  }
});
