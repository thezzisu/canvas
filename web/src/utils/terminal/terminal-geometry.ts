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

/**
 * Where a frame goes in its host, from its top left corner.
 *
 * A view that asks for the window's size shows text at its own font, whatever frame it has: the
 * frame's bottom row sits where the bottom row of the asked grid will be, a taller frame is cut
 * at the top and a wider one at the right, and the frame that answers lands on the same rows.
 *
 * Every other view is a projection of a window sized elsewhere: the whole frame, scaled to fit.
 */
export function placeFrame(view: {
  frame: { width: number; height: number }
  available: { width: number; height: number }
  /** The rows of the grid a view asks for, with its cell's height; none for a projection. */
  asked?: { rows: number; cellHeight: number }
  /** A projection may grow to fill a maximized view; a card shows it at most at its size. */
  upscale: boolean
}): { scale: number; top: number } {
  return view.asked
    ? { scale: 1, top: view.asked.rows * view.asked.cellHeight - view.frame.height }
    : { scale: containTerminalScale(view.available, view.frame, view.upscale), top: 0 }
}
