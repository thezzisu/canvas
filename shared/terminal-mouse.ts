/** Only complete SGR no-button motion is passive; mixed/partial input stays ordered. */
export function isTerminalHoverInput(data: string): boolean {
  return /^(?:\x1b\[<(?:35|39|43|47|51|55|59|63);[1-9]\d*;[1-9]\d*M)+$/u.test(data)
}

/**
 * Where the program under the pointer takes the mouse, in grid cells: there, a plain hover or
 * click is the program's, and the browser's own link handling waits for Ctrl or ⌘. An area later
 * in the list lies over an earlier one; a cell in none is the browser's.
 */
export interface MouseArea {
  x: number
  y: number
  width: number
  height: number
  reports: boolean
  /** The pointer the program asked for (OSC 22), as a CSS cursor; the browser's own without one. */
  pointer?: PointerShape
}
/** The pointer shapes a program may ask for (OSC 22), as CSS cursor values. */
export const POINTER_SHAPES = [
  'context-menu',
  'help',
  'pointer',
  'progress',
  'wait',
  'cell',
  'crosshair',
  'text',
  'vertical-text',
  'alias',
  'copy',
  'move',
  'no-drop',
  'not-allowed',
  'grab',
  'grabbing',
  'all-scroll',
  'col-resize',
  'row-resize',
  'n-resize',
  'e-resize',
  's-resize',
  'w-resize',
  'ne-resize',
  'nw-resize',
  'se-resize',
  'sw-resize',
  'ew-resize',
  'ns-resize',
  'nesw-resize',
  'nwse-resize',
  'zoom-in',
  'zoom-out',
] as const
export type PointerShape = (typeof POINTER_SHAPES)[number]
export const isPointerShape = (value: unknown): value is PointerShape =>
  (POINTER_SHAPES as readonly unknown[]).includes(value)

export function isMouseAreas(value: unknown): value is MouseArea[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every(
      (area) =>
        area &&
        typeof area === 'object' &&
        ['x', 'y', 'width', 'height'].every(
          (key) => Number.isInteger(area[key]) && area[key] >= 0 && area[key] <= 4096,
        ) &&
        typeof area.reports === 'boolean' &&
        (area.pointer === undefined || isPointerShape(area.pointer)),
    )
  )
}

/** The pointer a program asked for at a cell (OSC 22); undefined for the browser's own. */
export function programPointer(areas: readonly MouseArea[], column: number, row: number) {
  let pointer: PointerShape | undefined
  for (const area of areas)
    if (
      column >= area.x &&
      column < area.x + area.width &&
      row >= area.y &&
      row < area.y + area.height
    )
      pointer = area.pointer
  return pointer
}

/** Whether the program takes the mouse at a cell. */
export function programTakesMouse(areas: readonly MouseArea[], column: number, row: number) {
  let reports = false
  for (const area of areas)
    if (
      column >= area.x &&
      column < area.x + area.width &&
      row >= area.y &&
      row < area.y + area.height
    )
      reports = area.reports
  return reports
}
