import assert from 'node:assert/strict'
import test from 'node:test'
import { coreInput, type CoreInputModes } from './input.ts'
import type { ClientKeyCode, ClientPaneInputEvent } from '../herdr/wire.ts'

const modes = (changes: Partial<CoreInputModes> = {}): CoreInputModes => ({ applicationCursor: false, bracketedPaste: false, mouse: 'none',
  sgrMouse: false, pixelMouse: false, utf8Mouse: false, urxvtMouse: false, kitty: 0, modifyOtherKeys: 0, win32: false, ...changes })
const key = (code: ClientKeyCode, modifiers = 0): ClientPaneInputEvent => ({ Key: { code, modifiers, kind: 'Press', repeat_count: 1,
  shifted_codepoint: null, generated_text: null, tracks_release: false, physical_key_id: null, windows_record: null } })

test('core human input encodes actual terminal modes without agent send semantics', () => {
  assert.equal(coreInput(key({ Char: '中' }), modes()).toString(), '中')
  assert.equal(coreInput(key({ Char: 'c' }, 2), modes()).toString(), '\x03')
  assert.equal(coreInput(key({ Char: 'c' }, 3), modes()).toString(), '\x03')
  assert.equal(coreInput(key({ Char: 'x' }, 4), modes()).toString(), '\x1bx')
  assert.equal(coreInput(key('Enter'), modes()).toString(), '\r')
  assert.equal(coreInput(key('Up'), modes({ applicationCursor: true })).toString(), '\x1bOA')
  assert.equal(coreInput(key('Up', 3), modes()).toString(), '\x1b[1;6A')
  assert.equal(coreInput(key({ Char: 'w' }, 8), modes()).length, 0, 'unnegotiated Super never types escape junk')
  assert.equal(coreInput({ Paste: 'literal\n🦊' }, modes()).toString(), 'literal\n🦊')
  assert.equal(coreInput({ Paste: 'a\x1b[201~b' }, modes({ bracketedPaste: true })).toString(), '\x1b[200~ab\x1b[201~')
})

test('core enhanced keyboard negotiation keeps modifiers and key event types', () => {
  assert.equal(coreInput(key('Enter', 1), modes({ kitty: 1 })).toString(), '\x1b[13;2u')
  assert.equal(coreInput(key({ Char: 'c' }, 2), modes({ kitty: 1 })).toString(), '\x1b[99;5u')
  assert.equal(coreInput(key('Esc'), modes({ kitty: 1 })).toString(), '\x1b[27u')
  assert.equal(coreInput(key({ Char: 'a' }), modes({ kitty: 8 })).toString(), '\x1b[97u')
  const release = key('Enter', 1)
  if ('Key' in release) release.Key.kind = 'Release'
  assert.equal(coreInput(release, modes({ kitty: 3 })).toString(), '\x1b[13;2:3u')
  assert.equal(coreInput(release, modes({ kitty: 1 })).length, 0)
  const arrowRelease = key('Up')
  if ('Key' in arrowRelease) arrowRelease.Key.kind = 'Release'
  assert.equal(coreInput(arrowRelease, modes({ kitty: 3 })).toString(), '\x1b[1;1:3A')
  assert.equal(coreInput(key({ Char: 'c' }, 2), modes({ modifyOtherKeys: 2 })).toString(), '\x1b[27;5;99~')
  assert.equal(coreInput(key('Enter', 1), modes({ win32: true })).toString(), '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_')
})

test('core mouse input respects tracking, coordinates, modifiers and wheel count', () => {
  const mouse: ClientPaneInputEvent = { Mouse: { kind: { Down: 'Left' }, position: { Cell: { column: 4, row: 2 } }, geometry: null, modifiers: 3, lines: 1 } }
  assert.equal(coreInput(mouse, modes()).length, 0)
  assert.equal(coreInput(mouse, modes({ mouse: 'vt200', sgrMouse: true })).toString(), '\x1b[<20;5;3M')
  assert.deepEqual(coreInput(mouse, modes({ mouse: 'vt200' })), Buffer.from([27, 91, 77, 52, 37, 35]))
  if ('Mouse' in mouse) mouse.Mouse.kind = { Up: 'Left' }
  assert.equal(coreInput(mouse, modes({ mouse: 'vt200', sgrMouse: true })).toString(), '\x1b[<20;5;3m')
  assert.equal(coreInput(mouse, modes({ mouse: 'x10' })).length, 0)
  if ('Mouse' in mouse) { mouse.Mouse.kind = 'ScrollDown'; mouse.Mouse.modifiers = 0; mouse.Mouse.lines = 3 }
  assert.equal(coreInput(mouse, modes({ mouse: 'drag', sgrMouse: true })).toString(), '\x1b[<65;5;3M'.repeat(3))
})

test('hover follows the child application tracking mode without inventing a press', () => {
  const hover: ClientPaneInputEvent = { Mouse: { kind: 'Moved', position: { Cell: { column: 4, row: 2 } }, geometry: null, modifiers: 7, lines: 1 } }
  for (const mouse of ['none', 'x10', 'vt200', 'drag'] as const) assert.equal(coreInput(hover, modes({ mouse, sgrMouse: true })).length, 0)
  assert.equal(coreInput(hover, modes({ mouse: 'any', sgrMouse: true })).toString(), '\x1b[<63;5;3M')
})
