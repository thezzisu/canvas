import { runCells, type CellRun } from './cell-grid'
import { inkMix, isDrawnGlyph, type Glyphs } from './cell-glyphs'
import { BACKGROUND, type CellPaint } from './cell-style'

/** What a row needs to know about the font. */
export interface RowFont {
  /** Cell width in CSS pixels. */
  width: number
  /** The letter-spacing every glyph inherits. */
  spacing: number
  /** Layout units per CSS pixel. */
  units: number
  /** Per face (`FACE_BOLD | FACE_ITALIC`): whether ASCII advances by exactly one cell. */
  exact: readonly boolean[]
  /** The advance of one cluster in a face, without letter-spacing, in CSS pixels. */
  advance(cluster: string, face: number): number
}

/** Text of one look inside a segment. */
export interface RowNode {
  text: string
  className: string
  css: string
  /** For a cluster that needs a box of its own: the cells the box covers. */
  box: number
}

/**
 * A box of whole cells. Segments tile the row, so each is placed by its width alone and whatever
 * its text does stays inside it.
 */
export interface RowSegment {
  column: number
  cells: number
  /** Characters drawn as the segment's background; `column` is the row's. */
  drawn: { code: number; column: number; cells: number }[]
  /** The colours they are drawn in. */
  ink: string
  paper: string
  /** The text is not shown: the characters are drawn, here or in the row's background. */
  hidden: boolean
  blink: boolean
  nodes: RowNode[]
}

/** From `column` on, the row's background is `colour` ('' the default). */
export interface RowFill {
  column: number
  colour: string
}

/** Part of the cell at `column` in another colour, in layout pixels; Infinity is its far edge. */
export interface RowTile {
  column: number
  x0: number
  y0: number
  x1: number
  y1: number
  colour: string
}

export interface RowPlan {
  segments: RowSegment[]
  fills: RowFill[]
  tiles: RowTile[]
}

/** Text nodes a segment may hold: bounds how far rounding inside one can carry. */
const SEGMENT_NODES = 16
// Scripts whose letters join or change shape with their neighbours: each cell gets its own box.
const SHAPED = /[\u0590-\u08ff\u0900-\u0dff\ufb1d-\ufdff\ufe70-\ufefc]/u
// Characters a browser draws as nothing; where one holds a cell of its own, the cell is blank.
const INVISIBLE = /^[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]$/u
const DECORATED = /tg-[uso]/u

/**
 * Lays one row out as segments of text over fills of background.
 *
 * ASCII in a monospace face needs no fitting. A glyph from another font rarely matches the cell,
 * so letter-spacing pads or squeezes it to its cells and neighbours needing the same correction
 * share a node. A cluster of several code points may be drawn as several glyphs and gets a box.
 * Box drawing and block elements are drawn: broad shapes as tiles of the row's background, thin
 * lines as the background of a segment that holds a run of them.
 */
