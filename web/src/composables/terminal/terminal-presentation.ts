import { uuid } from '../../api/api'
import { coversResize } from '../../utils/terminal/resize-cover'
import {
  containTerminalScale,
  fitTerminalGrid,
  ownedFrameTop,
  sameTerminalGrid as sameGrid,
  type TerminalGrid,
} from '../../utils/terminal/terminal-geometry'
import { normalizeContentZoom } from '../canvas/content-zoom'
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

/** Places the painted screen in the host, and covers a frame that is not the settled one. */
export function present(session: Session) {
  if (!session.host?.isConnected) return
  // Cover a card being resized and an old frame waiting for the native resize this view asked for.
  const transitioning =
    session.state.status === 'connected' &&
    !!session.state.screenReady &&
    !session.appShowing &&
    (!!session.resizing || session.nativeResize !== undefined)
  if (session.state.transitioning !== transitioning)
    setState(session, { ...session.state, transitioning })
  const { painted, available } = session
  // The host is measured once its ResizeObserver first reports.
  if (paused(session) || !painted || !available) return
  const { style } = session.surface
  style.width = `${painted.width}px`
  style.height = `${painted.height}px`
  // The view that owns the size shows every frame at its own font, the one it is waiting to
  // replace too: that frame keeps its bottom rows in place and is cut where it does not fit.
  if (session.magnified && session.state.focusResize?.owned) {
    const rows = proposedSize(session)?.rows ?? painted.rows
    const top = ownedFrameTop(painted.height, rows, session.painter.metrics.height)
    style.transform = top ? `translateY(${top}px)` : 'none'
    return
  }
  // Any other view shows the whole shared window, whatever shape its card has.
  const scale = containTerminalScale(available, painted, session.magnified)
  if (scale > 0) style.transform = scale === 1 ? 'none' : `scale(${scale})`
}
export function schedulePresentation(session: Session) {
  if (session.presentationFrame !== undefined) return
  session.presentationFrame = requestAnimationFrame(() => {
    session.presentationFrame = undefined
    updateFocusSize(session)
    present(session)
  })
}

// The server answers a native resize well within this; a view never waits on it for longer.
const nativeResizeLimit = 500
function awaitNativeResize(session: Session) {
  clearTimeout(session.nativeResize)
  session.nativeResize = setTimeout(() => nativeResizeSettled(session), nativeResizeLimit)
}
export function nativeResizeSettled(session: Session) {
  if (session.nativeResize === undefined) return
  clearTimeout(session.nativeResize)
  session.nativeResize = undefined
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
    if (!sameGrid(proposed, session.mirror)) awaitNativeResize(session)
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
  if (covers) awaitNativeResize(session)
}
export function endFocusSize(session: Session) {
  const request = session.focusResize
  if (!request) return
  session.focusResize = undefined
  if (session.connection?.send({ type: 'focus-resize-end', token: request.token })) {
    // The server answers the owner's release with a frame of the window at its shared size.
    // The view stays covered until that arrives, whatever size it has.
    if (!request.suspended) awaitNativeResize(session)
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
