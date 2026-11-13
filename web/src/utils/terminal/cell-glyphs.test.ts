import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGlyphs, inkMix, isDrawnGlyph, type GlyphCell } from './cell-glyphs.ts'

const cells: GlyphCell[] = [
  { width: 8.40625, height: 18, light: 1, ratio: 1 },
  { width: 16.8125, height: 36, light: 2, ratio: 2 },
  { width: 22.0625, height: 48, light: 3, ratio: 2.625 },
  { width: 7.03125, height: 14, light: 1, ratio: 1 },
  { width: 2, height: 3, light: 1, ratio: 1 },
]

/** The rectangles of a drawn background as [x, y, width, height] in layout pixels. */
function layers(background: string, cell: GlyphCell) {
  return background
    .split(/,(?=(?:linear|radial)-gradient)/u)
    .filter((layer) => layer.startsWith('linear-gradient'))
    .map((layer) => {
      const match = /\) ([\d.]+)px ([\d.]+)px\/([\d.]+)px ([\d.]+)px no-repeat$/u.exec(layer)
      assert(match, layer)
      return match.slice(1).map((value) => Math.round(Number(value) * cell.ratio * 1e3) / 1e3)
    })
}
const FAR = 10000
/** One character alone in a box of its cell. */
const alone = (
  glyphs: ReturnType<typeof createGlyphs>,
  cell: GlyphCell,
  code: number,
  ink = '#fff',
) => glyphs.paint([{ code, x: 0, end: cell.width }], ink, '#000')

test('only box drawing and block elements are drawn', () => {
  assert.equal(isDrawnGlyph(0x24ff), false)
  assert.equal(isDrawnGlyph(0x2500), true)
  assert.equal(isDrawnGlyph(0x259f), true)
  assert.equal(isDrawnGlyph(0x25a0), false)
})

test('every character has a shape at every cell size', () => {
  for (const cell of cells) {
    const glyphs = createGlyphs(cell)
    for (let code = 0x2500; code <= 0x259f; code++) {
      const tiles = glyphs.tiles(code)
      const background = alone(glyphs, cell, code)
      assert.ok(tiles?.length || background, `U+${code.toString(16)}`)
      assert.equal(background.includes('NaN') || background.includes('undefined'), false)
    }
  }
})

test('lines sit on whole layout pixels and meet the cell edges they join across', () => {
  for (const cell of cells) {
    const glyphs = createGlyphs(cell)
    const rects = (character: string) =>
      layers(alone(glyphs, cell, character.codePointAt(0)!), cell)
    const width = Math.round(cell.width * 1e3) / 1e3
    for (const character of '─│┌┐└┘├┤┬┴┼━┃╋═║╬╔╗╚╝')
      for (const [x, y, w, h] of rects(character)) {
        // Only the cell's own far edge may fall between pixels.
        for (const value of [x!, y!, h!, Math.abs(x! + w! - width) < 0.01 ? 0 : w!])
          assert.equal(value % 1, 0, `${character} ${[x, y, w, h]} in ${cell.width}x${cell.height}`)
      }
    // A horizontal line is one rectangle from edge to edge, at the height a junction's arms are.
    const [horizontal] = rects('─')
    const [vertical] = rects('│')
    assert.deepEqual([horizontal![0], horizontal![2], horizontal![3]], [0, width, cell.light])
    assert.deepEqual([vertical![1], vertical![2], vertical![3]], [0, cell.light, FAR * cell.ratio])
    const cross = rects('┼')
    assert.ok(
      cross.some((rect) => rect[0] === 0 && rect[1] === horizontal![1] && rect[2] === width),
    )
    assert.ok(
      cross.some(
        (rect) => rect[1] === 0 && rect[0] === vertical![0] && rect[3] === FAR * cell.ratio,
      ),
    )
    // A corner reaches the two edges it joins and neither of the others.
    const corner = rects('┌')
    assert.ok(corner.every((rect) => rect[0] > 0 && rect[1] > 0))
    assert.ok(
      corner.some(
        (rect) => Math.abs(rect[0]! + rect[2]! - width) < 0.01 && rect[1] === horizontal![1],
      ),
    )
    assert.ok(corner.some((rect) => rect[3] === FAR * cell.ratio && rect[0] === vertical![0]))
    // Heavy and double lines are centred on the light one.
    const [heavy] = rects('┃')
    assert.equal(heavy![2], 2 * cell.light)
    assert.ok(heavy![0] <= vertical![0] && heavy![0] + heavy![2] >= vertical![0] + vertical![2])
    const double = rects('║').sort((a, b) => a[0]! - b[0]!)
    assert.deepEqual(
      double.map((rect) => rect[0]),
      [vertical![0]! - cell.light, vertical![0]! + cell.light],
    )
  }
})