export function planRow(
  runs: readonly CellRun[],
  paintOf: (style: number) => CellPaint,
  font: RowFont,
  glyphs: Glyphs,
): RowPlan {
  const segments: RowSegment[] = []
  const fills: RowFill[] = []
  const tiles: RowTile[] = []
  let current: RowSegment | undefined
  let column = 0
  const open = (hidden = false, ink = '', paper = '', blink = false) => {
    current = { column, cells: 0, drawn: [], ink, paper, hidden, blink, nodes: [] }
    if (hidden) current.nodes.push({ text: '', className: '', css: '', box: 0 })
    segments.push(current)
    return current
  }
  const fill = (colour: string) => {
    if (fills.at(-1)?.colour !== colour) fills.push({ column, colour })
  }
  const add = (paint: CellPaint, text: string, cells: number, extra = '', box = 0) => {
    const segment =
      !current || current.hidden || current.nodes.length >= SEGMENT_NODES ? open() : current
    fill(paint.paper)
    const css = paint.css + extra
    const last = segment.nodes.at(-1)
    if (last && !box && !last.box && last.className === paint.className && last.css === css)
      last.text += text
    else segment.nodes.push({ text, className: paint.className, css, box })
    segment.cells += cells
    column += cells
  }
  const draw = (paint: CellPaint, code: number, cluster: string) => {
    const paper = paint.paper || BACKGROUND
    const blink = paint.className.includes('tg-blink')
    // The row's background cannot blink: a blinking shape is drawn by its segment.
    const shape = blink ? undefined : glyphs.tiles(code)
    fill(paint.paper)
    if (shape) {
      for (const { ink, ...tile } of shape)
        tiles.push({ column, ...tile, colour: inkMix(ink, paint.solid, paper) })
      if (!current?.hidden || current.drawn.length) open(true)
    } else {
      // Neighbouring lines of one colour share a segment, so that they join inside one box.
      if (
        !current?.drawn.length ||
        current.ink !== paint.solid ||
        current.paper !== paper ||
        current.blink !== blink
      )
        open(true, paint.solid, paper, blink)
      // A run of one character is one shape, unless the shape depends on where each cell starts.
      const last = current!.drawn.at(-1)
      if (last?.code === code && glyphs.uniform(code)) last.cells++
      else current!.drawn.push({ code, column, cells: 1 })
    }
    current!.nodes[0]!.text += cluster
    current!.cells++
    column++
  }
  const fit = (paint: CellPaint, clusters: Iterable<string>, each: number) => {
    let chunk = ''
    let count = 0
    let spacing = font.spacing
    const flush = () => {
      if (!chunk) return
      const extra = spacing === font.spacing ? '' : `letter-spacing:${spacing}px;`
      add(paint, chunk, count * each, extra)
      chunk = ''
      count = 0
    }
    for (let cluster of clusters) {
      const code = cluster.codePointAt(0)!
      const single = cluster.length === (code > 0xffff ? 2 : 1)
      if (each === 1 && single && isDrawnGlyph(code)) {
        flush()
        draw(paint, code, cluster)
        continue
      }
      if (!single || SHAPED.test(cluster)) {
        flush()
        add(paint, cluster, each, '', each)
        continue
      }
      if (INVISIBLE.test(cluster)) cluster = ' '
      const exact = each * font.width - font.advance(cluster, paint.face)
      const needed =
        Math.abs(exact - font.spacing) * font.units < 0.5
          ? font.spacing
          : Math.round(exact * font.units) / font.units
      if (needed !== spacing) flush()
      spacing = needed
      chunk += cluster
      count++
    }
    flush()
  }

  for (const run of runs) {
    const paint = paintOf(run.style)
    if (!('text' in run)) fit(paint, run.clusters, run.wide ? 2 : 1)
    else if (font.exact[paint.face]) add(paint, run.text, run.text.length)
    else fit(paint, run.text, 1)
  }

  // Blanks at the end of the row are already drawn by its background.
  for (let index = segments.length - 1; index >= 0; index--) {
    const { nodes, hidden } = segments[index]!
    if (hidden) break
    while (nodes.length) {
      const last = nodes.at(-1)!
      if (last.box || DECORATED.test(last.className)) break
      last.text = last.text.trimEnd()
      if (last.text) break
      nodes.pop()
    }
    if (nodes.length) break
  }
  return { segments, fills, tiles }
}

/** The cluster at a column, with the first column and the cells it covers. */
export function clusterAt(
  runs: readonly CellRun[],
  column: number,
): { cluster: string; style: number; column: number; cells: number } | undefined {
  let start = 0
  for (const run of runs) {
    const cells = runCells(run)
    if (column < start + cells) {
      const each = 'text' in run || !run.wide ? 1 : 2
      const index = Math.floor((column - start) / each)
      return {
        cluster: 'text' in run ? run.text[index]! : run.clusters[index]!,
        style: run.style,
        column: start + index * each,
        cells: each,
      }
    }
    start += cells
  }
}

/**
 * A row as a string, with the column each UTF-16 unit starts at and, last, the row's end.
 * A cell with nothing visible in it reads as a space.
 */
export function rowText(runs: readonly CellRun[]): { text: string; columns: number[] } {
  let text = ''
  let column = 0
  const columns: number[] = []
  for (const run of runs) {
    if ('text' in run) {
      for (let index = 0; index < run.text.length; index++) columns.push(column + index)
      text += run.text
      column += run.text.length
      continue
    }
    for (const cluster of run.clusters) {
      const shown = cluster || ' '
      for (let index = 0; index < shown.length; index++) columns.push(column)
      text += shown
      column += run.wide ? 2 : 1
    }
  }
  columns.push(column)
  return { text, columns }
}
