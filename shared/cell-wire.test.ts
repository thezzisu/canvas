import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTR,
  CellMirror,
  CellTables,
  CellWireError,
  DEFAULT_COLOUR,
  PALETTE_COLOUR,
  RowEncoder,
  UNDERLINE_MASK,
  UNDERLINE_SHIFT,
  encodeFrame,
  encodePatch,
  type CellCursor,
  type CellStyle,
} from './cell-wire.ts'

type Cell = { text: string; wide?: boolean; style?: number }
const hidden: CellCursor = { x: 0, y: 0, visible: false, blink: false, shape: 'block' }
const plain: CellStyle = {
  attrs: 0,
  fg: DEFAULT_COLOUR,
  bg: DEFAULT_COLOUR,
  underline: DEFAULT_COLOUR,
  link: 0,
}
function row(cells: readonly Cell[]) {
  const encoder = new RowEncoder()
  for (const cell of cells) encoder.cell(cell.style ?? 0, cell.text, cell.wide ?? false)
  return encoder.finish()
}
const letters = (text: string, style = 0): Cell[] => Array.from(text, (text) => ({ text, style }))
/** The cells a mirror holds for one row, as they were given to the encoder. */
function cells(mirror: CellMirror, y: number): Cell[] {
  return mirror.lines[y]!.flatMap((run) =>
    Array.from(run.text, (text) => ({ text, wide: run.wide, style: run.style })),
  )
}
const full = (cell: Cell) => ({ wide: false, style: 0, ...cell })
function frame(lines: readonly (readonly Cell[])[], cols: number, styles = [plain]) {
  return encodeFrame({
    revision: 1,
    cols,
    rows: lines.length,
    cursor: hidden,
    links: [],
    styles,
    lines: lines.map((cells, y) => ({ y, runs: row(cells) })),
  })
}
const rejects = (mirror: CellMirror, bytes: Uint8Array, message: RegExp) =>
  assert.throws(
    () => mirror.apply(bytes),
    (error) => error instanceof CellWireError && message.test(error.message),
  )

test('a frame round-trips its size, defaults, cursor, tables and every kind of cell', () => {
  const tables = new CellTables()
  const styled = tables.style(
    ATTR.bold | ATTR.italic | (3 << UNDERLINE_SHIFT),
    0x123456,
    PALETTE_COLOUR | 201,
    0xff0000,
    'https://example.com/a b',
  )
  const selected = tables.style(ATTR.selected, DEFAULT_COLOUR, DEFAULT_COLOUR, DEFAULT_COLOUR, '')
  assert.equal(tables.style(ATTR.selected, DEFAULT_COLOUR, DEFAULT_COLOUR, DEFAULT_COLOUR, ''), 1)
  const first: Cell[] = [
    ...letters('ab  ', styled),
    { text: 'é', style: styled },
    { text: '中', wide: true, style: styled },
    { text: '😀', wide: true, style: styled },
    { text: 'é', style: selected },
    { text: '👩‍💻', wide: true, style: selected },
    ...letters('z  ', selected),
  ]
  const second: Cell[] = letters(' '.repeat(15), styled)
  const mirror = new CellMirror()
  const applied = mirror.apply(
    encodeFrame({
      revision: 7,
      cols: 15,
      rows: 2,
      foreground: 0xe5e5e5,
      background: 0x000102,
      cursor: { x: 14, y: 1, visible: true, blink: true, shape: 'bar' },
      links: tables.links,
      styles: tables.styles,
      lines: [
        { y: 0, runs: row(first) },
        { y: 1, runs: row(second) },
      ],
    }),
  )
  assert.deepEqual(applied, { frame: true, rows: [0, 1] })
  assert.deepEqual(
    [mirror.revision, mirror.cols, mirror.rows, mirror.foreground, mirror.background],
    [7, 15, 2, 0xe5e5e5, 0x000102],
  )
  assert.deepEqual(mirror.cursor, { x: 14, y: 1, visible: true, blink: true, shape: 'bar' })
  assert.deepEqual(mirror.links, ['https://example.com/a b'])
  assert.deepEqual(mirror.styles, [
    {
      attrs: ATTR.bold | ATTR.italic | (3 << UNDERLINE_SHIFT),
      fg: 0x123456,
      bg: PALETTE_COLOUR | 201,
      underline: 0xff0000,
      link: 1,
    },
    { ...plain, attrs: ATTR.selected },
  ])
  assert.deepEqual(cells(mirror, 0), first.map(full))
  assert.deepEqual(cells(mirror, 1), second.map(full))
  assert.deepEqual(
    mirror.lines[0]!.map((run) => [run.column, run.columns]),
    [
      [0, 5],
      [5, 4],
      [9, 1],
      [10, 2],
      [12, 1],
      [13, 2],
    ],
  )
  assert.equal(mirror.lines[1]!.length, 1, 'a blank row is one run')
})

