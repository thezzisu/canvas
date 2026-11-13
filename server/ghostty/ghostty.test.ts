import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { cellWidth, ghostty } from './module.ts'
import { GhosttyTerminal, type GhosttyEvents, type ScreenRow } from './terminal.ts'

const text = (row: ScreenRow | undefined) =>
  row?.cells.map((cell) => (cell.skip ? '' : cell.symbol)).join('')
function terminal(cols: number, rows: number, events?: GhosttyEvents) {
  const value = new GhosttyTerminal(cols, rows, 100, events)
  return Object.assign(value, { [Symbol.dispose]: () => value.free() })
}

test('the vendored module is the recorded upstream release', () => {
  const wasm = readFileSync(new URL('./ghostty-vt.wasm', import.meta.url))
  const recorded = /SHA-256 \| `([0-9a-f]{64})`/u.exec(
    readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  )?.[1]
  assert.equal(createHash('sha256').update(wasm).digest('hex'), recorded)
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(wasm)), [])
})

test('cell widths follow the grapheme rules the terminal prints with', () => {
  for (const [value, width] of [
    ['a', 1],
    ['é', 1],
    ['é', 1],
    ['中', 2],
    ['👨‍👩‍👧‍👦', 2],
    ['🇨🇳', 2],
    ['1️⃣', 2],
    ['👍🏽', 2],
    ['👨‍👩‍👧‍👦👩‍👩‍👧‍👧é中A', 8],
  ] as const)
    assert.equal(cellWidth(value), width, value)
})

test('a row carries text, clusters, wide cells, colours, attributes and links', () => {
  using t = terminal(24, 4)
  t.write('a\x1b[1;3;31mb\x1b[0;48;5;200;38;2;1;2;3mc\x1b[0;4:3;9;7;2;5;8md\x1b[0m 中é👨‍👩‍👧\r\n')
  t.write('\x1b]8;;https://example.test/a b\x1b\\link\x1b]8;;\x1b\\ \x1b[44m\x1b[K')
  const rows = t.read()
  assert.equal(text(rows[0]), 'abcd 中é👨‍👩‍👧' + ' '.repeat(14))
  const [a, b, c, d, , wide, tail] = rows[0]!.cells
  assert.deepEqual(a, { symbol: 'a', fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null })
  assert.deepEqual([b!.fg, b!.modifier], [0x1000001, 1 | 4])
  assert.deepEqual([c!.fg, c!.bg], [0x2010203, 0x10000c8])
  // Dim, underline (curly), blink, inverse, invisible, strike.
  assert.equal(d!.modifier, 2 | 8 | (3 << 12) | 16 | 64 | 128 | 256)
  assert.deepEqual([wide!.symbol, wide!.skip, tail!.skip], ['中', false, true])
  assert.equal(rows[0]!.links, undefined)
  assert.deepEqual(
    [...rows[1]!.links!],
    [0, 1, 2, 3].map((column) => [column, 'https://example.test/a b']),
  )
  // An erased cell keeps only its background.
  assert.deepEqual(rows[1]!.cells[10], {
    symbol: ' ',
    fg: 0,
    bg: 0x1000004,
    modifier: 0,
    skip: false,
    hyperlink: null,
  })
  assert.equal(rows[3]!.cells[0], rows[2]!.cells[0], 'untouched cells are one shared blank')
})

test('only changed rows are read again, and a resize reads them all', () => {
  using t = terminal(10, 3)
  t.write('one\r\ntwo')
  const first = t.read()
  const [one, two] = first
  t.write('!')
  const second = t.read()
  assert.equal(second[0], one)
  assert.notEqual(second[1], two)
  assert.equal(text(second[1]), 'two!      ')
  assert.equal(t.read()[1], second[1])
  t.resize(6, 2)
  const resized = t.read()
  assert.deepEqual([resized.length, resized[0]!.cells.length, t.cols, t.rows], [2, 6, 6, 2])
})

