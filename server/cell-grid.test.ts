import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTR,
  CellMirror,
  DEFAULT_COLOUR,
  PALETTE_COLOUR,
  UNDERLINE_SHIFT,
} from '../shared/cell-wire.ts'
import { GridEncoder, TABLE_LIMIT } from './cell-grid.ts'
import { composedFrame } from './herdr/screen.ts'
import { gridMirror, mirrorText } from './test-grid.ts'
import type { CellData, FrameData } from './herdr/wire.ts'

const blank = (symbol = ' '): CellData => ({
  symbol,
  fg: 0,
  bg: 0,
  modifier: 0,
  skip: false,
  hyperlink: null,
})
function grid(width: number, height: number, rows: readonly string[] = []): FrameData {
  const cells = Array.from({ length: width * height }, () => blank())
  rows.forEach((text, y) =>
    Array.from(text).forEach((symbol, x) => (cells[y * width + x] = blank(symbol))),
  )
  return { width, height, cells, hyperlinks: [], cursor: null, graphics: Buffer.alloc(0) }
}
const edit = (value: FrameData, changes: Record<number, CellData>): FrameData => ({
  ...value,
  cells: value.cells.map((cell, index) => changes[index] ?? cell),
})
const styleAt = (mirror: CellMirror, y: number, column: number) =>
  mirror.styles[
    mirror.lines[y]!.find((run) => column >= run.column && column < run.column + run.columns)!.style
  ]!

test('the first message is a frame carrying every herdr cell attribute', () => {
  const value = grid(10, 2, ['中 A'])
  value.hyperlinks = ['https://example.com/x', 'bad link\x07']
  Object.assign(value.cells[0]!, { fg: 0x02123456, bg: 0x010000c8, modifier: 1 | 4 | 8 | 0x3000 })
  Object.assign(value.cells[2]!, { fg: 2, bg: 16, modifier: 2 | 16 | 32 | 64 | 128 | 256 | 8 })
  Object.assign(value.cells[3]!, { hyperlink: 0, fg: 17 })
  Object.assign(value.cells[4]!, { hyperlink: 1, fg: 17 })
  value.cursor = { x: 4, y: 1, visible: true, shape: 6 }
  const mirror = gridMirror(value)
  assert.deepEqual([mirror.cols, mirror.rows, mirror.revision], [10, 2, 1])
  assert.deepEqual([mirror.foreground, mirror.background], [undefined, undefined])
  assert.deepEqual(mirrorText(mirror), ['中A', ''])
  assert.deepEqual(mirror.lines[0]![0], {
    column: 0,
    columns: 2,
    style: 0,
    wide: true,
    text: ['中'],
  })
  assert.deepEqual(styleAt(mirror, 0, 0), {
    attrs: ATTR.bold | ATTR.italic | (3 << UNDERLINE_SHIFT),
    fg: 0x123456,
    bg: PALETTE_COLOUR | 200,
    underline: DEFAULT_COLOUR,
    link: 0,
  })
  assert.deepEqual(styleAt(mirror, 0, 2), {
    attrs:
      ATTR.dim |
      ATTR.blink |
      ATTR.rapidBlink |
      ATTR.inverse |
      ATTR.invisible |
      ATTR.strike |
      (1 << UNDERLINE_SHIFT),
    fg: PALETTE_COLOUR | 1,
    bg: PALETTE_COLOUR | 15,
    underline: DEFAULT_COLOUR,
    link: 0,
  })
  assert.deepEqual(mirror.links, ['https://example.com/x'])
  assert.equal(styleAt(mirror, 0, 3).link, 1)
  assert.equal(styleAt(mirror, 0, 4).link, 0, 'an unsafe link is dropped, its text kept')
  assert.equal(styleAt(mirror, 0, 4).fg, DEFAULT_COLOUR)
  assert.deepEqual(mirror.cursor, { x: 4, y: 1, visible: true, blink: false, shape: 'bar' })
})

test('cursor shapes follow DECSCUSR and a cursor outside the grid is hidden', () => {
  const shapes = [
    ['block', true],
    ['block', true],
    ['block', false],
    ['underline', true],
    ['underline', false],
    ['bar', true],
    ['bar', false],
    ['block', true],
  ] as const
  shapes.forEach(([shape, blink], value) => {
    const cursor = { x: 1, y: 0, visible: true, shape: value }
    assert.deepEqual(gridMirror({ ...grid(2, 1), cursor }).cursor, { ...cursor, shape, blink })
  })
  const outside = { x: 2, y: 0, visible: true, shape: 0 }
  assert.equal(gridMirror({ ...grid(2, 1), cursor: outside }).cursor.visible, false)
})

