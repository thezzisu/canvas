import type { CellData, FrameData, PaneSurfaceFrame, PaneSurfacePatch, SurfaceRect } from './wire.ts'
import { terminalCellWidth as cellWidth } from '../../shared/terminal-unicode.ts'
export { cellWidth }

export interface ScreenSelection { pane_id: string; anchor: { row: number; col: number }; cursor: { row: number; col: number } }
const ESC = '\x1b'
const controls = /[\x00-\x1f\x7f-\x9f]/gu

function color(value: number, background: boolean): string {
  const base = background ? 40 : 30
  if (value >>> 24 === 2) return `${background ? 48 : 38};2;${value >>> 16 & 255};${value >>> 8 & 255};${value & 255}`
  if (value >>> 24 === 1) return `${background ? 48 : 38};5;${value & 255}`
  const named = value & 255
  return String(named === 0 || named > 16 ? background ? 49 : 39 : named <= 8 ? base + named - 1 : base + 60 + named - 9)
}
function sgr(cell: CellData): string {
  const parts = ['0', color(cell.fg, false), color(cell.bg, true)]
  for (const [bit, code] of [[1, '1'], [2, '2'], [4, '3'], [16, '5'], [32, '6'], [64, '7'], [128, '8'], [256, '9']] as const) if (cell.modifier & bit) parts.push(code)
  if (cell.modifier & 8) { const style = cell.modifier >>> 12; parts.push(style >= 2 && style <= 5 ? `4:${style}` : '4') }
  return `${ESC}[${parts.join(';')}m`
}
function link(frame: FrameData, cell: CellData): string {
  const value = cell.hyperlink === null ? '' : frame.hyperlinks[cell.hyperlink] || ''
  return value.length <= 8192 && !/[\x00-\x20\x7f-\x9f]/u.test(value) ? value : ''
}
function sameCell(a: CellData, b: CellData, left: FrameData, right: FrameData): boolean {
  return a.symbol === b.symbol && a.fg === b.fg && a.bg === b.bg && a.modifier === b.modifier && a.skip === b.skip && link(left, a) === link(right, b)
}
function inFrame(rect: SurfaceRect, frame: FrameData): boolean {
  return rect.x + rect.width <= frame.width && rect.y + rect.height <= frame.height
}
export function validateSurface(surface: PaneSurfaceFrame): void {
  const frame = surface.frame
  if (frame.cells.length !== frame.width * frame.height || frame.width <= 0 || frame.height <= 0) throw new Error('Invalid herdr surface size')
  const ids = new Set<string>()
  for (const pane of surface.panes) {
    if (!pane.pane_id || ids.has(pane.pane_id) || !inFrame(pane.rect, frame) || !inFrame(pane.inner_rect, frame)
      || pane.scrollbar_rect && !inFrame(pane.scrollbar_rect, frame)) throw new Error('Invalid herdr pane geometry')
    ids.add(pane.pane_id)
  }
  for (const split of surface.splits) if (!inFrame(split.area, frame) || !inFrame(split.hit_rect, frame)) throw new Error('Invalid herdr split geometry')
}

/** Apply a patch atomically; an unrelated or stale baseline is never displayed. */
export function applySurfacePatch(surface: PaneSurfaceFrame, patch: PaneSurfacePatch): PaneSurfaceFrame {
  if (patch.boot_id !== surface.boot_id || patch.projection_revision !== surface.projection_revision
    || patch.base_surface_revision !== surface.surface_revision || patch.surface_revision !== surface.surface_revision + 1)
    throw new Error('Herdr surface patch has no matching baseline')
  const panes = new Map(surface.panes.map(pane => [pane.pane_id, pane]))
  for (const pane of patch.panes) {
    const before = panes.get(pane.pane_id)
    if (!before || JSON.stringify(before.inner_rect) !== JSON.stringify(pane.inner_rect) || JSON.stringify(before.rect) !== JSON.stringify(pane.rect)) throw new Error('Herdr patch changed pane geometry')
    panes.set(pane.pane_id, pane)
  }
  const cells = surface.frame.cells.slice()
  for (const row of patch.rows) {
    if (!row.cells.length || row.x + row.cells.length > surface.frame.width || row.y >= surface.frame.height) throw new Error('Herdr patch extends outside its surface')
    for (const cell of row.cells) if (cell.hyperlink !== null && cell.hyperlink >= surface.frame.hyperlinks.length) throw new Error('Invalid herdr patch hyperlink')
    const start = row.y * surface.frame.width + row.x
    for (let i = 0; i < row.cells.length; i++) cells[start + i] = row.cells[i]!
  }
  const next = { ...surface, surface_revision: patch.surface_revision, panes: [...panes.values()], frame: { ...surface.frame, cells, cursor: patch.cursor } }
  validateSurface(next)
  return next
}

