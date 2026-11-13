import assert from 'node:assert/strict'
import test from 'node:test'
import { GhosttyTerminal } from '../ghostty/terminal.ts'
import { coreInput } from './input.ts'
import type { ClientKeyCode, ClientPaneInputEvent } from '../herdr/wire.ts'

/** What the event sends to a program that wrote `modes` to its terminal. */
function sent(event: ClientPaneInputEvent, modes = '', win32 = false): string {
  const terminal = new GhosttyTerminal(80, 24, 0)
  try {
    terminal.write(modes)
    return Buffer.from(coreInput(event, terminal, win32)).toString('latin1')
  } finally {
    terminal.free()
  }
}
const key = (
  code: ClientKeyCode,
  modifiers = 0,
  kind: 'Press' | 'Repeat' | 'Release' = 'Press',
): ClientPaneInputEvent => ({
  Key: {
    code,
    modifiers,
    kind,
    repeat_count: 1,
    shifted_codepoint: null,
    generated_text: null,
    tracks_release: false,
    physical_key_id: null,
    windows_record: null,
  },
})
const SHIFT = 1,
  CONTROL = 2,
  ALT = 4,
  SUPER = 8

test('core human input encodes actual terminal modes without agent send semantics', () => {
  assert.equal(Buffer.from(sent(key({ Char: '中' })), 'latin1').toString(), '中')
  assert.equal(sent(key({ Char: 'a' })), 'a')
  assert.equal(sent(key({ Char: 'A' }, SHIFT)), 'A')
  assert.equal(sent(key({ Char: '?' })), '?')
  assert.equal(sent(key({ Char: 'c' }, CONTROL)), '\x03')
  assert.equal(sent(key({ Char: ']' }, CONTROL)), '\x1d')
  assert.equal(sent(key({ Char: ' ' }, CONTROL)), '\0')
  assert.equal(sent(key('Null')), '\0')
  assert.equal(sent(key({ Char: 'x' }, ALT)), '\x1bx')
  assert.equal(sent(key('Enter')), '\r')
  assert.equal(sent(key('Tab')), '\t')
  assert.equal(sent(key('BackTab', SHIFT)), '\x1b[Z')
  assert.equal(sent(key('Esc')), '\x1b')
  assert.equal(sent(key('Backspace')), '\x7f')
  assert.equal(sent(key('Backspace', CONTROL)), '\b')
  assert.equal(sent(key('Backspace', ALT)), '\x1b\x7f')
  assert.equal(sent(key('Up')), '\x1b[A')
  assert.equal(sent(key('Up'), '\x1b[?1h'), '\x1bOA')
  assert.equal(sent(key('Up', SHIFT | CONTROL)), '\x1b[1;6A')
  assert.equal(sent(key('Delete')), '\x1b[3~')
  assert.equal(sent(key('PageUp', SHIFT)), '\x1b[5;2~')
  assert.equal(sent(key({ F: 1 })), '\x1bOP')
  assert.equal(sent(key({ F: 5 }, CONTROL)), '\x1b[15;5~')
  assert.equal(sent(key('Enter', 0, 'Release')), '')
  assert.equal(sent(key({ Char: 'w' }, SUPER)), '', 'unnegotiated Super never types escape junk')
  assert.equal(
    Buffer.from(sent({ TextCommit: 'é🦊' }), 'latin1').toString(),
    'é🦊',
    'committed text is sent as it is',
  )
  assert.equal(Buffer.from(sent({ Paste: 'literal\n🦊' }), 'latin1').toString(), 'literal\n🦊')
  assert.equal(sent({ Paste: 'a\x1b[201~b' }, '\x1b[?2004h'), '\x1b[200~ab\x1b[201~')
  assert.equal(sent({ Paste: 'a\x1b[20\x1b[201~1~b' }, '\x1b[?2004h'), '\x1b[200~ab\x1b[201~')
})

test('every byte a legacy keyboard can send reaches the program as that byte', () => {
  // The outer parser turns a control byte into a key with Control; it must come out unchanged.
  const control = (code: number): ClientPaneInputEvent =>
    code === 0
      ? key({ Char: ' ' }, CONTROL)
      : code < 27
        ? key({ Char: String.fromCharCode(code + 96) }, CONTROL)
        : key({ Char: ['[', '\\', ']', '^', '_'][code - 27]! }, CONTROL)
  for (let code = 0; code < 32; code++) {
    if ([9, 13, 27].includes(code)) continue // Tab, Enter and Esc arrive as their own keys.
    assert.equal(sent(control(code)), String.fromCharCode(code), `control byte ${code}`)
    const alt = control(code)
    if ('Key' in alt) alt.Key.modifiers |= ALT
    assert.equal(sent(alt), `\x1b${String.fromCharCode(code)}`, `Alt + control byte ${code}`)
  }
  for (let code = 32; code < 127; code++) {
    const text = String.fromCharCode(code),
      shift = /^[A-Z]$/u.test(text) ? SHIFT : 0
    assert.equal(sent(key({ Char: text }, shift)), text, JSON.stringify(text))
    assert.equal(sent(key({ Char: text }, shift | ALT)), `\x1b${text}`, `Alt + ${text}`)
  }
})

