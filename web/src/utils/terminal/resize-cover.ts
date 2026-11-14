/**
 * Whether the cover is over a terminal: the frame under it is not the one to look at. That is a
 * card while the user drags its size, and a frame the server is about to replace: the answer
 * to a size this view asked for, or the window at its shared size after a view gave its own up.
 */
export const showsCover = (view: {
  connected: boolean
  /** A frame has been on screen; before that the loading panel covers. */
  painted: boolean
  /** A captured app is shown in the terminal's place. */
  appShowing: boolean
  dragging: boolean
  awaitingFrame: boolean
}) => view.connected && view.painted && !view.appShowing && (view.dragging || view.awaitingFrame)

/** What a view knows when its size is about to change. */
export interface ResizeMoment {
  /** The cover is on screen now. */
  covered: boolean
  /** A user action announced this resize: a keyboard button, a zoom, a maximize. */
  prompted: boolean
  /** Milliseconds since the cover last left; undefined if it never showed. */
  sinceUncovered: number | undefined
}
/** A resize that changes the row count alone: no line is wrapped anew, and the bottom rows stay. */
export const resizesRowsOnly = (
  shown: { cols: number; rows: number },
  asked: { cols: number; rows: number },
) => shown.cols === asked.cols && shown.rows !== asked.rows

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
