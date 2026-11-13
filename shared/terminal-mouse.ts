/** Only complete SGR no-button motion is passive; mixed/partial input stays ordered. */
export function isTerminalHoverInput(data: string): boolean {
  return /^(?:\x1b\[<(?:35|39|43|47|51|55|59|63);[1-9]\d*;[1-9]\d*M)+$/u.test(data)
}
