/** The outer surface carries semantic client input; child panes own their modes. */
export const terminalSurfaceModes =
  '\x1b[?1049h\x1b[?7l\x1b[?1h\x1b[?2004h\x1b[?1003h\x1b[?1016l\x1b[?1006h\x1b[?1004h'

/** Only complete SGR no-button motion is passive; mixed/partial input stays ordered. */
export function isTerminalHoverInput(data: string): boolean {
  return /^(?:\x1b\[<(?:35|39|43|47|51|55|59|63);[1-9]\d*;[1-9]\d*M)+$/u.test(data)
}
