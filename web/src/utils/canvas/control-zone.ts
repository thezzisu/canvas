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
 *
 * Only the pointer moving decides. The browser also reports the pointer leaving, and the window
 * or the page's focus changing, when nothing moved: an input method's candidate window, an emoji
 * panel or a notification opening under a still pointer, or a switch to another application.
 * Those change nothing that is shown; leaving only forgets where the pointer was, so what comes
 * in next comes from outside.
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

/** What the pointer is over where it moved, measured once per move. */
export interface ZonePlace {
  /** In the zone. */
  inside: boolean
  /** In the zone or within its exit margin. */
  near: boolean
  /** On the focused terminal's content, outside the zone. */
  onTerminal: boolean
  /** The focused terminal lies under the zone, so there is something to yield to. */
  yieldable: boolean
}
export interface ZoneMemory {
  state: ZoneState
  /** The pointer's last move was onto the focused terminal's content, outside the zone. */
  fromTerminal: boolean
}
export const restingZone: ZoneMemory = { state: 'idle', fromTerminal: false }

/** The zone after the pointer moved to `place`. `held`: a button is down, as in a drag. */
export function movedZone(memory: ZoneMemory, place: ZonePlace, held: boolean): ZoneMemory {
  const fromTerminal = place.onTerminal
  let state: ZoneState
  if (memory.state !== 'idle')
    // With nothing left to yield to, the controls are the pointer's own.
    state =
      !held && !place.near
        ? 'idle'
        : memory.state === 'yielding' && !place.yieldable
          ? 'engaged'
          : memory.state
  else if (!place.inside) state = 'idle'
  else state = memory.fromTerminal && place.yieldable ? 'yielding' : 'engaged'
  return { state, fromTerminal }
}
/** The pointer was reported leaving the page. Nothing shown changes; where it was is forgotten. */
export const leftZone = (memory: ZoneMemory): ZoneMemory => ({ ...memory, fromTerminal: false })

/** How the controls look and take the pointer, all of them alike. */
export type ControlsLook = 'engaged' | 'yielding' | 'covering' | undefined
/**
 * `covering`: at rest with the pointer on the focused terminal under the zone, so the controls
 * dim and let the pointer through.
 */
export const zoneLook = (memory: ZoneMemory, covering: boolean): ControlsLook =>
  memory.state !== 'idle' ? memory.state : covering ? 'covering' : undefined
