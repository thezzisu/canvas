import type { CellMirror } from '../../../../shared/cell-wire'
import {
  cellRange,
  selectionText,
  wordRange,
  type CellPoint,
  type CellRange,
} from '../../utils/terminal/cell-selection'
import type { CellPainter } from './cell-painter'

/**
 * A selection of cells this browser makes over a window's screen. The program is not told of it.
 * It lasts until the cells under it change or the user types.
 */
export class TerminalSelection {
  private range: CellRange | undefined
  /** What the gesture started on: a cell, a word or a row. */
  private anchor: CellRange | undefined

  constructor(
    private readonly mirror: CellMirror,
    private readonly painter: CellPainter,
  ) {}

  get text(): string {
    return this.range ? selectionText(this.mirror.lines, this.range) : ''
  }
  get active(): boolean {
    return !!this.range
  }

  /** A press starts over: on a cell, or with two clicks its word, or with three its row. */
  begin(point: CellPoint, clicks: number) {
    const row = { column: 0, row: point.row }
    this.anchor =
      clicks >= 3
        ? { start: row, end: { column: this.mirror.cols - 1, row: point.row } }
        : clicks === 2
          ? wordRange(this.mirror.lines[point.row] ?? [], point)
          : { start: point, end: point }
    this.show(clicks >= 2 ? this.anchor : undefined)
  }
  /** The pointer moved with the button held. */
  extend(point: CellPoint) {
    const { anchor } = this
    if (!anchor) return
    const same = point.row === anchor.start.row && point.column === anchor.start.column
    if (!this.range && same) return
    this.show({
      start: cellRange(anchor.start, point).start,
      end: cellRange(anchor.end, point).end,
    })
  }
  clear() {
    this.anchor = undefined
    if (this.range) this.show(undefined)
  }
  /** The mirror applied a message. */
  changed(change: { frame: boolean; rows: readonly number[] }) {
    const { range } = this
    if (!range) return
    if (change.frame || change.rows.some((row) => row >= range.start.row && row <= range.end.row))
      this.clear()
  }

  private show(range: CellRange | undefined) {
    this.range = range
    this.painter.setSelection(range)
  }
}
