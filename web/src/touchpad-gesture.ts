export type TouchpadButton = 'left' | 'middle' | 'right'
export interface TouchpadPoint { identifier: number; clientX: number; clientY: number }
export type TouchpadControl = { type: 'left'; pressed: boolean; cancelled?: boolean } | { type: 'click'; button: TouchpadButton } | { type: 'scroll'; x: number; y: number }

/** A tap is decided only when all fingers lift; changing finger count rebases motion. */
export class TouchpadGesture {
  private gesture?: { origins: Map<number, TouchpadPoint>; count: number; maximum: number; x: number; y: number; moved: boolean; ending: boolean; started: number }
  constructor(private readonly actions: { move(x: number, y: number): void; scroll(x: number, y: number): void; tap(button: TouchpadButton): void }) {}
  update(points: readonly TouchpadPoint[], now: number) {
    if (!points.length) return
    const x = points.reduce((sum, point) => sum + point.clientX, 0) / points.length
    const y = points.reduce((sum, point) => sum + point.clientY, 0) / points.length
    const current = this.gesture ??= { origins: new Map(), count: 0, maximum: 0, x, y, moved: false, ending: false, started: now }
    for (const point of points) {
      const origin = current.origins.get(point.identifier)
      if (!origin) current.origins.set(point.identifier, { identifier: point.identifier, clientX: point.clientX, clientY: point.clientY })
      else if (Math.hypot(point.clientX - origin.clientX, point.clientY - origin.clientY) > 6) current.moved = true
    }
    const stable = current.count === points.length
    current.count = points.length; current.maximum = Math.max(current.maximum, points.length)
    if (stable && current.moved && !current.ending) {
      if (points.length === 1 && current.maximum === 1) this.actions.move(x - current.x, y - current.y)
      else if (points.length === 2 && current.maximum === 2) this.actions.scroll(current.x - x, current.y - y)
    }
    current.x = x; current.y = y
  }
  end(remaining: number, now: number) {
    const current = this.gesture
    if (!current) return
    if (remaining) { current.ending = true; return }
    this.gesture = undefined
    if (!current.moved && now - current.started <= 350 && current.maximum <= 3)
      this.actions.tap(current.maximum === 1 ? 'left' : current.maximum === 2 ? 'right' : 'middle')
  }
  cancel() { this.gesture = undefined }
}
