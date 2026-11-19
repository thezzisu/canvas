import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeKey } from './terminal-encoder.ts'
import { pressedKey, terminalShortcut } from './terminal-input.ts'

const MASKS = Array.from({ length: 16 }, (_, mask) => ({
  shift: !!(mask & 1),
  alt: !!(mask & 2),
  ctrl: !!(mask & 4),
  meta: !!(mask & 8),
}))
const US_KEYS = [..."`1234567890-=qwertyuiop[]\\asdfghjkl;'zxcvbnm,./ "]
const SHIFTED = '~!@#$%^&*()_+QWERTYUIOP{}|ASDFGHJKL:"ZXCVBNM<>? '
const NAMED = [
  ...['Escape', 'Tab', 'Enter', 'Backspace', 'Insert', 'Delete', 'Home', 'End'],
  ...['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]
const CODES: Record<string, string> = { ' ': 'Space', '/': 'Slash', '[': 'BracketLeft' }
/** What a desktop keyboard sends for a key held with `modifiers`, on a US layout. */
function physical(key: string, modifiers: (typeof MASKS)[number]) {
  const index = US_KEYS.indexOf(key)
  const event = {
    key: index >= 0 && modifiers.shift ? SHIFTED[index]! : key,
    code: CODES[key] ?? '',
    shiftKey: modifiers.shift,
    ctrlKey: modifiers.ctrl,
    altKey: modifiers.alt,
    metaKey: modifiers.meta,
  }
  return terminalShortcut(event) || encodeKey(event)
}

test('a built-in key sends exactly what the same key sends from a physical keyboard', () => {
  for (const modifiers of MASKS)
    for (const key of [...US_KEYS, ...NAMED])
      assert.equal(
        pressedKey(key, modifiers),
        physical(key, modifiers),
        `${key} ${JSON.stringify(modifiers)}`,
      )
})

test('built-in chords keep their modifiers for the terminal engine to encode', () => {
  assert.equal(pressedKey('/', { ctrl: true }), '\x1b[47;5u')
  assert.equal(pressedKey('c', { ctrl: true }), '\x1b[99;5u')
  assert.equal(pressedKey('c', { ctrl: true, shift: true }), '\x1b[67;6u')
  assert.equal(pressedKey('C', { ctrl: true }), '\x1b[99;5u', 'Caps Lock does not add Shift')
  assert.equal(pressedKey('b', { alt: true }), '\x1b[98;3u')
  assert.equal(pressedKey('b', { meta: true }), '\x1b[98;9u')
  assert.equal(pressedKey('Tab', { ctrl: true }), '\x1b[9;5u')
  assert.equal(pressedKey('Enter', { alt: true }), '\x1b[13;3u')
  assert.equal(pressedKey('Backspace', { ctrl: true }), '\x1b[127;5u')
  assert.equal(pressedKey('ArrowRight', { ctrl: true, alt: true }), '\x1b[1;7C')
  assert.equal(pressedKey('F12', { ctrl: true }), '\x1b[24;5~')
})

test('built-in keys without a chord type their text and the fixed-mode keys', () => {
  assert.equal(pressedKey('a'), 'a')
  assert.equal(pressedKey('a', { shift: true }), 'A')
  assert.equal(pressedKey('A', { shift: true }), 'a', 'Shift lowers a letter Caps Lock raised')
  assert.equal(pressedKey('/', { shift: true }), '?')
  assert.equal(pressedKey('Tab', { shift: true }), '\x1b[Z')
  assert.equal(pressedKey('ArrowUp'), '\x1bOA')
  assert.equal(pressedKey('ArrowLeft', { shift: true }), '\x1b[1;2D')
  assert.equal(pressedKey('Delete'), '\x1b[3~')
  assert.equal(pressedKey('F1'), '\x1bOP')
  assert.equal(pressedKey('Enter'), '\r')
  assert.equal(pressedKey('Escape'), '\x1b')
  assert.equal(pressedKey('Backspace'), '\x7f')
})

test('physical browser chords preserve Tab, Meta and control-key distinctions', () => {
  assert.equal(terminalShortcut({ key: 't', ctrlKey: true }), '\x1b[116;5u')
  assert.equal(terminalShortcut({ key: 'w', ctrlKey: true }), '\x1b[119;5u')
  assert.equal(terminalShortcut({ key: 'Tab', ctrlKey: true }), '\x1b[9;5u')
  assert.equal(terminalShortcut({ key: 'Tab', ctrlKey: true, shiftKey: true }), '\x1b[9;6u')
  assert.equal(terminalShortcut({ key: 'Tab', shiftKey: true }), '\x1b[Z')
  assert.equal(terminalShortcut({ key: 'x', metaKey: true }), '\x1b[120;9u')
  assert.equal(terminalShortcut({ key: 'x', altKey: true }), '\x1b[120;3u')
  assert.equal(terminalShortcut({ key: 'Enter', shiftKey: true }), '\x1b[13;2u')
  assert.equal(terminalShortcut({ key: 'Backspace', ctrlKey: true }), '\x1b[127;5u')
  assert.equal(terminalShortcut({ key: 'Escape', metaKey: true }), '\x1b[27;9u')
})

test('physical chords use the produced layout glyph without applying Shift or Caps twice', () => {
  const azerty = { key: 'a', code: 'KeyQ', ctrlKey: true }
  const qwertz = { key: 'z', code: 'KeyY', metaKey: true }
  assert.equal(terminalShortcut(azerty), '\x1b[97;5u')
  assert.equal(terminalShortcut(qwertz), '\x1b[122;9u')
  assert.equal(terminalShortcut({ key: 'A', shiftKey: true, ctrlKey: true }), '\x1b[65;6u')
  assert.equal(terminalShortcut({ key: 'A', ctrlKey: true }), '\x1b[97;5u', 'Caps Lock')
  assert.equal(terminalShortcut({ key: 'a', shiftKey: true, ctrlKey: true }), '\x1b[97;6u')
  assert.equal(terminalShortcut({ key: '$', shiftKey: true, ctrlKey: true }), '\x1b[36;6u')
  assert.equal(terminalShortcut({ key: 'é', ctrlKey: true }), '\x1b[233;5u')
  assert.equal(terminalShortcut({ key: '😀', metaKey: true }), '\x1b[128512;9u')
})

test('virtual Shift is additional to the DOM glyph and never reapplies physical Shift', () => {
  assert.equal(terminalShortcut({ key: 'a', ctrlKey: true }, { shift: true }), '\x1b[65;6u')
  assert.equal(terminalShortcut({ key: 'A', ctrlKey: true }, { shift: true }), '\x1b[97;6u')
  assert.equal(
    terminalShortcut({ key: 'A', shiftKey: true, ctrlKey: true }, { shift: true }),
    '\x1b[65;6u',
  )
  assert.equal(terminalShortcut({ key: '4' }, { shift: true }), '\x1b[36;2u')
  assert.equal(terminalShortcut({ key: '$', shiftKey: true }, { shift: true }), '\x1b[36;2u')
  assert.equal(
    terminalShortcut({ key: 'ArrowLeft', ctrlKey: true }, { shift: true, meta: true }),
    '\x1b[1;14D',
  )
})

test('plain typing remains in xterm while physical function keys reach the terminal', () => {
  for (const event of [
    { key: 'a' },
    { key: 'A', shiftKey: true },
    { key: '$', shiftKey: true },
    { key: '中' },
    { key: '😀' },
    { key: 'Tab' },
    { key: 'Enter' },
    { key: 'ArrowLeft' },
    { key: 'Backspace' },
  ]) {
    assert.equal(terminalShortcut(event), '', event.key)
  }
  assert.equal(terminalShortcut({ key: 'F1' }), '\x1bOP')
  assert.equal(terminalShortcut({ key: 'F12' }), '\x1b[24~')
  assert.equal(terminalShortcut({ key: 'ArrowLeft', altKey: true }), '\x1b[1;3D')
  assert.equal(terminalShortcut({ key: 'Unidentified', ctrlKey: true }), '')
  assert.equal(terminalShortcut({ key: 'Shift', shiftKey: true }), '')
})

test('physical shortcut capture yields to composition, AltGraph and native third-level input', () => {
  for (const event of [
    { key: 'Enter', ctrlKey: true, isComposing: true },
    { key: 'Enter', shiftKey: true, keyCode: 229 },
    { key: 'Process', ctrlKey: true },
    { key: 'Dead', altKey: true },
    { key: 'AltGraph', ctrlKey: true },
    {
      key: '@',
      ctrlKey: true,
      altKey: true,
      getModifierState: (name: string) => name === 'AltGraph',
    },
  ])
    assert.equal(terminalShortcut(event, { meta: true }), '', event.key)
  assert.equal(terminalShortcut({ key: '@', ctrlKey: true, altKey: true }, {}, 'Win32'), '')
  assert.equal(terminalShortcut({ key: 'é', altKey: true }, {}, 'MacIntel'), '')
  assert.equal(
    terminalShortcut({ key: 'ArrowLeft', ctrlKey: true, altKey: true }, {}, 'Win32'),
    '\x1b[1;7D',
  )
  assert.equal(terminalShortcut({ key: 'ArrowLeft', altKey: true }, {}, 'MacIntel'), '\x1b[1;3D')
  assert.equal(
    terminalShortcut({ key: 'x', ctrlKey: true, altKey: true }, {}, 'MacIntel'),
    '\x1b[120;7u',
  )
  assert.equal(
    terminalShortcut({ key: '@', ctrlKey: true, altKey: true, metaKey: true }, {}, 'Win32'),
    '\x1b[64;15u',
  )
})

test('Mac select-all stays local while other Command chords retain terminal semantics', () => {
  assert.equal(terminalShortcut({ key: 'a', metaKey: true }, {}, 'MacIntel'), '')
  assert.equal(terminalShortcut({ key: 'A', metaKey: true }, {}, 'MacIntel'), '')
  assert.equal(
    terminalShortcut({ key: 'a', metaKey: true, ctrlKey: true }, {}, 'MacIntel'),
    '\x1b[97;13u',
  )
  assert.equal(
    terminalShortcut({ key: 'A', metaKey: true, shiftKey: true }, {}, 'MacIntel'),
    '\x1b[65;10u',
  )
  assert.equal(
    terminalShortcut({ key: 'a', metaKey: true, altKey: true }, {}, 'MacIntel'),
    '\x1b[97;11u',
  )
  assert.equal(terminalShortcut({ key: 'w', metaKey: true }, {}, 'MacIntel'), '\x1b[119;9u')
  assert.equal(terminalShortcut({ key: 'a', metaKey: true }, {}, 'Linux'), '\x1b[97;9u')
})
