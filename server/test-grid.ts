// Test helpers: what a browser shows of a grid, read back through the cell wire.
import { CellMirror } from '../shared/cell-wire.ts'
import { GridEncoder } from './cell-grid.ts'
import type { HerdrClientTransport } from './herdr/client.ts'
import type { FrameData } from './herdr/wire.ts'

/** The text of each row, without trailing blanks. */
export function mirrorText(mirror: CellMirror): string[] {
  return mirror.lines.map((runs) =>
    runs
      .map((run) => (typeof run.text === 'string' ? run.text : run.text.join('')))
      .join('')
      .trimEnd(),
  )
}
export function gridMirror(grid: FrameData): CellMirror {
  const mirror = new CellMirror()
  mirror.apply(new GridEncoder().encode(grid, 1)!)
  return mirror
}
export const gridText = (grid: FrameData) => mirrorText(gridMirror(grid))
/** The symbols in columns `from` to `to` of each row, as herdr laid them out. */
export function gridColumns(grid: FrameData, from = 0, to = grid.width): string[] {
  return Array.from({ length: grid.height }, (_, y) =>
    grid.cells
      .slice(y * grid.width + from, y * grid.width + to)
      .map((cell) => cell.symbol)
      .join(''),
  )
}
/** What a herdr client shows and signals to the window layer. */
export function watch(client: HerdrClientTransport) {
  const seen = {
    paints: 0,
    grid: undefined as FrameData | undefined,
    text: '',
    bells: 0,
    clipboard: [] as string[],
  }
  client.onScreen((grid) => {
    seen.paints++
    seen.grid = grid
    seen.text = gridText(grid).join('\n')
  })
  client.onBell(() => seen.bells++)
  client.onClipboard((data) => seen.clipboard.push(data))
  return seen
}
