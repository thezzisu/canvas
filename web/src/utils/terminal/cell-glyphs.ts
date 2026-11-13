/**
 * Box drawing (U+2500–257F) and block elements (U+2580–259F), drawn rather than typeset.
 *
 * A font's glyphs are anti-aliased wherever a cell edge falls between pixels and leave seams;
 * these are rectangles on whole layout pixels, the same in every cell, so lines and blocks join
 * for any font. Broad shapes are reported as tiles for the row's own background, where every
 * pixel has exactly one colour. Thin lines are rectangles of ink over that background: a hard
 * stripe thinner than a device pixel would fall between pixels and vanish on a card scaled down,
 * a rectangle fades instead.
 */

/** A cell in layout pixels: the unit the browser snaps boxes to. */
export interface GlyphCell {
  /** May be fractional; the box is as wide as its two snapped edges. */
  width: number
  height: number
  /** Thickness of a light line. */
  light: number
  /** Layout pixels per CSS pixel. */
  ratio: number
}

/** [left, top, right, bottom]; Infinity is the cell's far edge. */
type Rect = [number, number, number, number]
interface Shape {
  rects: Rect[]
  /** Share of ink in a flat shade. */
  shade?: number
  /** Gradient layers over the rectangles, given the ink and where the cell starts. */
  overlays?: ((ink: string, x: number) => string)[]
}
/** Part of a cell in layout pixels; Infinity is the cell's far edge. */
export interface GlyphTile {
  x0: number
  y0: number
  x1: number
  y1: number
  /** Share of ink over paper, 0 to 1. */
  ink: number
}

export const isDrawnGlyph = (code: number) => code >= 0x2500 && code <= 0x259f

// U+2500–257F. Four digits are the left, right, up and down arms: 1 light, 2 heavy, 3 double.
// h/v and H/V are light and heavy dashes with their count; a is an arc, d a diagonal.
const BOX = (
  '1100 2200 0011 0022 h3 H3 v3 V3 h4 H4 v4 V4 0101 0201 0102 0202 ' +
  '1001 2001 1002 2002 0110 0210 0120 0220 1010 2010 1020 2020 0111 0211 0121 0112 ' +
  '0122 0221 0212 0222 1011 2011 1021 1012 1022 2021 2012 2022 1101 2101 1201 2201 ' +
  '1102 2102 1202 2202 1110 2110 1210 2210 1120 2120 1220 2220 1111 2111 1211 2211 ' +
  '1121 1112 1122 2121 1221 2112 1212 2221 2212 2122 1222 2222 h2 H2 v2 V2 ' +
  '3300 0033 0301 0103 0303 3001 1003 3003 0310 0130 0330 3010 1030 3030 0311 0133 ' +
  '0333 3011 1033 3033 3301 1103 3303 3310 1130 3330 3311 1133 3333 a01 a11 a10 a00 ' +
  'd/ d\\ dx 1000 0010 0100 0001 2000 0020 0200 0002 1200 0012 2100 0021'
).split(' ')
// Where double lines meet, the three by three squares at the centre that are ink, row by row.
const DOUBLE_CENTRE: Record<string, string> = {
  '3300': '111000111',
  '0033': '101101101',
  '0301': '011010011',
  '0103': '000111101',
  '0303': '111100101',
  '3001': '110010110',
  '1003': '000111101',
  '3003': '111001101',
  '0310': '011010011',
  '0130': '101111000',
  '0330': '101100111',
  '3010': '110010110',
  '1030': '101111000',
  '3030': '101001111',
  '0311': '011010011',
  '0133': '101101101',
  '0333': '101100101',
  '3011': '110010110',
  '1033': '101101101',
  '3033': '101001101',
  '3301': '111000111',
  '1103': '000111101',
  '3303': '111000101',
  '3310': '111000111',
  '1130': '101111000',
  '3330': '101000111',
  '3311': '111010111',
  '1133': '101111101',
  '3333': '101000101',
}

