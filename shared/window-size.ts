import { defaultTerminalCell, type TerminalCell } from './settings.ts'

/** Normal cards reserve two borders and the 30px header; zoom/cutouts are local. */
export const normalTerminalChrome = { width: 2, height: 32 } as const
const cell = defaultTerminalCell()
export const defaultWindowSize = {
  width: Math.ceil(150 * cell.width) + normalTerminalChrome.width,
  height: 40 * cell.height + normalTerminalChrome.height,
} as const

/** The shared normal viewport is independent of any browser's input ownership. */
export function normalTerminalGrid(size: { width: number; height: number }, cell: TerminalCell) {
  return {
    cols: Math.max(
      2,
      Math.min(500, Math.floor((size.width - normalTerminalChrome.width) / cell.width)),
    ),
    rows: Math.max(
      1,
      Math.min(200, Math.floor((size.height - normalTerminalChrome.height) / cell.height)),
    ),
  }
}
