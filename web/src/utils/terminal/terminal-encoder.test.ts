import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { VtInputParser } from '../../../../server/herdr/input.ts'
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

// The encoder was written against xterm.js 6: every key of a US keyboard under every modifier,
// and every mouse event, was compared with what that terminal sends in the surface's modes.
// These digests record the outputs that matched.
const KEY_DIGEST = '1d9540110f63ff1abfc22e8e7d66f7c0e3eec13d433bc66a1a76fad4ffdbac5c'
const MOUSE_DIGEST = '12bbe4b7b93277198fd50b88d1da554c7637ef9cb909fe2a4e0a6256e7e66571'
const digest = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex')

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

test('every key and modifier combination sends what was recorded from xterm.js 6', () => {
  const lines: string[] = []
  for (const mac of [false, true])
    for (let modifiers = 0; modifiers < 16; modifiers++)
      for (const key of keyboard(modifiers))
        lines.push(`${mac ? 'mac ' : ''}${describe(key)} ${JSON.stringify(encodeKey(key, mac))}`)
  assert.equal(lines.length, 2 * 16 * 96)
  assert.equal(digest(lines), KEY_DIGEST)
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

test('every mouse event sends what was recorded from xterm.js 6', () => {
  const lines: string[] = []
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
          lines.push(JSON.stringify([event, encodeMouse(event)]))
        }
  assert.equal(lines.length, 4 * 6 * 8 * 4)
  assert.equal(digest(lines), MOUSE_DIGEST)
  assert.equal(encodeMouse({ type: 'press', button: 'left', column: 0, row: 0 }), '\x1b[<0;1;1M')
  assert.equal(encodeMouse({ type: 'release', button: 'left', column: 4, row: 2 }), '\x1b[<0;5;3m')
  assert.equal(encodeMouse({ type: 'move', button: 'none', column: 4, row: 2 }), '\x1b[<35;5;3M')
  assert.equal(encodeMouse({ type: 'move', button: 'left', column: 4, row: 2 }), '\x1b[<32;5;3M')
  assert.equal(encodeMouse({ type: 'wheel', button: 'down', column: 9, row: 9 }), '\x1b[<65;10;10M')
  assert.equal(encodeMouse({ type: 'press', button: 'left', column: -1, row: 0 }), '')
  // A direction is only a wheel event, and plain motion only a move.
  assert.equal(encodeMouse({ type: 'press', button: 'up', column: 0, row: 0 }), '')
  assert.equal(encodeMouse({ type: 'wheel', button: 'left', column: 0, row: 0 }), '')
  assert.equal(encodeMouse({ type: 'press', button: 'none', column: 0, row: 0 }), '')
})

test('paste is bracketed with line ends as carriage returns, and focus is reported', () => {
  assert.equal(encodePaste('plain'), '\x1b[200~plain\x1b[201~')
  assert.equal(
    encodePaste('two\nlines\r\nand a third\r'),
    '\x1b[200~two\rlines\rand a third\r\x1b[201~',
  )
  assert.equal(encodePaste(''), '\x1b[200~\x1b[201~')
  assert.equal(encodeFocus(true), '\x1b[I')
  assert.equal(encodeFocus(false), '\x1b[O')
})

test('pasted text cannot end its own paste', () => {
  assert.equal(encodePaste('safe\x1b[201~rm -rf /\n'), '\x1b[200~saferm -rf /\r\x1b[201~')
  assert.equal(encodePaste('\x1b[20\x1b[201~1~x'), '\x1b[200~x\x1b[201~')
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