function boxShape(spec: string, cell: GlyphCell): Shape {
  const { width, height, light } = cell
  // A light line's near edge; heavy and double lines are centred on the light one.
  const column = Math.round((width - light) / 2)
  const row = Math.round((height - light) / 2)
  const band = (start: number, weight: number): [number, number] =>
    weight === 2
      ? [start - Math.round(light / 2), start - Math.round(light / 2) + 2 * light]
      : [start, start + light]

  if (spec[0] === 'h' || spec[0] === 'H' || spec[0] === 'v' || spec[0] === 'V') {
    const horizontal = spec[0].toLowerCase() === 'h'
    const count = Number(spec[1])
    const length = horizontal ? width : height
    const [near, far] = band(horizontal ? row : column, spec[0] < 'a' ? 2 : 1)
    // A cell too small for dashes gets the solid line.
    const gap = length >= count * 2 ? Math.max(1, Math.round(length / count / 3)) : 0
    const rects: Rect[] = []
    for (let index = 0; index < count; index++) {
      const start = Math.round((index * length) / count) + (gap >> 1)
      const end = Math.round(((index + 1) * length) / count) - ((gap + 1) >> 1)
      rects.push(horizontal ? [start, near, end, far] : [near, start, far, end])
    }
    return { rects }
  }

  if (spec[0] === 'd') {
    const stops = (edge: number) => `${(light / 2 + edge) / cell.ratio}px`
    const line = (towards: string) => (ink: string, x: number) =>
      `linear-gradient(to top ${towards},transparent calc(50% - ${stops(0.5)}),${ink} calc(50% - ${stops(-0.5)}),` +
      `${ink} calc(50% + ${stops(-0.5)}),transparent calc(50% + ${stops(0.5)})) ` +
      `${x / cell.ratio}px 0/${width / cell.ratio}px ${height / cell.ratio}px no-repeat`
    // A gradient's middle line joins the two corners its direction does not name.
    return {
      rects: [],
      overlays: [
        ...(spec[1] !== '\\' ? [line('left')] : []),
        ...(spec[1] !== '/' ? [line('right')] : []),
      ],
    }
  }

  if (spec[0] === 'a') {
    const right = spec[1] === '0'
    const down = spec[2] === '1'
    // The centre is on whole pixels, so the quarter circle's box is: the browser snaps a
    // background's box, and one snapped by half a pixel would miss the lines it joins.
    const reach = Math.max(light, Math.floor(Math.min(width, height) / 2 - light / 2))
    const radius = reach - light / 2
    const centreX = right ? column + reach : column + light - reach
    const centreY = down ? row + reach : row + light - reach
    const px = (value: number) => `${+(value / cell.ratio).toFixed(4)}px`
    return {
      // The straight ends run a pixel into the arc, where the two are tangent: boxes of different
      // sizes may be snapped apart.
      rects: [
        right ? [centreX - 1, row, Infinity, row + light] : [0, row, centreX + 1, row + light],
        down
          ? [column, centreY - 1, column + light, Infinity]
          : [column, 0, column + light, centreY + 1],
      ],
      overlays: [
        (ink, x) =>
          `radial-gradient(circle at ${right ? '100%' : '0'} ${down ? '100%' : '0'},` +
          `transparent ${px(radius - light / 2 - 0.5)},${ink} ${px(radius - light / 2)},` +
          `${ink} ${px(radius + light / 2)},transparent ${px(radius + light / 2 + 0.5)}) ` +
          `${px(x + (right ? column : centreX))} ${px(down ? row : centreY)}/${px(reach)} ${px(reach)} no-repeat`,
      ],
    }
  }

  const [left, right, up, down] = [...spec].map(Number) as [number, number, number, number]
  const centre = DOUBLE_CENTRE[spec]
  if (centre) {
    const xs = [column - light, column, column + light, column + 2 * light]
    const ys = [row - light, row, row + light, row + 2 * light]
    const rects: Rect[] = []
    // A double arm is the outer two of three lanes, a single arm the middle one.
    const lanes = (weight: number) => (weight === 3 ? [0, 2] : weight ? [1] : [])
    for (const lane of lanes(left)) rects.push([0, ys[lane]!, xs[0]!, ys[lane + 1]!])
    for (const lane of lanes(right)) rects.push([xs[3]!, ys[lane]!, Infinity, ys[lane + 1]!])
    for (const lane of lanes(up)) rects.push([xs[lane]!, 0, xs[lane + 1]!, ys[0]!])
    for (const lane of lanes(down)) rects.push([xs[lane]!, ys[3]!, xs[lane + 1]!, Infinity])
    for (let index = 0; index < 9; index++)
      if (centre[index] === '1')
        rects.push([
          xs[index % 3]!,
          ys[(index / 3) | 0]!,
          xs[(index % 3) + 1]!,
          ys[((index / 3) | 0) + 1]!,
        ])
    return { rects }
  }

  // Each arm runs through the crossing to the far side of the stroke it meets, so corners are
  // square; with nothing to meet, it stops at the middle.
  const [crossLeft, crossRight] =
    up || down ? band(column, Math.max(up, down)) : [Math.round(width / 2), Math.round(width / 2)]
  const [crossTop, crossBottom] =
    left || right
      ? band(row, Math.max(left, right))
      : [Math.round(height / 2), Math.round(height / 2)]
  const rects: Rect[] = []
  if (left) rects.push([0, band(row, left)[0], crossRight, band(row, left)[1]])
  if (right) rects.push([crossLeft, band(row, right)[0], Infinity, band(row, right)[1]])
  if (up) rects.push([band(column, up)[0], 0, band(column, up)[1], crossBottom])
  if (down) rects.push([band(column, down)[0], crossTop, band(column, down)[1], Infinity])
  return { rects }
}

