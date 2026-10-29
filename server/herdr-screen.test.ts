import test from 'node:test'
import assert from 'node:assert/strict'
import headless from '@xterm/headless'
import { terminalUnicodeAddon } from '../shared/terminal-unicode.ts'
import { HerdrScreen, applySurfacePatch, popupInnerRect, cellWidth } from './herdr/screen.ts'
import type { CellData, PaneSurfaceFrame } from './herdr/wire.ts'

const blank = (symbol = ' '): CellData => ({ symbol, fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null })
function surface(): PaneSurfaceFrame {
  return { boot_id: 'boot', projection_revision: 3, surface_revision: 1,
    frame: { width: 8, height: 2, cells: Array.from({ length: 16 }, () => blank()), hyperlinks: [], cursor: null, graphics: Buffer.alloc(0) },
    panes: [], splits: [], popup: null }
}
const write = (terminal: headless.Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve))

test('native semantic screens retain CJK, styles and cursor while clearing replaced wide cells', async () => {
  const terminal = new headless.Terminal({ cols: 8, rows: 2, allowProposedApi: true }), renderer = new HerdrScreen(), value = surface()
  terminal.loadAddon(terminalUnicodeAddon())
  value.frame.cells[0] = { ...blank('中'), fg: 0x02123456, modifier: 1 | 4 | 8 | 0x3000 }
  value.frame.cells[1] = blank()
  value.frame.cells[2] = blank('A')
  value.frame.cursor = { x: 4, y: 1, visible: true, shape: 6 }
  await write(terminal, renderer.render(value))
  assert.equal(terminal.buffer.active.getLine(0)?.translateToString(true).trimEnd(), '中A')
  const cell = terminal.buffer.active.getLine(0)!.getCell(0)!
  assert.equal(cell.getFgColor(), 0x123456)
  assert(cell.isBold() && cell.isItalic() && cell.isUnderline())
  assert.equal(terminal.buffer.active.cursorX, 4)
  assert.equal(terminal.buffer.active.cursorY, 1)
  const changed = { ...value, frame: { ...value.frame, cells: value.frame.cells.map((cell, index) => index === 0 ? blank('X') : index === 2 ? blank() : cell) } }
  await write(terminal, renderer.render(changed))
  assert.equal(terminal.buffer.active.getLine(0)?.translateToString(true).trimEnd(), 'X')
  assert.equal(cellWidth('e\u0301'), 1)
  assert.equal(cellWidth('👩‍💻'), 2)
  terminal.dispose()
})

test('screen hyperlinks and cell text cannot inject terminal controls', () => {
  const value = surface()
  value.frame.hyperlinks = ['https://example.test/file', 'https://example.test/\x1b]52;c;bad\x07']
  value.frame.cells[0] = { ...blank('A'), hyperlink: 0 }
  value.frame.cells[1] = { ...blank('\x1b\x07'), hyperlink: 1 }
  const output = new HerdrScreen().render(value)
  assert(output.includes('\x1b]8;;https://example.test/file\x1b\\'))
  assert(!output.includes(']52;c;bad'))
  assert(!output.includes('\x07'))
})

test('patch revisions and geometry are checked before the retained frame is changed', () => {
  const value = surface(), original = value.frame.cells[0]
  const patch = { boot_id: 'boot', projection_revision: 3, base_surface_revision: 1, surface_revision: 2,
    rows: [{ x: 0, y: 0, cells: [blank('B')] }], panes: [], cursor: null }
  const updated = applySurfacePatch(value, patch)
  assert.equal(updated.frame.cells[0]?.symbol, 'B')
  assert.equal(value.frame.cells[0], original)
  for (const invalid of [{ ...patch, boot_id: 'other' }, { ...patch, base_surface_revision: 0 }, { ...patch, surface_revision: 4 },
    { ...patch, rows: [{ x: 8, y: 0, cells: [blank('B')] }] }]) assert.throws(() => applySurfacePatch(value, invalid))
})

test('popup geometry matches upstream border and reserved scrollbar column', () => {
  const value = surface(); value.frame.width = 80; value.frame.height = 24
  value.popup = { terminal_id: 'popup', title: 'Popup', width: null, height: null, frame: { ...surface().frame, width: 37, height: 10 },
    mouse_reporting: false, sgr_pixel_mouse: false, pixel_width: 0, pixel_height: 0 }
  assert.deepEqual(popupInnerRect(value), { x: 21, y: 7, width: 37, height: 10 })
})