test('every attribute, underline style, colour form and cursor shape survives', () => {
  const styles: CellStyle[] = [
    ...Object.values(ATTR).map((attrs) => ({ ...plain, attrs })),
    ...[1, 2, 3, 4, 5].map((style) => ({ ...plain, attrs: style << UNDERLINE_SHIFT })),
    {
      ...plain,
      attrs: Object.values(ATTR).reduce((all, bit) => all | bit, UNDERLINE_MASK & 0x500),
    },
    { ...plain, fg: 0, bg: 0xffffff, underline: PALETTE_COLOUR },
    { ...plain, fg: PALETTE_COLOUR | 255, bg: PALETTE_COLOUR | 7, underline: 0x010203 },
  ]
  const mirror = new CellMirror()
  mirror.apply(frame([styles.map((_, style) => ({ text: 'x', style }))], styles.length, styles))
  assert.deepEqual(mirror.styles, styles)
  assert.deepEqual(
    cells(mirror, 0).map((cell) => cell.style),
    styles.map((_, index) => index),
  )
  assert.equal(mirror.foreground, undefined)
  assert.equal(mirror.background, undefined)
  for (const shape of ['block', 'underline', 'bar'] as const)
    for (const blink of [false, true])
      for (const visible of [false, true]) {
        const cursor = { x: 1, y: 0, visible, blink, shape }
        mirror.apply(
          encodePatch({
            revision: mirror.revision + 1,
            base: mirror.revision,
            cursor,
            links: [],
            styles: [],
            lines: [],
          }),
        )
        assert.deepEqual(mirror.cursor, cursor)
      }
})

test('a patch replaces only its rows and appends to the tables of its frame', () => {
  const mirror = new CellMirror()
  mirror.apply(frame([letters('one '), letters('two '), letters('tre ')], 4))
  const applied = mirror.apply(
    encodePatch({
      revision: 5,
      base: 1,
      cursor: { ...hidden, x: 3, y: 2, visible: true },
      links: ['file:///tmp/x'],
      styles: [{ ...plain, fg: 0xff00ff, link: 1 }],
      lines: [{ y: 1, runs: row(letters('TWO!', 1)) }],
    }),
  )
  assert.deepEqual(applied, { frame: false, rows: [1] })
  assert.equal(mirror.revision, 5)
  assert.deepEqual(mirror.styles, [plain, { ...plain, fg: 0xff00ff, link: 1 }])
  assert.deepEqual(mirror.links, ['file:///tmp/x'])
  assert.deepEqual(
    [0, 1, 2].map((y) =>
      cells(mirror, y)
        .map((cell) => cell.text)
        .join(''),
    ),
    ['one ', 'TWO!', 'tre '],
  )
  assert.equal(cells(mirror, 1)[0]!.style, 1)
  assert.deepEqual(mirror.cursor, { ...hidden, x: 3, y: 2, visible: true })
})

test('a frame empties both tables and replaces a grid of another size', () => {
  const mirror = new CellMirror()
  const styles = [plain, { ...plain, attrs: ATTR.bold, link: 1 }]
  mirror.apply(
    encodeFrame({
      revision: 3,
      cols: 2,
      rows: 1,
      cursor: hidden,
      links: ['https://a.example'],
      styles,
      lines: [{ y: 0, runs: row(letters('ab', 1)) }],
    }),
  )
  mirror.apply(frame([letters('xyz'), letters('   ')], 3, [{ ...plain, attrs: ATTR.dim }]))
  assert.deepEqual([mirror.cols, mirror.rows, mirror.revision], [3, 2, 1])
  assert.deepEqual(mirror.links, [])
  assert.deepEqual(mirror.styles, [{ ...plain, attrs: ATTR.dim }])
  assert.equal(mirror.lines.length, 2)
  const patch = { revision: 2, base: 1, cursor: hidden, links: [], styles: [] }
  rejects(
    mirror,
    encodePatch({ ...patch, lines: [{ y: 0, runs: row(letters('abc', 1)) }] }),
    /unknown style 1/,
  )
  rejects(mirror, encodePatch({ ...patch, styles, lines: [] }), /unknown link 0/)
})