export function popupInnerRect(surface: PaneSurfaceFrame): SurfaceRect | undefined {
  const popup = surface.popup
  if (!popup) return
  const resolve = (size: typeof popup.width, available: number, minimum: number) =>
    Math.min(available, Math.max(minimum, !size ? Math.floor(available / 2) : 'Cells' in size ? size.Cells : Math.floor(available * size.Percent / 100)))
  const width = resolve(popup.width, surface.frame.width, 6), height = resolve(popup.height, surface.frame.height, 4)
  if (width < 6 || height < 4) return
  return { x: Math.floor((surface.frame.width - width) / 2) + 1,
    y: Math.floor((surface.frame.height - height) / 2) + 1, width: width > 6 ? width - 3 : width - 2, height: height - 2 }
}

function composedFrame(surface: PaneSurfaceFrame, selection?: ScreenSelection): FrameData {
  const frame = { ...surface.frame, cells: surface.frame.cells.slice(), hyperlinks: [...surface.frame.hyperlinks] }
  if (selection) {
    const pane = surface.panes.find(pane => pane.pane_id === selection.pane_id)
    if (pane) {
      const inner = pane.inner_rect
      const point = (value: { row: number; col: number }) => Math.max(0, Math.min(inner.height - 1, value.row)) * inner.width + Math.max(0, Math.min(inner.width - 1, value.col))
      const start = Math.min(point(selection.anchor), point(selection.cursor)), end = Math.max(point(selection.anchor), point(selection.cursor))
      for (let position = start; position <= end; position++) {
        const index = (inner.y + Math.floor(position / inner.width)) * frame.width + inner.x + position % inner.width
        const cell = frame.cells[index]
        if (cell) frame.cells[index] = { ...cell, modifier: cell.modifier ^ 64 }
      }
    }
  }
  const popup = surface.popup, area = popupInnerRect(surface)
  if (popup && area) {
    const linkOffset = frame.hyperlinks.length
    frame.hyperlinks.push(...popup.frame.hyperlinks)
    const blank = (symbol: string): CellData => ({ symbol, fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null })
    const outerRight = area.width > 4 ? area.width + 1 : area.width
    for (let y = -1; y <= area.height; y++) for (let x = -1; x <= outerRight; x++) {
      const column = area.x + x, row = area.y + y
      if (column < 0 || row < 0 || column >= frame.width || row >= frame.height) continue
      const index = row * frame.width + column
      if (x >= 0 && y >= 0 && x < area.width && y < area.height) {
        const source = popup.frame.cells[y * popup.frame.width + x]
        frame.cells[index] = source ? { ...source, hyperlink: source.hyperlink === null ? null : source.hyperlink + linkOffset } : blank(' ')
      } else frame.cells[index] = blank(y === -1 ? x === -1 ? '┌' : x === outerRight ? '┐' : '─'
        : y === area.height ? x === -1 ? '└' : x === outerRight ? '┘' : '─' : x === -1 || x === outerRight ? '│' : ' ')
    }
    frame.cursor = popup.frame.cursor ? { ...popup.frame.cursor, x: popup.frame.cursor.x + area.x, y: popup.frame.cursor.y + area.y } : null
  }
  return frame
}

export class HerdrScreen {
  private previous?: FrameData
  reset() { this.previous = undefined }
  render(surface: PaneSurfaceFrame, selection?: ScreenSelection): string {
    const frame = composedFrame(surface, selection), previous = this.previous
    const full = !previous || previous.width !== frame.width || previous.height !== frame.height
    const output = [`${ESC}[?2026h${ESC}[?25l${ESC}[?7l${ESC}]8;;${ESC}\\`]
    if (full) output.push(`${ESC}[0m${ESC}[2J`)
    let currentStyle = '', activeLink = ''
    for (let y = 0; y < frame.height; y++) {
      const offset = y * frame.width
      if (!full && frame.cells.slice(offset, offset + frame.width).every((cell, x) => sameCell(cell, previous.cells[offset + x]!, frame, previous))) continue
      // Entire changed rows avoid stale trailing halves after wide-character edits.
      for (let x = 0; x < frame.width; x++) {
        const cell = frame.cells[offset + x]!
        if (cell.skip) continue
        const uri = link(frame, cell)
        if (uri !== activeLink) { output.push(`${ESC}]8;;${uri}${ESC}\\`); activeLink = uri }
        const style = sgr(cell)
        if (style !== currentStyle) { output.push(style); currentStyle = style }
        const symbol = cell.symbol.replace(controls, ' ') || ' '
        output.push(`${ESC}[${y + 1};${x + 1}H`, symbol)
        x += Math.max(1, cellWidth(symbol)) - 1
      }
    }
    output.push(`${ESC}]8;;${ESC}\\${ESC}[0m`)
    const cursor = frame.cursor
    if (cursor && cursor.x < frame.width && cursor.y < frame.height) {
      output.push(`${ESC}[${cursor.y + 1};${cursor.x + 1}H${ESC}[${cursor.shape <= 6 ? cursor.shape : 0} q`)
      if (cursor.visible) output.push(`${ESC}[?25h`)
    }
    output.push(`${ESC}[?2026l`)
    this.previous = frame
    return output.join('')
  }
}