test('wide cells take their neighbour, stray continuations and controls show as blanks', () => {
  const value = grid(4, 3, ['中x', 'ab中', 'a\x07b'])
  value.cells[4 + 2]!.skip = true
  const emoji = grid(4, 1)
  emoji.cells[0] = blank('👩‍💻')
  emoji.cells[1] = { ...blank(''), skip: true }
  emoji.cells[2] = blank('é')
  assert.deepEqual(mirrorText(gridMirror(value)), ['中', 'ab', 'a b'])
  assert.deepEqual(
    gridMirror(emoji).lines[0]!.map((run) => [run.column, run.columns, run.wide, run.text]),
    [
      [0, 2, true, ['👩‍💻']],
      [2, 1, false, ['é']],
      [3, 1, false, ' '],
    ],
  )
  const edge = grid(3, 1, ['ab中'])
  assert.deepEqual(
    gridMirror(edge).lines[0]!.map((run) => [run.column, run.columns, run.wide]),
    [[0, 3, false]],
    'a wide glyph in the last column stays one column',
  )
})

test('family emojis, combining marks and CJK keep their cells and clear in a patch', () => {
  const encoder = new GridEncoder(),
    mirror = new CellMirror()
  const first = grid(12, 2)
  for (const [x, symbol] of [
    [0, '👨‍👩‍👧‍👦'],
    [2, '👩‍👩‍👧‍👧'],
    [4, 'e\u0301'],
    [5, '中'],
    [7, 'A'],
  ] as const)
    first.cells[x] = blank(symbol)
  mirror.apply(encoder.encode(first, 1)!)
  assert.deepEqual(
    mirror.lines[0]!.map((run) => [run.column, run.columns, run.wide, run.text]),
    [
      [0, 4, true, ['👨‍👩‍👧‍👦', '👩‍👩‍👧‍👧']],
      [4, 1, false, ['e\u0301']],
      [5, 2, true, ['中']],
      [7, 1, false, 'A'],
      [8, 4, false, '    '],
    ],
  )
  mirror.apply(encoder.encode(grid(12, 2, ['xy']), 2)!)
  assert.deepEqual(
    mirror.lines[0]!.map((run) => [run.column, run.columns, run.wide, run.text]),
    [
      [0, 2, false, 'xy'],
      [2, 10, false, ' '.repeat(10)],
    ],
  )
})

test('later messages patch only changed rows, against the last message sent', () => {
  const encoder = new GridEncoder(),
    mirror = new CellMirror()
  const first = grid(6, 3, ['one', 'two', 'three'])
  mirror.apply(encoder.encode(first, 4)!)
  assert.equal(encoder.encode(first, 5), undefined)
  assert.equal(encoder.encode(edit(first, {}), 6), undefined, 'an equal grid sends nothing')

  const second = edit(first, { 6: blank('T'), 7: { ...blank('W'), modifier: 1 } })
  assert.deepEqual(mirror.apply(encoder.encode(second, 7)!), { frame: false, rows: [1] })
  assert.equal(mirror.revision, 7)
  assert.deepEqual(mirrorText(mirror), ['one', 'TWo', 'three'])
  assert.equal(mirror.styles.length, 2, 'a patch adds only styles the browser lacks')

  const moved = { ...second, cursor: { x: 2, y: 2, visible: true, shape: 2 } }
  assert.deepEqual(mirror.apply(encoder.encode(moved, 8)!), { frame: false, rows: [] })
  assert.deepEqual(mirror.cursor, { x: 2, y: 2, visible: true, blink: false, shape: 'block' })

  // A browser that was busy for two grids is sent one patch to the latest.
  const third = edit(moved, { 0: blank('O') })
  const fourth = edit(third, { 12: blank('T'), 6: blank('t') })
  assert.deepEqual(mirror.apply(encoder.encode(fourth, 10)!), { frame: false, rows: [0, 1, 2] })
  assert.deepEqual(mirrorText(mirror), ['One', 'tWo', 'Three'])
  assert.equal(mirror.revision, 10)
})