test('a patch for another revision is rejected and changes nothing', () => {
  const mirror = new CellMirror()
  const patch = (base: number, revision: number) =>
    encodePatch({
      revision,
      base,
      cursor: hidden,
      links: [],
      styles: [],
      lines: [{ y: 0, runs: row(letters('new ')) }],
    })
  rejects(mirror, patch(0, 1), /does not follow -1/)
  mirror.apply(frame([letters('old ')], 4))
  rejects(mirror, patch(0, 2), /patch 0→2 does not follow 1/)
  rejects(mirror, patch(2, 3), /does not follow 1/)
  rejects(mirror, patch(1, 1), /does not follow 1/)
  assert.equal(mirror.revision, 1)
  assert.equal(
    cells(mirror, 0)
      .map((cell) => cell.text)
      .join(''),
    'old ',
  )
  mirror.apply(patch(1, 2))
  rejects(mirror, patch(1, 3), /does not follow 2/)
})

test('malformed input fails with a clear error and leaves the mirror as it was', () => {
  const mirror = new CellMirror()
  const good = frame([[...letters('ab'), { text: '中', wide: true }]], 4)
  mirror.apply(good)
  const before = structuredClone({ ...mirror })
  const update = { revision: 2, base: 1, cursor: hidden, links: [], styles: [] }
  const patched = (runs: number[], y = 0) =>
    encodePatch({ ...update, lines: [{ y, runs: Uint8Array.from(runs) }] })
  const cases: [string, Uint8Array, RegExp][] = [
    ['empty', new Uint8Array(0), /truncated kind/],
    ['unknown kind', Uint8Array.from([9, 1]), /unknown kind 9/],
    ['zero size', Uint8Array.from([1, 1, 0, 4, 0]), /grid size 0x4/],
    ['huge size', Uint8Array.from([1, 1, 0xff, 0x7f, 0xff, 0x7f, 0]), /grid size 16383x16383/],
    ['unknown defaults', Uint8Array.from([1, 1, 4, 1, 8]), /unknown defaults/],
    ['overlong integer', Uint8Array.from([1, ...Array(9).fill(0xff)]), /revision is too large/],
    ['trailing bytes', Uint8Array.from([...good, 0]), /trailing bytes/],
    [
      'cursor outside',
      encodePatch({ ...update, cursor: { ...hidden, x: 4 }, lines: [] }),
      /cursor outside the grid/,
    ],
    [
      'unknown cursor shape',
      Uint8Array.from([2, 2, 1, 3 << 2, 0, 0, 0, 0, 0]),
      /cursor outside the grid/,
    ],
    [
      'style count beyond the message',
      Uint8Array.from([2, 2, 1, 0, 0, 0, 0, 0xff, 0x7f]),
      /truncated styles/,
    ],
    [
      'unknown colour tag',
      Uint8Array.from([2, 2, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 0, 0, 0]),
      /unknown colour tag 3/,
    ],
    [
      'unknown attribute bits',
      encodePatch({ ...update, styles: [{ ...plain, attrs: 0x8000 }], lines: [] }),
      /unknown style attributes/,
    ],
    [
      'unknown underline style',
      encodePatch({ ...update, styles: [{ ...plain, attrs: 6 << UNDERLINE_SHIFT }], lines: [] }),
      /unknown style attributes/,
    ],
    [
      'link index',
      encodePatch({ ...update, styles: [{ ...plain, link: 1 }], lines: [] }),
      /unknown link 0/,
    ],
    [
      'link that is not UTF-8',
      Uint8Array.from([2, 2, 1, 0, 0, 0, 1, 2, 0xc3, 0x28, 0, 0]),
      /link is not UTF-8/,
    ],
    ['row outside the grid', patched([5, 4], 1), /rows out of order/],
    [
      'rows out of order',
      encodePatch({
        ...update,
        lines: [
          { y: 0, runs: row(letters('abcd')) },
          { y: 0, runs: row(letters('abcd')) },
        ],
      }),
      /wrong number of rows|rows out of order/,
    ],
    ['short row', patched([0, 3, 97, 98, 99]), /row does not cover every column/],
    ['long row', patched([5, 5]), /run outside its row/],
    ['wide run past the edge', patched([5, 3, 2, 1, 3, 0xe4, 0xb8, 0xad]), /run outside its row/],
    ['empty run', patched([5, 4, 5, 0]), /run outside its row/],
    ['unknown run kind', patched([6, 4]), /unknown run kind 6/],
    ['unknown style', patched([(1 << 3) | 5, 4]), /unknown style 1/],
    ['control character', patched([0, 4, 97, 7, 98, 99]), /not printable ASCII/],
    ['truncated run', patched([0, 4, 97]), /truncated run text/],
    ['code points short of the run', patched([1, 4, 2, 0xc3, 0xa9]), /does not match its length/],
    ['run text that is not UTF-8', patched([1, 4, 2, 0xc3, 0x28]), /run text is not UTF-8/],
    ['empty cluster', patched([3, 4, 0, 0, 0, 0]), /empty cell/],
    [
      'row length beyond the message',
      Uint8Array.from([2, 2, 1, 0, 0, 0, 0, 0, 1, 0, 0x7f, 5, 4]),
      /truncated row/,
    ],
    [
      'frame with a missing row',
      encodeFrame({ ...update, cols: 4, rows: 2, lines: [{ y: 0, runs: row(letters('abcd')) }] }),
      /wrong number of rows/,
    ],
  ]
  for (const [name, bytes, message] of cases) {
    rejects(mirror, bytes, message)
    assert.deepEqual({ ...mirror }, before, name)
  }
  for (let length = 0; length < good.length; length++)
    assert.throws(() => new CellMirror().apply(good.subarray(0, length)), CellWireError)
})

