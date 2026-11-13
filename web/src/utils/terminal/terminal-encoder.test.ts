import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import headless from '@xterm/headless'
import { VtInputParser } from '../../../../server/herdr/input.ts'
import { terminalSurfaceModes } from '../../../../shared/terminal-mouse.ts'
import {
  encodeFocus,
  encodeKey,
  encodeMouse,
  encodePaste,
  type EncodedKey,
  type EncodedMouse,
} from './terminal-encoder.ts'

interface Key extends EncodedKey {
  keyCode: number
}
type XtermKey = (
  event: Key,
  applicationCursor: boolean,
  mac: boolean,
  macOptionIsMeta: boolean,
) => { type: number; key?: string }

const xtermSource = () =>
  readFileSync(createRequire(import.meta.url).resolve('@xterm/xterm/lib/xterm.mjs'), 'utf8')

/**
 * xterm.js's own keyboard evaluation, taken from the installed bundle: it is not exported, so
 * the function and the two tables it reads are cut out of the source by their shapes.
 */
function xtermKeyboard(): XtermKey {
  const source = xtermSource()
  const head = /function (\w+)\(\w,\w,\w,\w\)\{let \w=\{type:0,cancel:!1,key:void 0\}/u.exec(source)
  const table = /var (\w+)=(\{48:\["0","\)"\].*?\});/u.exec(source)
  const controls = /(\w+)\.ESC\+"OA"/u.exec(source)
  assert(head && table && controls, 'xterm.js keyboard evaluation not found in the bundle')
  let end = source.indexOf('{', head.index)
  for (let depth = 0; ; end++) {
    if (source[end] === '{') depth++
    if (source[end] === '}' && !--depth) break
  }
  const names = {
    NUL: '\0',
    ETX: '\x03',
    BS: '\b',
    HT: '\t',
    CR: '\r',
    ESC: '\x1b',
    FS: '\x1c',
    GS: '\x1d',
    US: '\x1f',
    DEL: '\x7f',
  }
  return new Function(
    controls[1]!,
    `var ${table[1]}=${table[2]};${source.slice(head.index, end + 1)};return ${head[1]}`,
  )(names) as XtermKey
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const DIGITS = ')!@#$%^&*('
const PUNCTUATION: [string, number, string, string][] = [
  ['Semicolon', 186, ';', ':'],
  ['Equal', 187, '=', '+'],
  ['Comma', 188, ',', '<'],
  ['Minus', 189, '-', '_'],
  ['Period', 190, '.', '>'],
  ['Slash', 191, '/', '?'],
  ['Backquote', 192, '`', '~'],
  ['BracketLeft', 219, '[', '{'],
  ['Backslash', 220, '\\', '|'],
  ['BracketRight', 221, ']', '}'],
  ['Quote', 222, "'", '"'],
]
const NAMED: [string, number][] = [
  ['Backspace', 8],
  ['Tab', 9],
  ['Enter', 13],
  ['Escape', 27],
  ['PageUp', 33],
  ['PageDown', 34],
  ['End', 35],
  ['Home', 36],
  ['ArrowLeft', 37],
  ['ArrowUp', 38],
  ['ArrowRight', 39],
  ['ArrowDown', 40],
  ['Insert', 45],
  ['Delete', 46],
  ...Array.from({ length: 12 }, (_, index): [string, number] => [`F${index + 1}`, 112 + index]),
]
const NUMPAD: [string, string, number][] = [
  ...Array.from({ length: 10 }, (_, digit): [string, string, number] => [
    `Numpad${digit}`,
    String(digit),
    96 + digit,
  ]),
  ['NumpadMultiply', '*', 106],
  ['NumpadAdd', '+', 107],
  ['NumpadSubtract', '-', 109],
  ['NumpadDecimal', '.', 110],
  ['NumpadDivide', '/', 111],
  ['NumpadEnter', 'Enter', 13],
  // Without NumLock the pad is a navigation cluster.
  ['Numpad7', 'Home', 36],
  ['Numpad1', 'End', 35],
  ['Numpad8', 'ArrowUp', 38],
  ['Numpad9', 'PageUp', 33],
  ['Numpad0', 'Insert', 45],
  ['NumpadDecimal', 'Delete', 46],
]

/** Every key of a US keyboard as the browser reports it, under one combination of modifiers. */
function keyboard(modifiers: number): Key[] {
  const held = {
    shiftKey: !!(modifiers & 1),
    altKey: !!(modifiers & 2),
    ctrlKey: !!(modifiers & 4),
    metaKey: !!(modifiers & 8),
  }
  const shift = held.shiftKey
  return [
    ...[...LETTERS].map((letter) => ({
      key: shift ? letter.toUpperCase() : letter,
      code: `Key${letter.toUpperCase()}`,
      keyCode: letter.toUpperCase().charCodeAt(0),
    })),
    ...[...DIGITS].map((shifted, digit) => ({
      key: shift ? shifted : String(digit),
      code: `Digit${digit}`,
      keyCode: 48 + digit,
    })),
    ...PUNCTUATION.map(([code, keyCode, plain, shifted]) => ({
      key: shift ? shifted : plain,
      code,
      keyCode,
    })),
    { key: ' ', code: 'Space', keyCode: 32 },
    ...NAMED.map(([key, keyCode]) => ({ key, code: key, keyCode })),
    ...NUMPAD.map(([code, key, keyCode]) => ({ key, code, keyCode })),
  ].map((key) => ({ ...key, ...held }))
}

const describe = (key: Key) =>
  `${key.ctrlKey ? 'Ctrl+' : ''}${key.altKey ? 'Alt+' : ''}${key.shiftKey ? 'Shift+' : ''}` +
  `${key.metaKey ? 'Meta+' : ''}${key.code} (${JSON.stringify(key.key)})`

/** What xterm.js sends for a key: its evaluation, then the text its keypress handler adds. */
function xtermBytes(evaluate: XtermKey, key: Key, mac: boolean): string | undefined {
  const result = evaluate(key, true, mac, false)
  // Shift+PageUp and Shift+PageDown scroll xterm.js's own buffer and send nothing.
  if (result.type === 2 || result.type === 3) return ''
  if (result.key !== undefined) return result.key
  // A keydown without bytes is followed by a keypress carrying the character, modifiers allowing.
  const text = !key.ctrlKey && !key.altKey && !key.metaKey && key.key.length === 1
  return text ? key.key : undefined
}

test('every key and modifier combination sends what xterm.js 6 sends', () => {
  const evaluate = xtermKeyboard()
  let compared = 0
  for (const mac of [false, true])
    for (let modifiers = 0; modifiers < 16; modifiers++)
      for (const key of keyboard(modifiers)) {
        assert.equal(
          encodeKey(key, mac),
          xtermBytes(evaluate, key, mac),
          `${mac ? 'mac ' : ''}${describe(key)}`,
        )
        compared++
      }
  assert.equal(compared, 2 * 16 * 96)
})

test('the keys a terminal user needs, spelled out', () => {
  const key = (name: string, modifiers = '', code = name): EncodedKey => ({
    key: name,
    code,
    ctrlKey: modifiers.includes('c'),
    altKey: modifiers.includes('a'),
    shiftKey: modifiers.includes('s'),
    metaKey: modifiers.includes('m'),
  })
  const cases: [EncodedKey, string | undefined][] = [
    [key('a', '', 'KeyA'), 'a'],
    [key('A', 's', 'KeyA'), 'A'],
    [key('c', 'c', 'KeyC'), '\x03'],
    [key(' ', 'c', 'Space'), '\0'],
    [key('[', 'c', 'BracketLeft'), '\x1b'],
    [key('b', 'a', 'KeyB'), '\x1bb'],
    [key('B', 'as', 'KeyB'), '\x1bB'],
    [key('c', 'ca', 'KeyC'), '\x1b\x03'],
    [key('Enter'), '\r'],
    [key('Enter', 'a'), '\x1b\r'],
    [key('Tab'), '\t'],
    [key('Tab', 's'), '\x1b[Z'],
    [key('Backspace'), '\x7f'],
    [key('Backspace', 'c'), '\b'],
    [key('Backspace', 'a'), '\x1b\x7f'],
    [key('Escape'), '\x1b'],
    // The surface is always in application cursor mode.
    [key('ArrowUp'), '\x1bOA'],
    [key('ArrowLeft', 'c'), '\x1b[1;5D'],
    [key('ArrowRight', 'cs'), '\x1b[1;6C'],
    [key('Home'), '\x1bOH'],
    [key('End', 's'), '\x1b[1;2F'],
    [key('PageUp'), '\x1b[5~'],
    [key('PageDown', 'c'), '\x1b[6;5~'],
    [key('PageUp', 's'), ''],
    [key('Insert'), '\x1b[2~'],
    [key('Insert', 's'), undefined],
    [key('Delete'), '\x1b[3~'],
    [key('Delete', 'a'), '\x1b[3;3~'],
    [key('F1'), '\x1bOP'],
    [key('F4', 's'), '\x1b[1;2S'],
    [key('F5'), '\x1b[15~'],
    [key('F12', 'c'), '\x1b[24;5~'],
    [key('5', '', 'Numpad5'), '5'],
    [key('Enter', '', 'NumpadEnter'), '\r'],
    // Not the terminal's: a browser shortcut, a modifier alone, an input method.
    [key('v', 'cs', 'KeyV'), undefined],
    [key('t', 'm', 'KeyT'), undefined],
    [key('Shift', 's', 'ShiftLeft'), undefined],
    [key('Dead', '', 'Quote'), undefined],
    [key('Process', '', 'KeyA'), undefined],
  ]
  for (const [event, bytes] of cases) assert.equal(encodeKey(event), bytes, JSON.stringify(event))
})

test('a chord follows the layout for Latin letters and the position otherwise', () => {
  const chord = (key: string, code: string): EncodedKey => ({
    key,
    code,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  })
  // AZERTY has A where QWERTY has Q.
  assert.equal(encodeKey(chord('a', 'KeyQ')), '\x01')
  // A Cyrillic layout has no Latin C; the key in its place sends Ctrl+C.
  assert.equal(encodeKey(chord('с', 'KeyC')), '\x03')
  // A printable with no modifier is whatever the layout typed, astral characters included.
  assert.equal(encodeKey({ ...chord('é', 'Digit2'), ctrlKey: false }), 'é')
  assert.equal(encodeKey({ ...chord('😀', ''), ctrlKey: false }), '😀')
})

/** A headless xterm.js in the surface's modes; returns what it reports for mouse and focus. */
function xtermSurface() {
  const terminal = new headless.Terminal({ cols: 300, rows: 100, allowProposedApi: true })
  const sent: string[] = []
  terminal.onData((data) => sent.push(data))
  const core = (
    terminal as unknown as {
      _core: {
        coreMouseService: { triggerMouseEvent(event: Record<string, unknown>): boolean }
        coreService: { decPrivateModes: { sendFocus: boolean; bracketedPasteMode: boolean } }
      }
    }
  )._core
  return {
    terminal,
    core,
    ready: new Promise<void>((resolve) => terminal.write(terminalSurfaceModes, resolve)),
    take: () => sent.splice(0).join(''),
  }
}

test('mouse reports are what xterm.js 6 sends in the surface modes', async () => {
  const surface = xtermSurface()
  await surface.ready
  const buttons = { left: 0, middle: 1, right: 2, none: 3, up: 4, down: 4 }
  const actions = { press: 1, release: 0, move: 32 }
  let compared = 0
  for (const type of ['press', 'release', 'move', 'wheel'] as const)
    for (const button of ['left', 'middle', 'right', 'none', 'up', 'down'] as const)
      for (let modifiers = 0; modifiers < 8; modifiers++)
        for (const [column, row] of [
          [0, 0],
          [7, 3],
          [222, 0],
          [299, 99],
        ] as const) {
          const event: EncodedMouse = {
            type,
            button,
            column,
            row,
            shift: !!(modifiers & 1),
            alt: !!(modifiers & 2),
            ctrl: !!(modifiers & 4),
          }
          // A wheel direction is only a wheel event; xterm.js names its direction by the action.
          const wheel = button === 'up' || button === 'down'
          const sent =
            wheel === (type === 'wheel') &&
            surface.core.coreMouseService.triggerMouseEvent({
              col: column,
              row,
              x: 0,
              y: 0,
              button: buttons[button],
              action: wheel ? (button === 'up' ? 0 : 1) : actions[type as keyof typeof actions],
              ctrl: event.ctrl,
              alt: event.alt,
              shift: event.shift,
            })
          assert.equal(encodeMouse(event), sent ? surface.take() : '', JSON.stringify(event))
          // xterm.js drops a motion report that repeats the last one; clear what it remembers.
          surface.core.coreMouseService.triggerMouseEvent({
            col: 150,
            row: 50,
            x: 0,
            y: 0,
            button: 3,
            action: 32,
            ctrl: false,
            alt: false,
            shift: false,
          })
          surface.take()
          compared++
        }
  assert.equal(compared, 4 * 6 * 8 * 4)
  assert.equal(encodeMouse({ type: 'press', button: 'left', column: 0, row: 0 }), '\x1b[<0;1;1M')
  assert.equal(encodeMouse({ type: 'release', button: 'left', column: 4, row: 2 }), '\x1b[<0;5;3m')
  assert.equal(encodeMouse({ type: 'move', button: 'none', column: 4, row: 2 }), '\x1b[<35;5;3M')
  assert.equal(encodeMouse({ type: 'move', button: 'left', column: 4, row: 2 }), '\x1b[<32;5;3M')
  assert.equal(encodeMouse({ type: 'wheel', button: 'down', column: 9, row: 9 }), '\x1b[<65;10;10M')
  assert.equal(encodeMouse({ type: 'press', button: 'left', column: -1, row: 0 }), '')
  surface.terminal.dispose()
})

test('paste and focus are what xterm.js 6 sends in the surface modes', async () => {
  const surface = xtermSurface()
  await surface.ready
  assert.equal(surface.core.coreService.decPrivateModes.bracketedPasteMode, true)
  assert.equal(surface.core.coreService.decPrivateModes.sendFocus, true)
  // The browser build's paste: its line-end and bracketing functions, cut out of the bundle.
  const paste =
    /function (\w+)\(\w\)\{return \w\.replace\(.{1,20}\)\}function (\w+)\(\w,\w\)\{return \w\?"\\x1B\[200~"\+\w\+"\\x1B\[201~":\w\}/u.exec(
      xtermSource(),
    )
  assert(paste, 'xterm.js paste preparation not found in the bundle')
  const xtermPaste = new Function(
    'text',
    `${paste[0]};return ${paste[2]}(${paste[1]}(text),true)`,
  ) as (text: string) => string
  for (const text of ['plain', 'two\nlines\r\nand a third\r', '中文 😀', ''])
    assert.equal(encodePaste(text), xtermPaste(text), JSON.stringify(text))
  assert.equal(encodePaste('a\nb'), '\x1b[200~a\rb\x1b[201~')
  assert.equal(encodeFocus(true), '\x1b[I')
  assert.equal(encodeFocus(false), '\x1b[O')
  surface.terminal.dispose()
})

test('pasted text cannot end its own paste', () => {
  assert.equal(encodePaste('safe\x1b[201~rm -rf /\n'), '\x1b[200~saferm -rf /\r\x1b[201~')
})

/** What the server's parser of the outer surface makes of some bytes. */
function parsed(data: string) {
  const events: unknown[] = []
  const parser = new VtInputParser(
    (input) => events.push(input),
    (error) => events.push(error),
  )
  parser.write(data)
  parser.flushEscape()
  parser.dispose()
  return events
}
const pressed = (code: unknown, modifiers = 0) => ({
  event: {
    Key: {
      code,
      modifiers,
      kind: 'Press',
      repeat_count: 1,
      shifted_codepoint: null,
      generated_text: null,
      tracks_release: false,
      physical_key_id: null,
      windows_record: null,
    },
  },
})

test('the server reads every encoded input as the key, paste, focus or mouse it was', () => {
  const [SHIFT, CONTROL, ALT] = [1, 2, 4]
  const key = (name: string, code: string, modifiers = 0): EncodedKey => ({
    key: name,
    code,
    shiftKey: !!(modifiers & SHIFT),
    ctrlKey: !!(modifiers & CONTROL),
    altKey: !!(modifiers & ALT),
    metaKey: false,
  })
  const cases: [EncodedKey, unknown][] = [
    [key('a', 'KeyA'), pressed({ Char: 'a' })],
    [key('A', 'KeyA', SHIFT), pressed({ Char: 'A' }, SHIFT)],
    [key('c', 'KeyC', CONTROL), pressed({ Char: 'c' }, CONTROL)],
    [key(' ', 'Space', CONTROL), pressed({ Char: ' ' }, CONTROL)],
    [key('x', 'KeyX', ALT), pressed({ Char: 'x' }, ALT)],
    [key('x', 'KeyX', ALT | CONTROL), pressed({ Char: 'x' }, ALT | CONTROL)],
    [key('Enter', 'Enter'), pressed('Enter')],
    [key('Enter', 'Enter', ALT), pressed('Enter', ALT)],
    [key('Tab', 'Tab'), pressed('Tab')],
    [key('Tab', 'Tab', SHIFT), pressed('BackTab', SHIFT)],
    [key('Backspace', 'Backspace'), pressed('Backspace')],
    [key('Backspace', 'Backspace', ALT), pressed('Backspace', ALT)],
    [key('Escape', 'Escape'), pressed('Esc')],
    [key('ArrowUp', 'ArrowUp'), pressed('Up')],
    [key('ArrowLeft', 'ArrowLeft', CONTROL | SHIFT), pressed('Left', CONTROL | SHIFT)],
    [key('Home', 'Home'), pressed('Home')],
    [key('End', 'End', ALT), pressed('End', ALT)],
    [key('PageUp', 'PageUp'), pressed('PageUp')],
    [key('PageDown', 'PageDown', CONTROL), pressed('PageDown', CONTROL)],
    [key('Insert', 'Insert'), pressed('Insert')],
    [key('Delete', 'Delete', SHIFT), pressed('Delete', SHIFT)],
    [key('F1', 'F1'), pressed({ F: 1 })],
    [key('F4', 'F4', CONTROL), pressed({ F: 4 }, CONTROL)],
    [key('F5', 'F5'), pressed({ F: 5 })],
    [key('F12', 'F12', ALT | SHIFT), pressed({ F: 12 }, ALT | SHIFT)],
  ]
  for (const [event, expected] of cases)
    assert.deepEqual(parsed(encodeKey(event)!), [expected], JSON.stringify(event))
  assert.deepEqual(parsed(encodeKey(key('é', 'Digit2'))!), [{ event: { TextCommit: 'é' } }])
  assert.deepEqual(parsed(encodePaste('ls\n\x1b[A')), [{ event: { Paste: 'ls\r\x1b[A' } }])
  assert.deepEqual(parsed(encodeFocus(true) + encodeFocus(false)), [
    { focus: true },
    { focus: false },
  ])
  const mouse = (event: EncodedMouse) => parsed(encodeMouse(event))
  assert.deepEqual(mouse({ type: 'press', button: 'right', column: 3, row: 4, ctrl: true }), [
    { mouse: { kind: { Down: 'Right' }, column: 3, row: 4, modifiers: CONTROL } },
  ])
  assert.deepEqual(mouse({ type: 'release', button: 'left', column: 0, row: 0 }), [
    { mouse: { kind: { Up: 'Left' }, column: 0, row: 0, modifiers: 0 } },
  ])
  assert.deepEqual(mouse({ type: 'move', button: 'middle', column: 9, row: 1, shift: true }), [
    { mouse: { kind: { Drag: 'Middle' }, column: 9, row: 1, modifiers: SHIFT } },
  ])
  assert.deepEqual(mouse({ type: 'move', button: 'none', column: 499, row: 199 }), [
    { mouse: { kind: 'Moved', column: 499, row: 199, modifiers: 0 } },
  ])
  assert.deepEqual(mouse({ type: 'wheel', button: 'up', column: 1, row: 1, alt: true }), [
    { mouse: { kind: 'ScrollUp', column: 1, row: 1, modifiers: ALT } },
  ])
  assert.deepEqual(mouse({ type: 'wheel', button: 'down', column: 1, row: 1 }), [
    { mouse: { kind: 'ScrollDown', column: 1, row: 1, modifiers: 0 } },
  ])
})
