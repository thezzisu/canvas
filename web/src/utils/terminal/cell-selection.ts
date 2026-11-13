import type { CellRun } from '../../../../shared/cell-wire'
import { rowText } from './cell-rows'

export interface CellPoint {
  column: number
  row: number
}
/** Cells from `start` through `end`, both included, in reading order. */
export interface CellRange {
  start: CellPoint
  end: CellPoint
}

const before = (a: CellPoint, b: CellPoint) =>
  a.row < b.row || (a.row === b.row && a.column <= b.column)

/** The range between two cells, whichever comes first. */
export function cellRange(a: CellPoint, b: CellPoint): CellRange {
  return before(a, b) ? { start: a, end: b } : { start: b, end: a }
}

/** The columns of `row` inside the range, as [first, past the last]. */
export function selectedSpan(range: CellRange, row: number, cols: number): [number, number] {
  return [
    row === range.start.row ? range.start.column : 0,
    row === range.end.row ? Math.min(cols, range.end.column + 1) : cols,
  ]
}

/** What a range reads as: one line per row, without the blanks that end a row. */
export function selectionText(lines: readonly (readonly CellRun[])[], range: CellRange): string {
  const rows: string[] = []
  for (let row = range.start.row; row <= range.end.row && row < lines.length; row++) {
    const { text, columns } = rowText(lines[row]!)
    const [from, to] = selectedSpan(range, row, columns.at(-1)!)
    let line = ''
    // A wide cell is selected whole when the range covers either of its columns.
    for (let index = 0, end = 0; index < text.length; index++) {
      if (columns[index] !== columns[index - 1])
        end = columns.find((column, later) => later > index && column !== columns[index])!
      if (end > from && columns[index]! < to) line += text[index]
    }
    rows.push(line.trimEnd())
  }
  return rows.join('\n')
}

// What ends a word, as in xterm.js.
const SEPARATORS = ' ()[]{}\',"`'

/** The word at a cell, or the cell alone on a separator. */
export function wordRange(runs: readonly CellRun[], point: CellPoint): CellRange {
  const { text, columns } = rowText(runs)
  const index = columns.findLastIndex(
    (column, unit) => unit < text.length && column <= point.column,
  )
  if (index < 0 || SEPARATORS.includes(text[index]!)) return { start: point, end: point }
  let first = index
  let last = index
  while (first > 0 && !SEPARATORS.includes(text[first - 1]!)) first--
  while (last + 1 < text.length && !SEPARATORS.includes(text[last + 1]!)) last++
  return {
    start: { column: columns[first]!, row: point.row },
    end: { column: columns[last + 1]! - 1, row: point.row },
  }
}