test('rectangles of one shape overlap wherever its ink touches', () => {
  const cell = cells[0]!
  const glyphs = createGlyphs(cell)
  for (const character of '┌┼┤╪╫┏╋╞') {
    const rects = layers(alone(glyphs, cell, character.codePointAt(0)!), cell)
    // Flood from the first rectangle through overlaps of positive area: everything is reached.
    const reached = new Set([0])
    for (let grew = true; grew;) {
      grew = false
      rects.forEach((rect, index) => {
        if (reached.has(index)) return
        const touches = [...reached].some((other) => {
          const [x, y, w, h] = rects[other]!
          return (
            rect[0]! < x! + w! &&
            x! < rect[0]! + rect[2]! &&
            rect[1]! < y! + h! &&
            y! < rect[1]! + rect[3]!
          )
        })
        if (touches) {
          reached.add(index)
          grew = true
        }
      })
    }
    assert.equal(reached.size, rects.length, character)
  }
})

test('broad blocks are tiles for the row, thin ones rectangles', () => {
  const glyphs = createGlyphs(cells[0]!)
  const tiles = (character: string) => glyphs.tiles(character.codePointAt(0)!)
  assert.deepEqual(tiles('█'), [{ x0: 0, y0: 0, x1: Infinity, y1: Infinity, ink: 1 }])
  assert.deepEqual(tiles('▀'), [{ x0: 0, y0: 0, x1: Infinity, y1: 9, ink: 1 }])
  assert.deepEqual(tiles('▄'), [{ x0: 0, y0: 9, x1: Infinity, y1: Infinity, ink: 1 }])
  assert.deepEqual(tiles('▌'), [{ x0: 0, y0: 0, x1: 4, y1: Infinity, ink: 1 }])
  assert.deepEqual(tiles('▐'), [{ x0: 4, y0: 0, x1: Infinity, y1: Infinity, ink: 1 }])
  assert.deepEqual(tiles('▒'), [{ x0: 0, y0: 0, x1: Infinity, y1: Infinity, ink: 0.5 }])
  assert.deepEqual(tiles('▚'), [
    { x0: 0, y0: 0, x1: 4, y1: 9, ink: 1 },
    { x0: 4, y0: 9, x1: Infinity, y1: Infinity, ink: 1 },
  ])
  assert.deepEqual(tiles('▙'), [
    { x0: 0, y0: 0, x1: 4, y1: 9, ink: 1 },
    { x0: 0, y0: 9, x1: Infinity, y1: Infinity, ink: 1 },
  ])
  // Halves of neighbouring cells share their edge: a half block ends where the next begins.
  assert.equal(tiles('▀')![0]!.y1, tiles('▄')![0]!.y0)
  assert.equal(tiles('▌')![0]!.x1, tiles('▐')![0]!.x0)
  // One and two pixels of ink would vanish between the pixels of a card scaled down.
  for (const thin of '▁▏▕▔─│┼') assert.equal(tiles(thin), undefined, thin)
})