test('hyperlink identity follows the target, not its index in a frame', () => {
  const encoder = new GridEncoder(),
    mirror = new CellMirror()
  const first = grid(2, 1, ['ab'])
  first.hyperlinks = ['https://a.example']
  first.cells[0]!.hyperlink = 0
  mirror.apply(encoder.encode(first, 1)!)
  const reordered = edit(first, { 0: { ...first.cells[0]!, hyperlink: 1 } })
  reordered.hyperlinks = ['https://b.example', 'https://a.example']
  assert.equal(encoder.encode(reordered, 2), undefined)
  const retargeted = { ...reordered, hyperlinks: ['https://b.example', 'https://c.example'] }
  mirror.apply(encoder.encode(retargeted, 3)!)
  assert.deepEqual(mirror.links, ['https://a.example', 'https://c.example'])
  assert.equal(styleAt(mirror, 0, 0).link, 2)
})

test('a new size, a reset and outgrown tables each start over with a frame', () => {
  const encoder = new GridEncoder(),
    mirror = new CellMirror()
  const first = grid(4, 2, ['ab'])
  mirror.apply(encoder.encode(first, 1)!)
  assert.equal(mirror.apply(encoder.encode(grid(5, 2, ['ab']), 2)!).frame, true)
  assert.deepEqual([mirror.cols, mirror.rows], [5, 2])

  encoder.reset()
  const again = new CellMirror()
  assert.deepEqual(again.apply(encoder.encode(grid(5, 2, ['cd']), 3)!), {
    frame: true,
    rows: [0, 1],
  })
  assert.deepEqual(mirrorText(again), ['cd', ''])

  // Each grid brings 100 new colours; the tables are emptied once they pass the limit.
  const painted = (step: number) => {
    const value = grid(100, 1)
    value.cells.forEach((cell, x) => (cell.fg = 0x02000000 | (step * 100 + x)))
    return value
  }
  const stream = new GridEncoder(),
    browser = new CellMirror()
  const frames: number[] = []
  for (let step = 0; step < TABLE_LIMIT / 100 + 3; step++) {
    if (browser.apply(stream.encode(painted(step), step + 1)!).frame) frames.push(step)
    assert.equal(styleAt(browser, 0, 99).fg, step * 100 + 99)
  }
  assert.deepEqual(frames, [0, Math.floor(TABLE_LIMIT / 100) + 1])
  assert.equal(browser.styles.length, 300)
})

test('a composed selection and popup reach the browser as attributes and cells', () => {
  const frame = grid(12, 6, ['abcdef', 'ghijkl'])
  const pane = {
    pane_id: 'p',
    content_revision: 1,
    rect: { x: 0, y: 0, width: 12, height: 6 },
    inner_rect: { x: 1, y: 0, width: 4, height: 2 },
    scrollbar_rect: null,
    scroll: null,
    focused: true,
    mouse_reporting: false,
    sgr_pixel_mouse: false,
    alternate_screen_active: false,
    pixel_width: 0,
    pixel_height: 0,
  }
  const surface = {
    boot_id: 'boot',
    projection_revision: 1,
    surface_revision: 1,
    frame,
    panes: [pane],
    splits: [],
    popup: null,
  }
  const selection = { pane_id: 'p', anchor: { row: 0, col: 2 }, cursor: { row: 1, col: 0 } }
  const mirror = gridMirror(composedFrame(surface, selection))
  const selected = (y: number) =>
    Array.from({ length: 6 }, (_, x) => (styleAt(mirror, y, x).attrs & ATTR.selected) !== 0)
  assert.deepEqual(selected(0), [false, false, false, true, true, false])
  assert.deepEqual(selected(1), [false, true, false, false, false, false])
  assert.equal(frame.cells[3]!.modifier, 0, 'composition leaves the surface untouched')

  const popup = {
    terminal_id: 't',
    title: '',
    width: { Cells: 8 },
    height: { Cells: 4 },
    frame: { ...grid(5, 2, ['POP']), cursor: { x: 3, y: 0, visible: true, shape: 2 } },
    mouse_reporting: false,
    sgr_pixel_mouse: false,
    pixel_width: 0,
    pixel_height: 0,
  }
  const covered = gridMirror(composedFrame({ ...surface, popup }))
  assert.deepEqual(mirrorText(covered), [
    'abcdef',
    'gh┌──────┐',
    '  │POP   │',
    '  │      │',
    '  └──────┘',
    '',
  ])
  assert.deepEqual([covered.cursor.x, covered.cursor.y], [6, 2])
})
