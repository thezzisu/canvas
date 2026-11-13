import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTR,
  DEFAULT_COLOUR,
  PALETTE_COLOUR,
  UNDERLINE_SHIFT,
  type CellStyle,
} from '../../../../shared/cell-wire.ts'
import { cellPaint, cellPalette, cssColour, xtermPalette, type CellTheme } from './cell-style.ts'

const theme: CellTheme = {
  foreground: 0xd5d7dd,
  background: 0x111317,
  cursor: 0xe8b183,
  cursorAccent: 0x111317,
  selectionBackground: 0x415168,
}
const style = (overrides: Partial<CellStyle> = {}): CellStyle => ({
  attrs: 0,
  fg: DEFAULT_COLOUR,
  bg: DEFAULT_COLOUR,
  underline: DEFAULT_COLOUR,
  link: 0,
  ...overrides,
})
const paint = (overrides: Partial<CellStyle>, with_: CellTheme = theme) =>
  cellPaint(style(overrides), cellPalette(with_), with_)

test("the palette is xterm's, under the theme's ANSI colours", () => {
  assert.equal(xtermPalette.length, 256)
  assert.equal(xtermPalette[1], 0xcd0000)
  assert.equal(xtermPalette[16], 0x000000)
  assert.equal(xtermPalette[196], 0xff0000)
  assert.equal(xtermPalette[231], 0xffffff)
  assert.equal(xtermPalette[232], 0x080808)
  assert.equal(xtermPalette[255], 0xeeeeee)
  const themed = cellPalette({ ...theme, ansi: [0x20242b, 0xf08080] })
  assert.deepEqual(
    [themed[0], themed[1], themed[2], themed.length],
    [0x20242b, 0xf08080, 0x00cd00, 256],
  )
  assert.equal(cellPalette(theme), xtermPalette)
  assert.equal(cssColour(0x00ff80), '#00ff80')
})

test('default colours are left to the grid, others are set', () => {
  assert.deepEqual(paint({}), {
    ink: 'var(--tg-fg)',
    solid: 'var(--tg-fg)',
    paper: '',
    className: '',
    css: '',
    face: 0,
    link: 0,
  })
  const coloured = paint({ fg: 0x123456, bg: PALETTE_COLOUR | 4, link: 3 })
  assert.equal(coloured.css, 'color:#123456;')
  assert.equal(coloured.paper, '#0000ee')
  assert.equal(coloured.link, 3)
})

test('inverse swaps, selection takes the theme, dim halves the text only, invisible hides it', () => {
  const inverse = paint({ attrs: ATTR.inverse })
  assert.deepEqual([inverse.ink, inverse.paper], ['var(--tg-bg)', 'var(--tg-fg)'])
  const mixed = paint({ attrs: ATTR.inverse, fg: 0xff0000, bg: 0x0000ff })
  assert.deepEqual([mixed.ink, mixed.paper], ['#0000ff', '#ff0000'])
  const selected = paint({ attrs: ATTR.selected | ATTR.inverse, fg: 0xff0000 })
  assert.deepEqual([selected.ink, selected.paper], ['var(--tg-bg)', 'var(--tg-select)'])
  assert.equal(
    paint({ attrs: ATTR.selected }, { ...theme, selectionForeground: 0xffffff }).ink,
    'var(--tg-select-fg)',
  )
  const dim = paint({ attrs: ATTR.dim, fg: 0xff0000, bg: 0x00ff00 })
  assert.equal(dim.paper, '#00ff00')
  assert.equal(dim.ink, 'color-mix(in srgb, #ff0000 50%, transparent)')
  // A drawn glyph has no text to fade: its ink is mixed with the paper it sits on.
  assert.equal(dim.solid, 'color-mix(in srgb, #ff0000 50%, #00ff00)')
  const hidden = paint({ attrs: ATTR.invisible, fg: 0xff0000 })
  assert.deepEqual([hidden.ink, hidden.solid], ['transparent', 'var(--tg-bg)'])
})

test('bold brightens the ANSI eight unless the theme says otherwise', () => {
  const red = { attrs: ATTR.bold, fg: PALETTE_COLOUR | 1 }
  assert.equal(paint(red).ink, '#ff0000')
  assert.equal(paint(red, { ...theme, brightBold: false }).ink, '#cd0000')
  assert.equal(paint({ ...red, fg: PALETTE_COLOUR | 9 }).ink, '#ff0000')
  assert.equal(paint({ ...red, fg: PALETTE_COLOUR | 100 }).ink, cssColour(xtermPalette[100]!))
  assert.equal(paint({ attrs: ATTR.bold, bg: PALETTE_COLOUR | 1 }).paper, '#cd0000')
})

test('attributes become classes and faces', () => {
  const all = paint({
    attrs:
      ATTR.bold | ATTR.italic | ATTR.strike | ATTR.overline | ATTR.blink | (3 << UNDERLINE_SHIFT),
    underline: 0xff4040,
  })
  assert.equal(all.className, 'tg-b tg-i tg-u tg-u3 tg-s tg-o tg-blink')
  assert.equal(all.face, 3)
  assert.equal(all.css, 'text-decoration-color:#ff4040;')
  assert.equal(paint({ attrs: 1 << UNDERLINE_SHIFT }).className, 'tg-u')
  assert.equal(paint({ attrs: 5 << UNDERLINE_SHIFT }).className, 'tg-u tg-u5')
  // An underline colour without an underline is nothing.
  assert.equal(paint({ underline: 0xff4040 }).css, '')
})
