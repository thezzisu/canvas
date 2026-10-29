import type { CanvasViewport } from './mobile-layout'

export type PageDirection = 'left' | 'right' | 'up' | 'down'
export interface OverviewPage { id: string; row: string; x: number; y: number; width: number; height: number }
type Frame = { width: number; height: number }
const center = (page: OverviewPage) => ({ x: page.x + page.width / 2, y: page.y + page.height / 2 })

/** The native window keeps its dimensions; only the canvas camera moves. */
export function pageViewport(page: OverviewPage, frame: Frame): CanvasViewport {
  const padding = 16
  const zoom = Math.max(.08, Math.min(2, (frame.width - padding * 2) / page.width, (frame.height - padding * 2) / page.height))
  const point = center(page)
  return { zoom, x: frame.width / 2 - point.x * zoom, y: frame.height / 2 - point.y * zoom }
}

export function adjacentPage(pages: readonly OverviewPage[], currentId: string, direction: PageDirection): OverviewPage | undefined {
  const current = pages.find(page => page.id === currentId)
  if (!current) return undefined
  if (direction === 'left' || direction === 'right') {
    const row = pages.filter(page => page.row === current.row)
    return row[row.findIndex(page => page.id === currentId) + (direction === 'left' ? -1 : 1)]
  }
  const rows = [...new Set(pages.map(page => page.row))]
  const nextRow = rows[rows.indexOf(current.row) + (direction === 'up' ? -1 : 1)]
  const column = center(current).x
  return pages.filter(page => page.row === nextRow).reduce<OverviewPage | undefined>((closest, page) =>
    !closest || Math.abs(center(page).x - column) < Math.abs(center(closest).x - column) ? page : closest, undefined)
}

/** Retain native identity through sorting and space moves; recover locally after removal. */
export function retainPage(pages: readonly OverviewPage[], currentId: string, previous?: OverviewPage,
  viewport?: CanvasViewport, frame?: Frame): OverviewPage | undefined {
  const current = pages.find(page => page.id === currentId)
  if (current) return current
  const sameRow = previous ? pages.filter(page => page.row === previous.row) : []
  const candidates = sameRow.length ? sameRow : pages
  const point = previous ? center(previous) : viewport && frame
    ? { x: (frame.width / 2 - viewport.x) / viewport.zoom, y: (frame.height / 2 - viewport.y) / viewport.zoom } : undefined
  if (!point) return candidates[0]
  const distance = (page: OverviewPage) => Math.hypot(center(page).x - point.x, center(page).y - point.y)
  return candidates.reduce<OverviewPage | undefined>((closest, page) => !closest || distance(page) < distance(closest) ? page : closest, undefined)
}

export function swipePage(dx: number, dy: number): PageDirection | undefined {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 48) return undefined
  return Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'left' : 'right' : dy > 0 ? 'up' : 'down'
}

/** One wheel gesture, including its momentum tail, advances at most one window. */
export class PageWheelGesture {
  private last = -Infinity
  private x = 0
  private y = 0
  private consumed = false

  reset() { this.last = -Infinity; this.x = 0; this.y = 0; this.consumed = false }
  block(now: number) { this.last = now; this.consumed = true }

  consume(dx: number, dy: number, now: number): PageDirection | undefined {
    if (now - this.last > 220) this.reset()
    this.last = now
    if (this.consumed) return undefined
    this.x += dx
    this.y += dy
    if (Math.max(Math.abs(this.x), Math.abs(this.y)) < 48) return undefined
    this.consumed = true
    return Math.abs(this.x) > Math.abs(this.y) ? this.x > 0 ? 'right' : 'left' : this.y > 0 ? 'down' : 'up'
  }
}