test('a run of one character is one shape only when every cell looks the same', () => {
  const glyphs = createGlyphs(cells[0]!)
  for (const same of '─━═▁▔') assert.equal(glyphs.uniform(same.codePointAt(0)!), true, same)
  for (const each of '│┼╭╱▏┄┆') assert.equal(glyphs.uniform(each.codePointAt(0)!), false, each)
})

test('arcs and diagonals are gradients over their straight parts', () => {
  const cell = cells[0]!
  const glyphs = createGlyphs(cell)
  const arc = alone(glyphs, cell, '╭'.codePointAt(0)!)
  assert.match(arc, /^radial-gradient\(circle at 100% 100%,/u)
  // The straight ends reach the right and bottom edges, on the lines of ─ and │.
  const [horizontal] = layers(alone(glyphs, cell, 0x2500), cell)
  const ends = layers(arc, cell)
  assert.ok(
    ends.some(
      (rect) => rect[1] === horizontal![1] && Math.abs(rect[0]! + rect[2]! - cell.width) < 0.01,
    ),
  )
  assert.ok(ends.some((rect) => rect[3] === FAR && rect[2] === 1))
  assert.match(alone(glyphs, cell, '╯'.codePointAt(0)!), /circle at 0 0,/u)
  const cross = alone(glyphs, cell, '╳'.codePointAt(0)!)
  assert.equal(cross.split('linear-gradient(to top').length - 1, 2)
})

test('neighbours in one box join: ink that goes on runs into the next cell', () => {
  const cell = cells[0]!
  const glyphs = createGlyphs(cell)
  const run = (text: string) =>
    layers(
      glyphs.paint(
        [...text].map((character, index) => ({
          code: character.codePointAt(0)!,
          x: index * 8,
          end: (index + 1) * 8,
        })),
        '#fff',
        '#000',
      ),
      cell,
    )
  const reaches = (text: string) => Math.max(...run(text).map((rect) => rect[0]! + rect[2]!))
  // A line into a junction's arm overlaps it by a pixel; into a cell without one it stops.
  assert.equal(run('─┼')[0]![2], 9)
  assert.equal(run('─│')[0]![2], 8)
  assert.equal(run('─╮')[0]![2], 9)
  assert.equal(run('┌┐').filter((rect) => rect[0]! < 8 && rect[0]! + rect[2]! > 8).length, 1)
  // A heavy line does not spill its extra thickness into a light one.
  assert.equal(run('━─')[0]![2], 8)
  assert.equal(run('─━')[0]![2], 9)
  // The last cell of a box ends at its edge.
  assert.equal(reaches('──'), 16)
  // A run of one uniform character is given as one cell and drawn as one rectangle.
  const merged = layers(glyphs.paint([{ code: 0x2500, x: 0, end: 80 }], '#fff', '#000'), cell)
  assert.deepEqual(merged, [[0, 9, 80, 1]])
  // Each character is drawn from where its cell starts.
  assert.deepEqual(
    run('││').map((rect) => rect[0]),
    [4, 12],
  )
  assert.match(
    glyphs.paint([{ code: '╭'.codePointAt(0)!, x: 16, end: 24 }], '#fff', '#000'),
    /\) 20px 9px\/3px 3px no-repeat/u,
  )
})

test('ink takes the colour it is given and shades are mixes', () => {
  const cell = cells[0]!
  const glyphs = createGlyphs(cell)
  assert.match(alone(glyphs, cell, 0x2500, 'red'), /^linear-gradient\(red 0 0\)/u)
  assert.match(alone(glyphs, cell, 0x2591), /color-mix\(in srgb,#fff 25%,#000\)/u)
  assert.equal(inkMix(1, 'a', 'b'), 'a')
  assert.equal(inkMix(0, 'a', 'b'), 'b')
  assert.equal(inkMix(0.75, 'a', 'b'), 'color-mix(in srgb,a 75%,b)')
})