function blockShape(code: number, cell: GlyphCell): Shape {
  const x = (eighths: number) => Math.round((eighths * cell.width) / 8)
  const y = (eighths: number) => Math.round((eighths * cell.height) / 8)
  const quadrants: Rect[] = [
    [0, 0, x(4), y(4)],
    [x(4), 0, Infinity, y(4)],
    [0, y(4), x(4), Infinity],
    [x(4), y(4), Infinity, Infinity],
  ]
  // Upper left, upper right, lower left and lower right, for U+2596–259F.
  const QUADRANTS = ['0010', '0001', '1000', '1011', '1001', '1110', '1101', '0100', '0110', '0111']
  // The thinnest blocks keep a pixel of ink in the smallest cell.
  const near = (edge: number) => Math.max(1, edge)
  const far = (edge: number, length: number) => Math.min(edge, Math.ceil(length) - 1)
  if (code === 0x2580) return { rects: [[0, 0, Infinity, y(4)]] }
  if (code <= 0x2588)
    return { rects: [[0, far(y(0x2588 - code), cell.height), Infinity, Infinity]] }
  if (code <= 0x258f) return { rects: [[0, 0, near(x(0x2590 - code)), Infinity]] }
  if (code === 0x2590) return { rects: [[x(4), 0, Infinity, Infinity]] }
  if (code <= 0x2593) return { rects: [], shade: (code - 0x2590) / 4 }
  if (code === 0x2594) return { rects: [[0, 0, Infinity, near(y(1))]] }
  if (code === 0x2595) return { rects: [[far(x(7), cell.width), 0, Infinity, Infinity]] }
  const quadrant = QUADRANTS[code - 0x2596]!
  return { rects: quadrants.filter((_, index) => quadrant[index] === '1') }
}

/** The cell as a grid of its rectangles' edges, with the squares that are ink. */
function grid(rects: Rect[]) {
  const cuts = (values: number[]) =>
    [...new Set([0, Infinity, ...values.map((value) => Math.max(0, value))])].sort((a, b) => a - b)
  const xs = cuts(rects.flatMap((rect) => [rect[0], rect[2]]))
  const ys = cuts(rects.flatMap((rect) => [rect[1], rect[3]]))
  const ink = ys
    .slice(1)
    .map((bottom, j) =>
      xs
        .slice(1)
        .map((right, i) =>
          rects.some(
            (rect) =>
              rect[0] <= xs[i]! && right <= rect[2] && rect[1] <= ys[j]! && bottom <= rect[3],
          ),
        ),
    )
  return { xs, ys, ink }
}

/** Disjoint rectangles of ink, in reading order. */
function disjoint(rects: Rect[]): Rect[] {
  const { xs, ys, ink } = grid(rects)
  const tiles: Rect[] = []
  ink.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      if (!row[i]) continue
      const start = i
      while (row[i + 1]) i++
      const above = tiles.find(
        (tile) => tile[0] === xs[start] && tile[2] === xs[i + 1] && tile[3] === ys[j],
      )
      if (above) above[3] = ys[j + 1]!
      else tiles.push([xs[start]!, ys[j]!, xs[i + 1]!, ys[j + 1]!])
    }
  })
  return tiles
}

/**
 * The widest and the tallest rectangle through every square of ink. They overlap wherever ink
 * touches ink, so no edge between two of them is left to be anti-aliased into a seam.
 */
function overlapping(rects: Rect[]): Rect[] {
  const { xs, ys, ink } = grid(rects)
  const found = new Map<string, Rect>()
  const add = (i0: number, j0: number, i1: number, j1: number) =>
    found.set(`${i0} ${j0} ${i1} ${j1}`, [xs[i0]!, ys[j0]!, xs[i1]!, ys[j1]!])
  const filled = (i0: number, j0: number, i1: number, j1: number) => {
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) if (!ink[j]?.[i]) return false
    return j0 >= 0 && i0 >= 0
  }
  ink.forEach((row, j) =>
    row.forEach((on, i) => {
      if (!on) return
      let [left, right, top, bottom] = [i, i + 1, j, j + 1]
      while (filled(left - 1, j, left, j + 1)) left--
      while (filled(right, j, right + 1, j + 1)) right++
      while (filled(left, top - 1, right, top)) top--
      while (filled(left, bottom, right, bottom + 1)) bottom++
      add(left, top, right, bottom)
      ;[left, right, top, bottom] = [i, i + 1, j, j + 1]
      while (filled(i, top - 1, i + 1, top)) top--
      while (filled(i, bottom, i + 1, bottom + 1)) bottom++
      while (filled(left - 1, top, left, bottom)) left--
      while (filled(right, top, right + 1, bottom)) right++
      add(left, top, right, bottom)
    }),
  )
  return [...found.values()]
}

