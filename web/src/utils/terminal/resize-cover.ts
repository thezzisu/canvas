/**
 * Whether the cover is over a terminal: the frame under it is not the one to look at. That is a
 * card while the user drags its size, and a frame the server is about to replace with one that
 * wraps differently: the answer to a size this view asked for, or the window at its shared size
 * after a view gave its own up.
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

/**
 * Whether the frame on screen is not worth looking at while the grid asked for is on its way:
 * another column count wraps its lines anew. With the same columns the bottom rows stay where
 * they are, and the answer only adds or drops rows at the top.
 */
export const rewraps = (shown: { cols: number }, asked: { cols: number }) =>
  shown.cols !== asked.cols
