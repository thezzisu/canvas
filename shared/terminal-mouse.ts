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
}

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
        typeof area.reports === 'boolean',
    )
  )
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