/** Further than any box reaches, in CSS pixels: a rectangle on the cell's far edge runs off it. */
const FAR = 10000

/** One character, or a run of one uniform character, in a box of drawn cells. */
export interface DrawnCells {
  code: number
  /** Where it starts and ends, in layout pixels from the box's left edge. */
  x: number
  end: number
}

export interface Glyphs {
  /** A broad shape as disjoint tiles of ink, for the row's background. */
  tiles(code: number): readonly GlyphTile[] | undefined
  /** Whether a run of this character is one shape however many cells it covers. */
  uniform(code: number): boolean
  /** The CSS `background` that draws the ink of neighbouring characters in one box. */
  paint(cells: readonly DrawnCells[], ink: string, paper: string): string
}

/** `share` of ink over paper as one colour. */
export const inkMix = (share: number, ink: string, paper: string) =>
  share >= 1 ? ink : share <= 0 ? paper : `color-mix(in srgb,${ink} ${share * 100}%,${paper})`

/** The drawn characters for one cell size; shapes and backgrounds are worked out once each. */
export function createGlyphs(cell: GlyphCell): Glyphs {
  interface Entry {
    shape: Shape
    rects: Rect[]
    tiles: GlyphTile[] | undefined
    uniform: boolean
  }
  const shapes = new Map<number, Entry>()
  const px = (value: number) => `${+(value / cell.ratio).toFixed(4)}px`
  const shapeOf = (code: number) => {
    let entry = shapes.get(code)
    if (!entry) {
      const shape = code < 0x2580 ? boxShape(BOX[code - 0x2500]!, cell) : blockShape(code, cell)
      const real = shape.rects.filter((rect) => rect[0] < rect[2] && rect[1] < rect[3])
      const rects = overlapping(real)
      const broad = (rect: Rect) =>
        Math.min(
          Math.min(rect[2], cell.width) - rect[0],
          Math.min(rect[3], cell.height) - rect[1],
        ) >
        2 * cell.light
      entry = {
        shape,
        rects,
        tiles:
          shape.shade !== undefined
            ? [{ x0: 0, y0: 0, x1: Infinity, y1: Infinity, ink: shape.shade }]
            : code >= 0x2580 && rects.every(broad)
              ? disjoint(real).map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1, ink: 1 }))
              : undefined,
        uniform: !shape.overlays && rects.every((rect) => rect[0] === 0 && rect[2] === Infinity),
      }
      shapes.set(code, entry)
    }
    return entry
  }
  return {
    tiles: (code) => shapeOf(code).tiles,
    uniform: (code) => shapeOf(code).uniform,
    paint(cells, ink, paper) {
      const layers: string[] = []
      const rect = (colour: string, x0: number, y0: number, x1: number, y1: number) =>
        layers.push(
          `linear-gradient(${colour} 0 0) ${px(x0)} ${px(y0)}/${px(x1 - x0)} ` +
            `${y1 === Infinity ? `${FAR}px` : px(y1 - y0)} no-repeat`,
        )
      cells.forEach(({ code, x, end }, index) => {
        const { shape, rects } = shapeOf(code)
        if (shape.shade !== undefined) {
          rect(inkMix(shape.shade, ink, paper), x, 0, end, Infinity)
          return
        }
        for (const overlay of shape.overlays ?? []) layers.push(overlay(ink, x))
        const next = cells[index + 1]
        const arms = next && shapeOf(next.code).rects.filter((arm) => arm[0] === 0)
        for (const [x0, y0, x1, y1] of rects) {
          // Ink that goes on in the next cell runs a little into it: where the edge between the
          // two falls between pixels, the pixel on it is then all ink.
          const joins = arms?.some((arm) => arm[1] <= y0 && y1 <= arm[3])
          rect(ink, x + x0, y0, x1 === Infinity ? end + (joins ? cell.light : 0) : x + x1, y1)
        }
      })
      return layers.join(',')
    },
  }
}
