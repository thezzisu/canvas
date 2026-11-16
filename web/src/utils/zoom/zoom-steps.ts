/** The levels every zoom control steps through, as browsers offer them. */
export const zoomSteps = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const

export interface ZoomRange {
  readonly min: number
  readonly max: number
}

/** The next level up within the range; a value between levels goes to the next one. */
export function zoomIn(value: number, range: ZoomRange): number {
  return zoomSteps.find((step) => step > value && step <= range.max) ?? value
}

/** The next level down within the range; a value between levels goes to the next one. */
export function zoomOut(value: number, range: ZoomRange): number {
  return zoomSteps.findLast((step) => step < value && step >= range.min) ?? value
}
