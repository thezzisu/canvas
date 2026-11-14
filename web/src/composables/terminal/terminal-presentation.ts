import { uuid } from '../../api/api'
import { coversResize, resizesRowsOnly, showsCover } from '../../utils/terminal/resize-cover'
import {
  fitTerminalGrid,
  placeFrame,
  sameTerminalGrid as sameGrid,
  type TerminalGrid,
} from '../../utils/terminal/terminal-geometry'
import { normalizeContentZoom } from '../canvas/content-zoom'
import { uncoversRowResize } from '../developer-mode'
import type { CellFontOptions } from './cell-font'
import { claimFocus, online, paused, sessions, setState, type Session } from './terminal-session'

// A view is a scaled projection of the shared native window, not its size owner. Only a
// maximized view asks for a size of its own, and gives it back when it ends.

/** The grid that fills this view's host at its font. */
function proposedSize(session: Session): TerminalGrid | undefined {
  const available = session.available
  if (!session.host?.isConnected || session.editing || !available) return
  if (!(available.width > 0 && available.height > 0)) return
  return fitTerminalGrid(available, session.painter.metrics)
}

/** Places the painted screen in the host, and covers a frame that is not the one to look at. */
export function present(session: Session) {
  if (!session.host?.isConnected) return
  const transitioning = showsCover({
    connected: session.state.status === 'connected',
    painted: !!session.state.screenReady,
    appShowing: !!session.appShowing,
    dragging: !!session.resizing,
    awaitingFrame: session.awaitingFrame,
  })
  if (session.state.transitioning !== transitioning)
    setState(session, { ...session.state, transitioning })
  const { painted, available } = session
  // The host is measured once its ResizeObserver first reports.
  if (paused(session) || !painted || !available) return
  // A maximized view asks for the window's size until another view takes the window.
  const asking = session.magnified && !session.focusResize?.suspended
  const { scale, top } = placeFrame({
    frame: painted,
    available,
    asked: asking
      ? {
          rows: proposedSize(session)?.rows ?? painted.rows,
          cellHeight: session.painter.metrics.height,
        }
      : undefined,
    upscale: session.magnified,
  })
  if (!(scale > 0)) return
  const { style } = session.surface
  style.width = `${painted.width}px`
  style.height = `${painted.height}px`
  style.transform = top ? `translateY(${top}px)` : scale === 1 ? 'none' : `scale(${scale})`
}
export function schedulePresentation(session: Session) {
  if (session.presentationFrame !== undefined) return
  session.presentationFrame = requestAnimationFrame(() => {
    session.presentationFrame = undefined
    updateFocusSize(session)
    present(session)
  })
}

// The answer is a frame from the window's backend. One that is slow, or holds the frame back,
// must not leave the terminal covered: after this long the frame on screen is shown as it is.
const answerLimit = 500
/** The frame on screen is about to be replaced: it is covered until the next one is painted. */
function awaitFrame(session: Session) {
  session.awaitingFrame = true
  boundAnswer(session)
}
/**
 * Starts the wait for the answer, or stops it. A view the server holds hidden is sent no frame,
 * so its wait starts when it shows again.
 */
export function boundAnswer(session: Session) {
  clearTimeout(session.answerLimit)
  session.answerLimit =
    session.awaitingFrame && session.reportedVisible
      ? setTimeout(() => frameSettled(session), answerLimit)
      : undefined
}
export function frameSettled(session: Session) {
  if (!session.awaitingFrame) return
  session.awaitingFrame = false
  boundAnswer(session)
  present(session)
}

/** Asks for the grid that fills a maximized view, or for another when the view changed. */
export function updateFocusSize(session: Session) {
  if (!session.magnified || session.focusResize?.suspended || !online(session)) return
  const proposed = proposedSize(session)
  if (!proposed) return
  if (!session.focusResize) {
    session.focusResize = { token: uuid(), suspended: false, requested: proposed }
    claimFocus(session)
    session.connection!.send({
      type: 'focus-resize-begin',
      token: session.focusResize.token,
      ...proposed,
    })
    // The mirror holds this connection's frame: the server sends one before it says connected.
    if (!sameGrid(proposed, session.mirror)) awaitFrame(session)
    return
  }
  const request = session.focusResize
  if (sameGrid(proposed, request.requested)) return
  request.requested = proposed
  session.connection!.send({ type: 'focus-resize-update', token: request.token, ...proposed })
  if (sameGrid(proposed, session.mirror)) return
  const covers = coversResize({
    covered: !!session.covered,
    prompted: !!session.resizePrompted,
    sinceUncovered:
      session.uncoveredAt === undefined ? undefined : performance.now() - session.uncoveredAt,
  })
  session.resizePrompted = false
  if (covers && !(uncoversRowResize.value && resizesRowsOnly(session.mirror, proposed)))
    awaitFrame(session)
}
export function endFocusSize(session: Session) {
  const request = session.focusResize
  if (!request) return
  session.focusResize = undefined
  if (session.connection?.send({ type: 'focus-resize-end', token: request.token })) {
    // The server answers the owner's release with a frame of the window at its shared size.
    // The view stays covered until that arrives, whatever size it has.
    if (!request.suspended) awaitFrame(session)
  }
  setState(session, { ...session.state, focusResize: undefined })
}

// The content font every terminal shows; the app loads it before any terminal mounts.
let contentFont = { family: 'monospace', ligatures: false }
const fontSize = (session: Session, zoom: number) =>
  (12 * (session.magnified ? normalizeContentZoom(zoom) : 100)) / 100
export const terminalFont = (size: number): CellFontOptions => ({
  ...contentFont,
  size,
  lineHeight: 1,
})

function applyFont(session: Session, size: number) {
  session.fontSize = size
  session.painter.setFont(terminalFont(size))
  // Ask for the new grid now, so the old frame is covered before the new font is painted.
  updateFocusSize(session)
}
export function setTerminalFont(font: typeof contentFont) {
  if (font.family === contentFont.family && font.ligatures === contentFont.ligatures) return
  contentFont = font
  for (const session of sessions.values()) applyFont(session, session.fontSize)
}
/** A maximized view's text size; every other view shows the shared window at the default size. */
export function setTerminalZoom(session: Session, percent: number) {
  const size = fontSize(session, percent)
  if (size === session.fontSize) return
  session.resizePrompted = true
  applyFont(session, size)
}
