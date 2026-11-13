export interface TerminalGrid {
  cols: number
  rows: number
}
export function sameTerminalGrid(
  a: TerminalGrid | undefined,
  b: TerminalGrid | undefined,
): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows
}

/**
 * The largest grid of `cell`-sized cells that fits, within what a window may be. A box that is
 * a whole number of cells keeps them all, whatever the division rounds to.
 */
export function fitTerminalGrid(
  available: { width: number; height: number },
  cell: { width: number; height: number },
): TerminalGrid {
  const count = (length: number, each: number) => Math.floor(length / each + 1e-6)
  return {
    cols: Math.max(2, Math.min(500, count(available.width, cell.width))),
    rows: Math.max(1, Math.min(200, count(available.height, cell.height))),
  }
}

export function containTerminalScale(
  available: { width: number; height: number },
  content: { width: number; height: number },
  upscale = false,
): number {
  return Math.min(
    upscale ? Infinity : 1,
    available.width / content.width,
    available.height / content.height,
  )
}