test('a 500x200 grid of distinct styles and wide clusters round-trips, then patches', () => {
  const cols = 500,
    rows = 200,
    tables = new CellTables()
  const text = (x: number, y: number) =>
    x % 50 === 48 ? '👩‍💻' : x % 7 === 3 ? 'é' : String.fromCharCode(33 + ((x + y) % 90))
  const line = (y: number, shift = 0): Cell[] => {
    const cells: Cell[] = []
    for (let x = 0; x < cols; x++) {
      const wide = x % 50 === 48
      cells.push({
        text: text(x + shift, y),
        wide,
        style: tables.style(0, (y << 8) | (x >> 1), DEFAULT_COLOUR, DEFAULT_COLOUR, ''),
      })
      if (wide) x++
    }
    return cells
  }
  const grid = Array.from({ length: rows }, (_, y) => line(y))
  const mirror = new CellMirror()
  mirror.apply(
    encodeFrame({
      revision: 1,
      cols,
      rows,
      cursor: { ...hidden, x: 499, y: 199, visible: true },
      links: tables.links,
      styles: tables.styles,
      lines: grid.map((cells, y) => ({ y, runs: row(cells) })),
    }),
  )
  assert.equal(mirror.styles.length, 50_000)
  for (let y = 0; y < rows; y++) assert.deepEqual(cells(mirror, y), grid[y]!.map(full))
  const known = tables.styles.length
  const changed = line(199, 50).map((cell) => ({
    ...cell,
    style: tables.style(ATTR.inverse, cell.style!, DEFAULT_COLOUR, DEFAULT_COLOUR, ''),
  }))
  assert.deepEqual(
    mirror.apply(
      encodePatch({
        revision: 2,
        base: 1,
        cursor: hidden,
        links: [],
        styles: tables.styles.slice(known),
        lines: [{ y: 199, runs: row(changed) }],
      }),
    ),
    { frame: false, rows: [199] },
  )
  assert.deepEqual(cells(mirror, 199), changed.map(full))
  assert.deepEqual(cells(mirror, 198), grid[198]!.map(full))
})

test('tables hand out stable indices and start over when cleared', () => {
  const tables = new CellTables()
  const a = tables.style(ATTR.bold, 1, 2, 3, 'https://a.example'),
    b = tables.style(ATTR.bold, 1, 2, 3, 'https://b.example')
  assert.deepEqual([a, b, tables.style(ATTR.bold, 1, 2, 3, 'https://a.example')], [0, 1, 0])
  assert.deepEqual(tables.links, ['https://a.example', 'https://b.example'])
  tables.clear()
  assert.equal(tables.style(0, 1, 2, 3, 'https://b.example'), 0)
  assert.deepEqual(tables.links, ['https://b.example'])
  assert.deepEqual(tables.styles, [{ attrs: 0, fg: 1, bg: 2, underline: 3, link: 1 }])
})
