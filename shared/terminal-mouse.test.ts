import assert from 'node:assert/strict'
import test from 'node:test'
import { isTerminalHoverInput } from './terminal-mouse.ts'

test('passive motion accepts complete SGR reports with modifiers, never active or mixed input', () => {
  for (const code of [35, 39, 43, 47, 51, 55, 59, 63]) {
    assert(isTerminalHoverInput(`\x1b[<${code};12;34M`))
    assert(isTerminalHoverInput(`\x1b[<${code};12;34M\x1b[<35;13;34M`))
  }
  for (const input of [
    '',
    'hello',
    '\x1b[<35;12;',
    '\x1b[<35;12;34m',
    '\x1b[<35;0;34M',
    '\x1b[<0;12;34M',
    '\x1b[<32;12;34M',
    '\x1b[<34;12;34M',
    '\x1b[<64;12;34M',
    '\x1b[<35;12;34Mx',
    '\x1b[200~\x1b[<35;12;34M\x1b[201~',
  ])
    assert(!isTerminalHoverInput(input), JSON.stringify(input))
})
