import type { Terminal } from "@xterm/headless";

/** SerializeAddon restores mouse tracking but omits its wire encoding. */
export class TerminalMouseEncoding {
  private encoding: "default" | "sgr" | "pixels" = "default";

  constructor(terminal: Terminal) {
    for (const [final, enabled] of [
      ["h", true],
      ["l", false],
    ] as const) {
      terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        for (const param of params) {
          if (param === 1006 || param === 1016)
            this.encoding = enabled
              ? param === 1006
                ? "sgr"
                : "pixels"
              : "default";
        }
        return false; // Observe; xterm still applies the actual mode.
      });
    }
    terminal.parser.registerEscHandler({ final: "c" }, () => {
      this.encoding = "default";
      return false;
    });
  }

  serialize(): string {
    // Explicit reset also repairs clients reconnecting with stale mouse modes.
    return (
      "\x1b[?1006l\x1b[?1016l" +
      (this.encoding === "sgr"
        ? "\x1b[?1006h"
        : this.encoding === "pixels"
          ? "\x1b[?1016h"
          : "")
    );
  }
}