test('core enhanced keyboard negotiation keeps modifiers and key event types', () => {
  assert.equal(sent(key('Enter', SHIFT), '\x1b[>1u'), '\x1b[13;2u')
  assert.equal(sent(key({ Char: 'c' }, CONTROL), '\x1b[>1u'), '\x1b[99;5u')
  assert.equal(sent(key('Esc'), '\x1b[>1u'), '\x1b[27u')
  assert.equal(sent(key({ Char: 'a' }), '\x1b[>8u'), '\x1b[97u')
  // Enter, Tab and Backspace report their release only when every key is an escape code.
  assert.equal(sent(key('Enter', SHIFT, 'Release'), '\x1b[>3u'), '')
  assert.equal(sent(key('Enter', SHIFT, 'Release'), '\x1b[>11u'), '\x1b[13;2:3u')
  assert.equal(sent(key('Enter', SHIFT, 'Release'), '\x1b[>1u'), '')
  assert.equal(sent(key('Up', 0, 'Release'), '\x1b[>3u'), '\x1b[1;1:3A')
  assert.equal(sent(key('Up', 0, 'Repeat'), '\x1b[>3u'), '\x1b[1;1:2A')
  assert.equal(sent(key({ Char: 'c' }, CONTROL), '\x1b[>1u\x1b[<u'), '\x03', 'the stack pops')
  assert.equal(sent(key({ Char: 'c' }, CONTROL), '\x1b[>4;2m'), '\x1b[27;5;99~')
  assert.equal(sent(key('Enter', SHIFT), '', true), '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_')
  assert.equal(sent(key('Enter', SHIFT), '\x1b[>1u', true), '\x1b[13;2u')
  assert.equal(sent(key({ Char: 'a' }), '', true), 'a')
})

test('core mouse input respects tracking, coordinates, modifiers and wheel count', () => {
  const mouse = (
    kind: Extract<ClientPaneInputEvent, { Mouse: unknown }>['Mouse']['kind'],
    modifiers = 0,
    lines = 1,
  ): ClientPaneInputEvent => ({
    Mouse: { kind, position: { Cell: { column: 4, row: 2 } }, geometry: null, modifiers, lines },
  })
  const down = mouse({ Down: 'Left' }, SHIFT | CONTROL)
  assert.equal(sent(down), '')
  assert.equal(sent(down, '\x1b[?1000h\x1b[?1006h'), '\x1b[<20;5;3M')
  assert.equal(sent(down, '\x1b[?1000h'), '\x1b[M4%#')
  assert.equal(
    sent(mouse({ Up: 'Left' }, SHIFT | CONTROL), '\x1b[?1000h\x1b[?1006h'),
    '\x1b[<20;5;3m',
  )
  assert.equal(sent(mouse({ Up: 'Left' }), '\x1b[?9h'), '')
  assert.equal(sent(mouse({ Down: 'Right' }), '\x1b[?9h'), '\x1b[M"%#')
  assert.equal(sent(mouse({ Drag: 'Left' }), '\x1b[?1000h\x1b[?1006h'), '')
  assert.equal(sent(mouse({ Drag: 'Left' }), '\x1b[?1002h\x1b[?1006h'), '\x1b[<32;5;3M')
  assert.equal(sent(mouse('ScrollDown', 0, 3), '\x1b[?1002h\x1b[?1006h'), '\x1b[<65;5;3M'.repeat(3))
  assert.equal(sent(mouse('ScrollUp'), '\x1b[?1000h\x1b[?1015h'), '\x1b[96;5;3M')
  assert.equal(
    sent(mouse({ Down: 'Middle' }), '\x1b[?1000h\x1b[?1016h'),
    '\x1b[<1;36;40M',
    'pixel reports name the middle of the cell',
  )
  assert.equal(
    sent(
      {
        Mouse: {
          kind: { Down: 'Left' },
          position: { Pixels: { x: 3, y: 5, column: 0, row: 0 } },
          geometry: null,
          modifiers: 0,
          lines: 1,
        },
      },
      '\x1b[?1000h\x1b[?1016h',
    ),
    '\x1b[<0;3;5M',
  )
})

test('hover follows the child application tracking mode without inventing a press', () => {
  const hover: ClientPaneInputEvent = {
    Mouse: {
      kind: 'Moved',
      position: { Cell: { column: 4, row: 2 } },
      geometry: null,
      modifiers: 7,
      lines: 1,
    },
  }
  for (const mode of ['', '\x1b[?9h', '\x1b[?1000h', '\x1b[?1002h'])
    assert.equal(sent(hover, `${mode}\x1b[?1006h`), '')
  assert.equal(sent(hover, '\x1b[?1003h\x1b[?1006h'), '\x1b[<63;5;3M')
})
