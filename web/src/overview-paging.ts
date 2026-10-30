import type { CanvasViewport } from './mobile-layout'

export type PageDirection = 'left' | 'right' | 'up' | 'down'
export interface OverviewPage { id: string; row: string; x: number; y: number; width: number; height: number }
type Frame = { width: number; height: number }
type Bounds = Pick<OverviewPage, 'x' | 'y' | 'width' | 'height'>
const center = (page: Bounds) => ({ x: page.x + page.width / 2, y: page.y + page.height / 2 })

/** The native window keeps its dimensions; only the canvas camera moves. */
export function pageViewport(page: Bounds, frame: Frame): CanvasViewport {
  const padding = 16
  const zoom = Math.max(.08, Math.min(2, (frame.width - padding * 2) / page.width, (frame.height - padding * 2) / page.height))
  const point = center(page)
  return { zoom, x: frame.width / 2 - point.x * zoom, y: frame.height / 2 - point.y * zoom }
}

export function adjacentPage(pages: readonly OverviewPage[], currentId: string, direction: PageDirection, preferredX?: number): OverviewPage | undefined {
  const current = pages.find(page => page.id === currentId)
  if (!current) return undefined
  if (direction === 'left' || direction === 'right') {
    const row = pages.filter(page => page.row === current.row)
    return row[row.findIndex(page => page.id === currentId) + (direction === 'left' ? -1 : 1)]
  }
  const rows = [...new Set(pages.map(page => page.row))]
  const nextRow = rows[rows.indexOf(current.row) + (direction === 'up' ? -1 : 1)]
  const column = preferredX ?? center(current).x
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

export const PAGE_GESTURE_IDLE_MS = 220

/** Follow small movements directly; soften long pulls and resist unavailable edges. */
export function pageDragOffset(x: number, y: number, extent: number, atEdge: boolean): { x: number; y: number } {
  const horizontal = Math.abs(x) > Math.abs(y)
  const distance = horizontal ? x : y
  const limit = Math.max(24, Math.min(120, extent * .22))
  const magnitude = Math.abs(distance)
  const amount = atEdge ? limit * .4 * (1 - Math.exp(-magnitude / limit))
    : magnitude <= limit ? magnitude : limit + limit * .35 * (1 - Math.exp(-(magnitude - limit) / limit))
  const offset = -Math.sign(distance) * amount
  return horizontal ? { x: offset, y: 0 } : { x: 0, y: offset }
}

/** Consume momentum once; quiet, reversal or renewed acceleration starts another stroke. */
export class PageWheelGesture {
  private last = -Infinity
  private x = 0
  private y = 0
  private consumed = false
  private blocked = false
  private axis?: 'x' | 'y'
  private peak = 0
  private previous = 0
  private decays = 0
  private tail?: number
  private burst?: { axis: 'x' | 'y'; value: number; peak: number }

  get pending() { return Number.isFinite(this.last) && !this.consumed }
  get displacement() {
    const horizontal = this.axis ? this.axis === 'x' : Math.abs(this.x) > Math.abs(this.y)
    return horizontal ? { x: this.x, y: 0 } : { x: 0, y: this.y }
  }

  reset() {
    this.last = -Infinity; this.x = 0; this.y = 0; this.consumed = false; this.blocked = false; this.axis = undefined
    this.peak = 0; this.previous = 0; this.decays = 0; this.tail = undefined; this.burst = undefined
  }
  block(now = this.last) { this.last = now; this.consumed = true; this.blocked = true; this.burst = undefined }

  isIdle(now: number) { return now - this.last > PAGE_GESTURE_IDLE_MS }

  private commit(axis: 'x' | 'y', value: number, peak: number, pulse: number): PageDirection {
    this.axis = axis; this.x = axis === 'x' ? value : 0; this.y = axis === 'y' ? value : 0; this.consumed = true
    this.peak = peak; this.previous = pulse; this.decays = 0; this.tail = undefined; this.burst = undefined
    return axis === 'x' ? value > 0 ? 'right' : 'left' : value > 0 ? 'down' : 'up'
  }

  private nextStroke(dx: number, dy: number): PageDirection | undefined {
    if (this.blocked || !this.axis) return undefined
    const axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    const value = axis === 'x' ? dx : dy, magnitude = Math.abs(value)
    const direction = Math.sign(this.axis === 'x' ? this.x : this.y)
    const reversed = axis === this.axis && Math.sign(value) === -direction
    // A second acceleration is meaningful only after the old pulse has decayed.
    // Weak tail samples cannot finish a burst started by an isolated jitter.
    if (reversed || (this.tail !== undefined && magnitude >= Math.max(6, this.tail * 3))) {
      if (this.burst?.axis !== axis || Math.sign(this.burst.value) !== Math.sign(value)) this.burst = { axis, value: 0, peak: 0 }
      this.burst.value += value; this.burst.peak = Math.max(this.burst.peak, magnitude)
      if (Math.abs(this.burst.value) >= 48) return this.commit(axis, this.burst.value, this.burst.peak, magnitude)
      return undefined
    }
    this.burst = undefined
    const pulse = this.axis === 'x' ? dx : dy
    if (Math.sign(pulse) !== direction) return undefined
    const amount = Math.abs(pulse)
    this.decays = amount <= this.previous ? this.decays + 1 : 0
    this.peak = Math.max(this.peak, amount); this.previous = amount
    if (this.tail !== undefined) this.tail = Math.min(this.tail, amount)
    else if (this.decays >= 3 && amount <= this.peak / 3) this.tail = amount
    return undefined
  }

  consume(dx: number, dy: number, now: number): PageDirection | undefined {
    if (!dx && !dy) return undefined
    if (this.isIdle(now)) this.reset()
    this.last = now
    if (this.consumed) return this.nextStroke(dx, dy)
    this.x += dx
    this.y += dy
    if (!this.axis && Math.max(Math.abs(this.x), Math.abs(this.y)) >= 8) this.axis = Math.abs(this.x) > Math.abs(this.y) ? 'x' : 'y'
    const pulse = Math.abs(this.axis === 'x' ? dx : this.axis === 'y' ? dy : Math.max(Math.abs(dx), Math.abs(dy)))
    this.peak = Math.max(this.peak, pulse)
    const { x, y } = this.displacement
    if (Math.max(Math.abs(x), Math.abs(y)) < 48) return undefined
    return this.commit(x ? 'x' : 'y', x || y, this.peak, pulse)
  }
}
