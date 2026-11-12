/** What a view knows when its size is about to change. */
export interface ResizeMoment {
  /** The cover is on screen now. */
  covered: boolean
  /** A user action announced this resize: a keyboard button, a zoom, a maximize. */
  prompted: boolean
  /** Milliseconds since the cover last left; undefined if it never showed. */
  sinceUncovered: number | undefined
}
// After a cover the page may still settle, as an IME does while it finds its height.
export const settlingPeriod = 1000

/**
 * Whether a resize is covered. One that arrives under the cover extends it, and one the user
 * asked for is always covered. A resize nobody asked for, shortly after a cover has gone, is
 * the page settling: it is applied without another cover.
 */
export function coversResize({ covered, prompted, sinceUncovered }: ResizeMoment): boolean {
  return covered || prompted || sinceUncovered === undefined || sinceUncovered >= settlingPeriod
}
