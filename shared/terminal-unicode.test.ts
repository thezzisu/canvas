import test from 'node:test'
import assert from 'node:assert/strict'
import browser from '@xterm/xterm'
import headless from '@xterm/headless'
import { terminalUnicodeAddon, terminalCellWidth } from './terminal-unicode.ts'

const text = '👨‍👩‍👧‍👦👩‍👩‍👧‍👧e\u0301中A'
const write = (terminal: Pick<headless.Terminal, 'write'>, data: string) => new Promise<void>(resolve => terminal.write(data, resolve))
function assertClusters(terminal: Pick<headless.Terminal, 'buffer'>) {
  const line = terminal.buffer.active.getLine(0)!
  assert.equal(line.translateToString(true).trimEnd(), text)
  assert.deepEqual(Array.from({ length: 8 }, (_, column) => [line.getCell(column)!.getChars(), line.getCell(column)!.getWidth()]), [
    ['👨‍👩‍👧‍👦', 2], ['', 0], ['👩‍👩‍👧‍👧', 2], ['', 0], ['e\u0301', 1], ['中', 2], ['', 0], ['A', 1],
  ])
}

test('browser and headless buffers share official grapheme widths for ordinary ANSI output', async () => {
  for (const Constructor of [browser.Terminal, headless.Terminal]) {
    const terminal = new Constructor({ cols: 12, rows: 2, allowProposedApi: true })
    terminal.loadAddon(terminalUnicodeAddon())
    assert.equal(terminal.unicode.activeVersion, '15-graphemes')
    await write(terminal, text)
    assertClusters(terminal)
    assert.equal(terminal.buffer.active.cursorX, 8)
    terminal.dispose()
  }
  for (const [value, width] of [['👨‍👩‍👧‍👦', 2], ['👩‍👩‍👧‍👧', 2], ['e\u0301', 1], ['中', 2], ['🇨🇳', 2], ['1️⃣', 2], ['👍🏽', 2], [text, 8]] as const)
    assert.equal(terminalCellWidth(value), width, value)
})
