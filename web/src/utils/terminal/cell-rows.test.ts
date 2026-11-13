import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTR,
  DEFAULT_COLOUR,
  UNDERLINE_SHIFT,
  type CellRun,
  type CellStyle,
} from '../../../../shared/cell-wire.ts'
import { createGlyphs } from './cell-glyphs.ts'
import { clusterAt, planRow, rowText, type RowFont } from './cell-rows.ts'
import { cellPaint, xtermPalette, type CellTheme } from './cell-style.ts'

const theme: CellTheme = {
  foreground: 0,
  background: 0,
  cursor: 0,
  cursorAccent: 0,
  selectionBackground: 0x415168,
}
const plain: CellStyle = {
  attrs: 0,
  fg: DEFAULT_COLOUR,
  bg: DEFAULT_COLOUR,
  underline: DEFAULT_COLOUR,
  link: 0,
}
const styles: CellStyle[] = [
  plain,
  { ...plain, fg: 0xff0000 },
  { ...plain, bg: 0x0000ff },
  { ...plain, attrs: ATTR.bold },
  { ...plain, attrs: 1 << UNDERLINE_SHIFT },
  { ...plain, attrs: ATTR.blink },
  { ...plain, fg: 0xff8800, bg: 0x005f00 },
]
const paintOf = (index: number) => cellPaint(styles[index]!, xtermPalette, theme)
const glyphs = createGlyphs({ width: 8, height: 16, light: 1, ratio: 1 })
// A font of 8 px cells where CJK is 14 px wide, arrows 9 px, and bold is not monospace.
const font: RowFont = {
  width: 8,
  spacing: 0,
  units: 64,
  exact: [true, false, true, false],
  advance: (cluster, face) =>
    cluster.codePointAt(0)! >= 0x2e80
      ? 14
      : cluster === '→'
        ? 9
        : face & 1 && cluster === 'W'
          ? 9
          : 8,
}
type Piece = Omit<CellRun, 'column' | 'columns'>
/** Runs side by side from the first column. */
function row(pieces: Piece[]): CellRun[] {
  let column = 0
  return pieces.map((piece) => {
    const run = { ...piece, column, columns: piece.text.length * (piece.wide ? 2 : 1) }
    column += run.columns
    return run
  })
}
const plan = (pieces: Piece[]) => planRow(row(pieces), paintOf, font, glyphs)
const text = (run: string, style = 0): Piece => ({ style, wide: false, text: run })
const clusters = (run: string[], style = 0, wide = false): Piece => ({ style, wide, text: run })

test('plain ASCII is one segment of bare text', () => {
  const { segments, fills, tiles } = plan([text('hello world')])
  assert.deepEqual(segments, [
    {
      column: 0,
      cells: 11,
      drawn: [],
      ink: '',
      paper: '',
      hidden: false,
      blink: false,
      nodes: [{ text: 'hello world', className: '', css: '', box: 0 }],
    },
  ])
  assert.deepEqual(fills, [{ column: 0, colour: '' }])
  assert.deepEqual(tiles, [])
})

test('styles split nodes, backgrounds only fill', () => {
  const { segments, fills } = plan([
    text('ab'),
    text('cd', 1),
    text('ef', 2),
    text('gh', 2),
    text('ij'),
  ])
  assert.equal(segments.length, 1)
  assert.deepEqual(
    segments[0]!.nodes.map((node) => [node.text, node.css]),
    [
      ['ab', ''],
      ['cd', 'color:#ff0000;'],
      ['efghij', ''],
    ],
  )
  assert.deepEqual(fills, [
    { column: 0, colour: '' },
    { column: 4, colour: '#0000ff' },
    { column: 8, colour: '' },
  ])
})

test('blanks at the end of a row are left to its background, decorated ones are kept', () => {
  assert.deepEqual(plan([text('ab   '), text('    ', 2)]).segments[0]!.nodes, [
    { text: 'ab', className: '', css: '', box: 0 },
  ])
  assert.deepEqual(plan([text('    ')]).segments[0]!.nodes, [])
  const underlined = plan([text('ab'), text('  ', 4)]).segments[0]!.nodes
  assert.deepEqual(underlined.at(-1), { text: '  ', className: 'tg-u', css: '', box: 0 })
  // The row is covered whatever its text does: the fills still run to the end.
  assert.deepEqual(plan([text('ab'), text('    ', 2)]).fills.at(-1), {
    column: 2,
    colour: '#0000ff',
  })
})

test('a glyph that does not fit its cells is padded or squeezed to them', () => {
  const { segments } = plan([clusters(['中', '文'], 0, true), clusters(['→', '→', 'λ'])])
  assert.equal(segments[0]!.cells, 7)
  assert.deepEqual(
    segments[0]!.nodes.map((node) => [node.text, node.css]),
    [
      ['中文', 'letter-spacing:2px;'],
      ['→→', 'letter-spacing:-1px;'],
      ['λ', ''],
    ],
  )
})

test('a face that is not monospace is fitted glyph by glyph', () => {
  const nodes = plan([text('aWb', 3)]).segments[0]!.nodes
  assert.deepEqual(
    nodes.map((node) => [node.text, node.css]),
    [
      ['a', ''],
      ['W', 'letter-spacing:-1px;'],
      ['b', ''],
    ],
  )
})

