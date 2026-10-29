import test from 'node:test'
import assert from 'node:assert/strict'
import browser from '@xterm/xterm'
import headless from '@xterm/headless'
import serialize from '@xterm/addon-serialize'
import { terminalUnicodeAddon, terminalCellWidth } from '../shared/terminal-unicode.ts'
import { HerdrScreen } from './herdr/screen.ts'
import type { CellData, PaneSurfaceFrame } from './herdr/wire.ts'

const text = '👨‍👩‍👧‍👦👩‍👩‍👧‍👧e\u0301中A'
const blank = (symbol = ' '): CellData => ({ symbol, fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null })
const write = (terminal: Pick<headless.Terminal, 'write'>, data: string) => new Promise<void>(resolve => terminal.write(data, resolve))
function nativeSurface(): PaneSurfaceFrame {
  const cells = Array.from({ length: 24 }, () => blank())
  cells[0] = blank('👨‍👩‍👧‍👦'); cells[2] = blank('👩‍👩‍👧‍👧'); cells[4] = blank('e\u0301'); cells[5] = blank('中'); cells[7] = blank('A')
  return { boot_id: 'unicode', projection_revision: 1, surface_revision: 1, panes: [], splits: [], popup: null,
    frame: { width: 12, height: 2, cells, hyperlinks: [], graphics: Buffer.alloc(0), cursor: null } }
}
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

test('native semantic render and reconnect replay preserve two family emojis and combining/CJK cells', async () => {
  const source = new headless.Terminal({ cols: 12, rows: 2, allowProposedApi: true })
  source.loadAddon(terminalUnicodeAddon())
  const serializer = new serialize.SerializeAddon(); source.loadAddon(serializer)
  const target = new browser.Terminal({ cols: 12, rows: 2, allowProposedApi: true }); target.loadAddon(terminalUnicodeAddon())
  const renderer = new HerdrScreen(), surface = nativeSurface()
  await write(source, renderer.render(surface)); assertClusters(source)
  await write(target, serializer.serialize()); assertClusters(target)
  const cells = surface.frame.cells.map(() => blank()); cells[0] = blank('x'); cells[1] = blank('y')
  const update = renderer.render({ ...surface, frame: { ...surface.frame, cells } })
  await write(source, update); await write(target, update)
  for (const terminal of [source, target]) {
    const line = terminal.buffer.active.getLine(0)!
    assert.equal(line.translateToString(true).trimEnd(), 'xy')
    assert.deepEqual(Array.from({ length: 8 }, (_, column) => line.getCell(column)!.getWidth()), Array(8).fill(1))
    terminal.dispose()
  }
})
