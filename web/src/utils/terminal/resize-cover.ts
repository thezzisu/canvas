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

/** A resize that changes the row count alone: no line is wrapped anew, and the bottom rows stay. */
export const resizesRowsOnly = (
  shown: { cols: number; rows: number },
  asked: { cols: number; rows: number },
) => shown.cols === asked.cols && shown.rows !== asked.rows