test('clusters of several code points and shaped scripts get a box of their cells', () => {
  const { segments } = plan([clusters(['👨‍👩‍👧', '🇯🇵'], 0, true), clusters(['é', 'ש', 'م']), text('|')])
  assert.deepEqual(
    segments[0]!.nodes.map((node) => [node.text, node.box]),
    [
      ['👨‍👩‍👧', 2],
      ['🇯🇵', 2],
      ['é', 1],
      ['ש', 1],
      ['م', 1],
      ['|', 0],
    ],
  )
  assert.equal(segments[0]!.cells, 8)
})

test('a character the browser draws as nothing still holds its cell', () => {
  const nodes = plan([clusters(['a', '​', 'b', '­', '|'])]).segments[0]!.nodes
  assert.deepEqual(
    nodes.map((node) => node.text),
    ['a b |'],
  )
})

test('neighbouring lines of one colour are drawn by one segment', () => {
  const { segments, tiles } = plan([clusters([...'┌──┬─┐']), text(' x'), clusters([...'││'], 1)])
  assert.deepEqual(
    segments.map((segment) => [
      segment.column,
      segment.cells,
      segment.nodes[0]?.text,
      segment.hidden,
    ]),
    [
      [0, 6, '┌──┬─┐', true],
      [6, 2, ' x', false],
      [8, 2, '││', true],
    ],
  )
  // A run of one line is one shape; a line whose place depends on its cell is one per cell.
  assert.deepEqual(segments[0]!.drawn, [
    { code: 0x250c, column: 0, cells: 1 },
    { code: 0x2500, column: 1, cells: 2 },
    { code: 0x252c, column: 3, cells: 1 },
    { code: 0x2500, column: 4, cells: 1 },
    { code: 0x2510, column: 5, cells: 1 },
  ])
  assert.deepEqual([segments[0]!.ink, segments[0]!.paper], ['var(--tg-fg)', 'var(--tg-bg)'])
  assert.deepEqual(segments[2]!.drawn, [
    { code: 0x2502, column: 8, cells: 1 },
    { code: 0x2502, column: 9, cells: 1 },
  ])
  assert.equal(segments[2]!.ink, '#ff0000')
  assert.deepEqual(tiles, [])
  // Another colour is another segment.
  assert.equal(plan([clusters(['─']), clusters(['─'], 1)]).segments.length, 2)
})

test("broad blocks become tiles of the row background in their style's colours", () => {
  const { segments, fills, tiles } = plan([text('a'), clusters([...'█▀▌░'], 6), text('b')])
  assert.deepEqual(
    segments.map((segment) => [
      segment.column,
      segment.cells,
      segment.nodes[0]!.text,
      segment.hidden,
      segment.drawn.length,
    ]),
    [
      [0, 1, 'a', false, 0],
      [1, 4, '█▀▌░', true, 0],
      [5, 1, 'b', false, 0],
    ],
  )
  assert.deepEqual(fills, [
    { column: 0, colour: '' },
    { column: 1, colour: '#005f00' },
    { column: 5, colour: '' },
  ])
  assert.deepEqual(tiles, [
    { column: 1, x0: 0, y0: 0, x1: Infinity, y1: Infinity, colour: '#ff8800' },
    { column: 2, x0: 0, y0: 0, x1: Infinity, y1: 8, colour: '#ff8800' },
    { column: 3, x0: 0, y0: 0, x1: 4, y1: Infinity, colour: '#ff8800' },
    {
      column: 4,
      x0: 0,
      y0: 0,
      x1: Infinity,
      y1: Infinity,
      colour: 'color-mix(in srgb,#ff8800 25%,#005f00)',
    },
  ])
})

test('a blinking block is its own box, since a row background cannot blink', () => {
  const { segments, tiles } = plan([clusters(['█'], 5)])
  assert.deepEqual(tiles, [])
  assert.equal(segments[0]!.blink, true)
  assert.deepEqual(segments[0]!.drawn, [{ code: 0x2588, column: 0, cells: 1 }])
})

test('a wide cell holding a box-drawing character is text, not a drawing', () => {
  const { segments } = plan([clusters(['─'], 0, true)])
  assert.deepEqual([segments[0]!.hidden, segments[0]!.cells], [false, 2])
})

test('a long row is cut into segments, so rounding inside one cannot travel', () => {
  const runs = Array.from({ length: 125 }, (_, index) => text('abcd', index % 2))
  const { segments } = plan(runs)
  assert.ok(segments.length >= 7)
  assert.ok(segments.every((segment) => segment.nodes.length <= 16))
  let column = 0
  for (const segment of segments) {
    assert.equal(segment.column, column)
    column += segment.cells
  }
  assert.equal(column, 500)
})

test('the cluster under a column, wide cells included', () => {
  const runs = row([text('ab'), clusters(['中', '文'], 1, true), clusters(['→'])])
  assert.deepEqual(clusterAt(runs, 1), { cluster: 'b', style: 0, column: 1, cells: 1 })
  assert.deepEqual(clusterAt(runs, 2), { cluster: '中', style: 1, column: 2, cells: 2 })
  assert.deepEqual(clusterAt(runs, 3), { cluster: '中', style: 1, column: 2, cells: 2 })
  assert.deepEqual(clusterAt(runs, 5), { cluster: '文', style: 1, column: 4, cells: 2 })
  assert.deepEqual(clusterAt(runs, 6), { cluster: '→', style: 0, column: 6, cells: 1 })
  assert.equal(clusterAt(runs, 7), undefined)
})

test('a row reads as text with the column of every unit', () => {
  const { text: read, columns } = rowText(
    row([text('a '), clusters(['中', '😀'], 0, true), clusters(['é'])]),
  )
  assert.equal(read, 'a 中😀é')
  assert.deepEqual(columns, [0, 1, 2, 4, 4, 6, 7])
})
