/** Untransformed CSS boxes retain the fractional dimensions lost by client/offset sizes. */
export function terminalBox(element: HTMLElement) {
  const style = getComputedStyle(element)
  const horizontal = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
  const vertical = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
  const width = parseFloat(style.width), height = parseFloat(style.height)
  return style.boxSizing === 'border-box'
    ? { width, height, contentWidth: width - horizontal, contentHeight: height - vertical }
    : { width: width + horizontal, height: height + vertical, contentWidth: width, contentHeight: height }
}

export function fitTerminalGrid(available: { width: number; height: number }, rendered: { width: number; height: number; cols: number; rows: number }) {
  return {
    cols: Math.max(2, Math.min(500, Math.floor(available.width * rendered.cols / rendered.width))),
    rows: Math.max(1, Math.min(200, Math.floor(available.height * rendered.rows / rendered.height))),
  }
}

export interface RenderedTerminalGrid { width: number; height: number; cols: number; rows: number }
export type TerminalGrid = Pick<RenderedTerminalGrid, 'cols' | 'rows'>

export function sameTerminalGrid(a: TerminalGrid | undefined, b: TerminalGrid | undefined): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows
}

/** A parsed frame becomes visible only after its entire matching viewport paints. */
export function terminalFrameReady(frame: TerminalGrid | undefined, grid: TerminalGrid, paint: { start: number; end: number }): boolean {
  return sameTerminalGrid(frame, grid) && paint.start === 0 && paint.end === grid.rows - 1
}

export function containTerminalScale(available: { width: number; height: number }, content: { width: number; height: number }, upscale = false): number {
  return Math.min(upscale ? Infinity : 1, available.width / content.width, available.height / content.height)
}

/** DOM renderer totals are pixel-rounded. Resizing the grid must not turn that
 * rounding back into a new cell metric and alternate between adjacent grids. */
export function terminalMetrics(reference: RenderedTerminalGrid | undefined,
  previous: RenderedTerminalGrid | undefined, next: RenderedTerminalGrid): RenderedTerminalGrid {
  return !reference || previous && previous.cols === next.cols && previous.rows === next.rows &&
    (previous.width !== next.width || previous.height !== next.height) ? next : reference
}
