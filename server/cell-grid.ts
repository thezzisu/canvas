import {
  ATTR,
  CellTables,
  DEFAULT_COLOUR,
  PALETTE_COLOUR,
  RowEncoder,
  UNDERLINE_SHIFT,
  encodeFrame,
  encodePatch,
  type CellCursor,
} from '../shared/cell-wire.ts'
import { terminalCellWidth } from '../shared/terminal-unicode.ts'
import { SELECTED } from './herdr/screen.ts'
import type { CellData, FrameData } from './herdr/wire.ts'

/** A stream whose tables outgrow this starts over with a FRAME. */
export const TABLE_LIMIT = 8192
const controls = /[\x00-\x1f\x7f-\x9f]/gu
const MODIFIERS = [
  [1, ATTR.bold],
  [2, ATTR.dim],
  [4, ATTR.italic],
  [16, ATTR.blink],
  [32, ATTR.rapidBlink],
  [64, ATTR.inverse],
  [128, ATTR.invisible],
  [256, ATTR.strike],
  [SELECTED, ATTR.selected],
] as const

function attrs(modifier: number): number {
  let value = 0
  for (const [bit, attr] of MODIFIERS) if (modifier & bit) value |= attr
  if (modifier & 8) {
    const style = modifier >>> 12
    value |= (style >= 2 && style <= 5 ? style : 1) << UNDERLINE_SHIFT
  }
  return value
}
/** Herdr colours: tag 2 is RGB, 1 a palette index, 0 a name (0 default, 1–16 the ANSI colours). */
function colour(value: number): number {
  const tag = value >>> 24
  if (tag === 2) return value & 0xffffff
  if (tag === 1) return PALETTE_COLOUR | (value & 255)
  const named = value & 255
  return named === 0 || named > 16 ? DEFAULT_COLOUR : PALETTE_COLOUR | (named - 1)
}
function link(grid: FrameData, cell: CellData): string {
  const value = cell.hyperlink === null ? '' : grid.hyperlinks[cell.hyperlink] || ''
  return value.length <= 8192 && !/[\x00-\x20\x7f-\x9f]/u.test(value) ? value : ''
}
function sameRow(before: FrameData, after: FrameData, y: number): boolean {
  const end = (y + 1) * after.width
  for (let index = y * after.width; index < end; index++) {
    const a = before.cells[index]!,
      b = after.cells[index]!
    const same =
      a === b ||
      (a.symbol === b.symbol &&
        a.fg === b.fg &&
        a.bg === b.bg &&
        a.modifier === b.modifier &&
        a.skip === b.skip)
    // A link index means its target in that grid's own list.
    if (!same || ((a.hyperlink ?? b.hyperlink) !== null && link(before, a) !== link(after, b)))
      return false
  }
  return true
}
function cursor(grid: FrameData): CellCursor {
  const value = grid.cursor
  if (!value || value.x >= grid.width || value.y >= grid.height)
    return { x: 0, y: 0, visible: false, blink: false, shape: 'block' }
  // DECSCUSR: 0–2 block, 3–4 underline, 5–6 bar; 0 and the odd ones blink.
  const shape = value.shape <= 6 ? value.shape : 0
  return {
    x: value.x,
    y: value.y,
    visible: value.visible,
    blink: shape === 0 || shape % 2 === 1,
    shape: shape <= 2 ? 'block' : shape <= 4 ? 'underline' : 'bar',
  }
}
const sameCursor = (a: CellCursor, b: CellCursor) =>
  a.x === b.x &&
  a.y === b.y &&
  a.visible === b.visible &&
  a.blink === b.blink &&
  a.shape === b.shape

/**
 * One browser's stream of a window's composed grid. Each message takes the browser from the
 * grid it was last sent to the one given, so grids in between are never encoded.
 */
export class GridEncoder {
  private sent?: { grid: FrameData; cursor: CellCursor; revision: number }
  private readonly tables = new CellTables()
  private readonly row = new RowEncoder()

  /** The browser no longer shows what it was sent; its next message is a FRAME. */
  reset() {
    this.sent = undefined
  }
  /** A FRAME or a PATCH, or nothing when the browser already shows this grid. */
  encode(grid: FrameData, revision: number): Uint8Array | undefined {
    const sent = this.sent
    if (sent?.grid === grid) return
    const next = cursor(grid)
    const frame =
      !sent ||
      sent.grid.width !== grid.width ||
      sent.grid.height !== grid.height ||
      this.tables.styles.length > TABLE_LIMIT ||
      this.tables.links.length > TABLE_LIMIT
    if (frame) this.tables.clear()
    const links = this.tables.links.length,
      styles = this.tables.styles.length,
      lines = []
    for (let y = 0; y < grid.height; y++)
      if (frame || !sameRow(sent.grid, grid, y)) lines.push({ y, runs: this.runs(grid, y) })
    if (!frame && !lines.length && sameCursor(sent.cursor, next)) {
      sent.grid = grid
      return
    }
    const update = {
      revision,
      cursor: next,
      links: this.tables.links.slice(links),
      styles: this.tables.styles.slice(styles),
      lines,
    }
    const message = frame
      ? encodeFrame({ ...update, cols: grid.width, rows: grid.height })
      : encodePatch({ ...update, base: sent.revision })
    this.sent = { grid, cursor: next, revision }
    return message
  }
  private runs(grid: FrameData, y: number): Uint8Array {
    const offset = y * grid.width
    let previous: CellData | undefined,
      style = 0
    for (let x = 0; x < grid.width; x++) {
      const cell = grid.cells[offset + x]!
      if (
        !previous ||
        cell.fg !== previous.fg ||
        cell.bg !== previous.bg ||
        cell.modifier !== previous.modifier ||
        cell.hyperlink !== previous.hyperlink
      )
        style = this.tables.style(
          attrs(cell.modifier),
          colour(cell.fg),
          colour(cell.bg),
          DEFAULT_COLOUR,
          link(grid, cell),
        )
      previous = cell
      // A continuation that no wide cell claimed shows as a blank.
      const symbol = cell.skip ? ' ' : cell.symbol.replace(controls, ' ')
      const wide =
        (symbol.length > 1 || symbol.charCodeAt(0) > 0x2ff) &&
        terminalCellWidth(symbol) > 1 &&
        x + 1 < grid.width
      this.row.cell(style, symbol, wide)
      if (wide) x++
    }
    return this.row.finish()
  }
}
