/**
 * What the cell painter consumes: a window as a grid of styled runs. The shapes follow the cell
 * wire's decoded frame and patch, so a wire decoder adapts to them without reshaping rows.
 */

/** A colour is `CELL_DEFAULT`, 0xRRGGBB, or `CELL_PALETTE | index`. */
export const CELL_DEFAULT = -1
export const CELL_PALETTE = 0x1000000

/** Bits of `CellStyle.attrs`; the underline style (1 single … 5 dashed) sits at `UNDERLINE_SHIFT`. */
export const CELL_ATTR = {
  bold: 1,
  dim: 2,
  italic: 4,
  inverse: 8,
  invisible: 16,
  strike: 32,
  overline: 64,
  blink: 128,
  selected: 2048,
} as const
export const UNDERLINE_SHIFT = 8
export const UNDERLINE_MASK = 7 << UNDERLINE_SHIFT

export interface CellStyle {
  attrs: number
  fg: number
  bg: number
  /** The underline's own colour; `CELL_DEFAULT` follows the text. */
  underline: number
  /** 0 for none, else an index into the link table plus one. */
  link: number
}

/**
 * Consecutive cells of one style. `text` is ASCII, one cell per character, with blanks as spaces.
 * `clusters` holds one grapheme cluster per cell, or per two cells when `wide`.
 */
export type CellRun =
  { style: number; text: string } | { style: number; clusters: readonly string[]; wide: boolean }

export type CellCursorShape = 'block' | 'bar' | 'underline'

export interface CellCursor {
  x: number
  y: number
  shape: CellCursorShape
  visible: boolean
  blink: boolean
}

/** The whole window. It replaces the style and link tables. */
export interface CellFrame {
  revision: number
  cols: number
  rows: number
  foreground: number
  background: number
  /** 256 colours; without one the theme's palette applies. */
  palette?: readonly number[] | null
  cursor: CellCursor
  styles: readonly CellStyle[]
  links: readonly string[]
  /** One list of runs per row; each covers every column. */
  lines: readonly (readonly CellRun[])[]
}

/** Changed rows on top of revision `base`. Its styles and links are appended to the tables. */
export interface CellPatch {
  revision: number
  base: number
  cursor: CellCursor
  styles: readonly CellStyle[]
  links: readonly string[]
  /** Rows the grid moved up before `rows` apply. */
  scroll: number
  rows: readonly { y: number; runs: readonly CellRun[] }[]
}

/** The cells a run covers. */
export function runCells(run: CellRun): number {
  return 'text' in run ? run.text.length : run.clusters.length * (run.wide ? 2 : 1)
}