test('soft wraps are told apart from new lines, on screen and in history', () => {
  using t = terminal(4, 3)
  t.write('abcdef\r\ng\r\nh\r\ni')
  assert.deepEqual(
    t.read().map((row) => [text(row)!.trimEnd(), row.wrapped]),
    [
      ['g', false],
      ['h', false],
      ['i', false],
    ],
  )
  assert.deepEqual(t.scroll, { top: 2, max: 2 })
  assert.deepEqual(
    [0, 1, 2].map((y) => {
      const line = t.line(y)!
      return [
        line.cells
          .map((cell) => cell.text)
          .join('')
          .trimEnd(),
        line.wrapped,
      ]
    }),
    [
      ['abcd', false],
      ['ef', true],
      ['g', false],
    ],
  )
  assert.equal(t.line(5), undefined)
  t.write('\x1b[8mx\x1b[0m中')
  assert.deepEqual(
    t.line(4)!.cells.map((cell) => [cell.text, cell.width, cell.invisible]),
    [
      ['i', 1, false],
      ['x', 1, true],
      ['中', 2, false],
      [' ', 0, false],
    ],
  )
})

test('the viewport scrolls through history and the cursor leaves with its row', () => {
  using t = terminal(8, 2)
  for (let line = 0; line < 6; line++) t.write(`\r\nline ${line}`)
  assert.equal(text(t.read()[1]), 'line 5  ')
  assert.deepEqual(t.cursor(), { x: 6, y: 1, visible: true, shape: 1 })
  t.scrollTo(1)
  assert.deepEqual(t.scroll, { top: 1, max: 5 })
  assert.equal(text(t.read()[0]), 'line 0  ')
  assert.equal(t.cursor(), undefined)
  t.write('\r\nline 6')
  assert.equal(text(t.read()[0]), 'line 0  ', 'new output leaves a scrolled viewport where it is')
  t.scrollTo(99)
  assert.deepEqual(t.scroll, { top: 6, max: 6 })
  assert.equal(text(t.read()[1]), 'line 6  ')
  t.write('\x1b[?25l\x1b[4 q')
  t.read()
  assert.deepEqual(t.cursor(), { x: 6, y: 1, visible: false, shape: 4 })
  t.write('\x1b[5 q\x1b[?1049h')
  t.read()
  assert.equal(t.cursor()!.shape, 5)
  assert.deepEqual([t.alternateScreen, t.scroll], [true, { top: 0, max: 0 }])
})

test('modes, bells, clipboard writes and status reports are observed, queries are not answered', () => {
  const seen: unknown[] = []
  using t = terminal(20, 2, {
    bell: () => seen.push('bell'),
    clipboard: (data) => seen.push(Buffer.from(data).toString()),
    status: (id, state) => seen.push([id, state]),
  })
  assert.deepEqual(
    [t.mouseReporting, t.mode(2004), t.mode(1016), t.kittyKeyboard],
    [false, false, false, 0],
  )
  t.write('\x1b[?1002h\x1b[?2004h\x1b[?1016h\x1b[>5u')
  assert.deepEqual(
    [t.mouseReporting, t.mode(2004), t.mode(1016), t.kittyKeyboard],
    [true, true, true, 5],
  )
  t.write('\x07\x1b]52;c;aGVsbG8g8J+mig==\x07\x1b]52;c;?\x07')
  t.write(
    '\x1b]7501;state=working\x1b\\\x1b]7501;state=nonsense\x07\x1b]7501;id=job:state=done\x07',
  )
  // Device attributes, cursor position and a colour query: the core answers these, not a viewer.
  t.write('\x1b[c\x1b[6n\x1b]11;?\x07')
  assert.deepEqual(seen, ['bell', 'hello 🦊', ['', 'working'], ['job', 'done']])
})

test('freed terminals return their memory to the module', () => {
  const make = () => {
    const terminals = Array.from({ length: 20 }, () => new GhosttyTerminal(120, 40, 2000))
    for (const t of terminals) {
      for (let line = 0; line < 500; line++) t.write(`\x1b[3${line % 8}mline ${line}\r\n`)
      t.read()
    }
    for (const t of terminals) t.free()
  }
  make()
  const settled = ghostty().memoryBytes
  for (let round = 0; round < 5; round++) make()
  assert.ok(
    ghostty().memoryBytes <= settled * 1.25,
    `${settled} bytes grew to ${ghostty().memoryBytes}`,
  )
})
