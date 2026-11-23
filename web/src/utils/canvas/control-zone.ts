/**
 * The canvas controls at the bottom left (the minimap standing on the toolbar) are one zone for
 * the pointer: the controls and the gap between them. What the zone does is decided by where the
 * pointer came from when it entered, not by time:
 * - from a focused terminal's content, the zone yields: faint, and pointer events pass to the
 *   terminal underneath;
 * - from anywhere else (the canvas, the sidebar, another card, outside the window), the zone is
 *   engaged: opaque and usable, across the gap from one control to the other.
 * The decision holds while the pointer stays in the zone. It leaves only once the pointer is a
 * margin beyond the zone, so a pointer trembling on its edge does not turn it over, and while a
 * button is held it leaves only when the button is released.
 */

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}
export interface Point {
  x: number
  y: number
}
/** `engaged`: entered from outside a terminal. `yielding`: entered from the focused terminal. */
export type ZoneState = 'idle' | 'engaged' | 'yielding'

/** How far past the zone the pointer goes before it has left: the gap between the controls. */
export const ZONE_EXIT_MARGIN = 8

export const within = (rect: Rect, point: Point, margin = 0) =>
  point.x >= rect.left - margin &&
  point.x < rect.right + margin &&
  point.y >= rect.top - margin &&
  point.y < rect.bottom + margin
export const overlaps = (a: Rect, b: Rect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

/** The controls, and the gap between two that stand close enough to be one zone. */
export function zoneOf(controls: readonly Rect[], gap = ZONE_EXIT_MARGIN * 2): Rect[] {
  const shown = controls.filter((rect) => rect.right > rect.left && rect.bottom > rect.top)
  const zone = [...shown]
  for (let i = 0; i < shown.length; i++)
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i]!,
        b = shown[j]!
      const left = Math.max(a.left, b.left),
        right = Math.min(a.right, b.right)
      const upper = a.top < b.top ? a : b,
        lower = upper === a ? b : a
      // Stacked: overlapping columns, a gap between them no wider than `gap`.
      if (left < right && lower.top >= upper.bottom && lower.top - upper.bottom <= gap)
        zone.push({ left, right, top: upper.bottom, bottom: lower.top })
      const top = Math.max(a.top, b.top),
        bottom = Math.min(a.bottom, b.bottom)
      const first = a.left < b.left ? a : b,
        second = first === a ? b : a
      // Side by side.
      if (top < bottom && second.left >= first.right && second.left - first.right <= gap)
        zone.push({ left: first.right, right: second.left, top, bottom })
    }
  return zone
}
export const inZone = (zone: readonly Rect[], point: Point, margin = 0) =>
  zone.some((rect) => within(rect, point, margin))

export interface ZoneStep {
  /** The pointer is in the zone. */
  inside: boolean
  /** The pointer is in the zone or within its exit margin. */
  near: boolean
  /** A button is held: the gesture keeps the zone's decision until it ends. */
  held: boolean
  /** Just before, the pointer was on the focused terminal's content, outside the zone. */
  fromTerminal: boolean
  /** The focused terminal lies under the zone, so there is something to yield to. */
  yieldable: boolean
}
/** The zone's next state, from its current one and the pointer's step. */
export function nextZone(state: ZoneState, step: ZoneStep): ZoneState {
  if (state !== 'idle') {
    if (!step.held && !step.near) return 'idle'
    // With nothing left to yield to, the controls are the pointer's own.
    return state === 'yielding' && !step.yieldable ? 'engaged' : state
  }
  if (!step.inside) return 'idle'
  return step.fromTerminal && step.yieldable ? 'yielding' : 'engaged'
}
