import test from 'node:test'
import assert from 'node:assert/strict'
import { applySurfacePatch, popupInnerRect } from './screen.ts'
import type { CellData, PaneSurfaceFrame } from './wire.ts'

const blank = (symbol = ' '): CellData => ({
  symbol,
  fg: 0,
  bg: 0,
  modifier: 0,
  skip: false,
  hyperlink: null,
})
function surface(): PaneSurfaceFrame {
  return {
    boot_id: 'boot',
    projection_revision: 3,
    surface_revision: 1,
    frame: {
      width: 8,
      height: 2,
      cells: Array.from({ length: 16 }, () => blank()),
      hyperlinks: [],
      cursor: null,
      graphics: Buffer.alloc(0),
    },
    panes: [],
    splits: [],
    popup: null,
  }
}
test('patch revisions and geometry are checked before the retained frame is changed', () => {
  const value = surface(),
    original = value.frame.cells[0]
  const patch = {
    boot_id: 'boot',
    projection_revision: 3,
    base_surface_revision: 1,
    surface_revision: 2,
    rows: [{ x: 0, y: 0, cells: [blank('B')] }],
    panes: [],
    cursor: null,
  }
  const updated = applySurfacePatch(value, patch)
  assert.equal(updated.frame.cells[0]?.symbol, 'B')
  assert.equal(value.frame.cells[0], original)
  for (const invalid of [
    { ...patch, boot_id: 'other' },
    { ...patch, base_surface_revision: 0 },
    { ...patch, surface_revision: 4 },
    { ...patch, rows: [{ x: 8, y: 0, cells: [blank('B')] }] },
  ])
    assert.throws(() => applySurfacePatch(value, invalid))
})

test('popup geometry matches upstream border and reserved scrollbar column', () => {
  const value = surface()
  value.frame.width = 80
  value.frame.height = 24
  value.popup = {
    terminal_id: 'popup',
    title: 'Popup',
    width: null,
    height: null,
    frame: { ...surface().frame, width: 37, height: 10 },
    mouse_reporting: false,
    sgr_pixel_mouse: false,
    pixel_width: 0,
    pixel_height: 0,
  }
  assert.deepEqual(popupInnerRect(value), { x: 21, y: 7, width: 37, height: 10 })
})
