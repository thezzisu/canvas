import { shallowRef, watch } from 'vue'
import { sameCompletion } from '../../../../shared/completion'
import type { PaneFocus, WindowFocus } from '../../utils/workspace/completion-focus'
import {
  interactive,
  online,
  paused,
  sessions,
  windowSessions,
  type Session,
} from './terminal-session'

// Which pane the user is reading: the focused pane of the window that has logical attention,
// while its card is really on screen. A completion painted there is reported as read.

let logicalFocus: WindowFocus | undefined
let readObserver: IntersectionObserver | undefined,
  readHost: HTMLElement | undefined,
  readVisible = false
export const terminalReadFocus = shallowRef<PaneFocus>()
watch(
  terminalReadFocus,
  () => {
    for (const session of sessions.values()) reportViewState(session)
  },
  { flush: 'sync' },
)

/** Logical attention is independent of the DOM keyboard/input controller. */
export function prepareTerminalReadFocus(focus: WindowFocus) {
  for (const session of windowSessions(focus.sourceId, focus.windowId)) {
    if (!online(session)) continue
    session.readGeneration = (session.readGeneration || 0) + 1
    session.readGesture = true
    session.completion = undefined
    session.readCompletion = undefined
  }
  refreshReadFocus()
}
/** The gesture that moved attention is over: completions painted from now on count as seen. */
export function finishTerminalReadGesture() {
  for (const session of sessions.values())
    if (session.readGesture) {
      session.readGesture = false
      session.connection?.send({ type: 'completion-fence', generation: session.readGeneration })
    }
}
export function setTerminalReadFocus(focus?: WindowFocus) {
  logicalFocus = focus
  refreshReadFocus()
}
export function refreshReadFocus() {
  const session =
    logicalFocus &&
    [...windowSessions(logicalFocus.sourceId, logicalFocus.windowId)].find(
      (session) => session.host?.isConnected,
    )
  const host = session?.host
  if (host !== readHost) {
    readObserver?.disconnect()
    readHost = host
    readVisible = false
    if (host) {
      readObserver ??= new IntersectionObserver((entries) => {
        const entry = entries.find((entry) => entry.target === readHost)
        if (entry) {
          readVisible = entry.isIntersecting
          refreshReadFocus()
        }
      })
      readObserver.observe(host)
    }
  }
  const paneId = session?.state.focusedPaneId
  if (
    !session ||
    !paneId ||
    !readVisible ||
    document.hidden ||
    !document.hasFocus() ||
    session.viewVisible === false ||
    !interactive(session) ||
    !online(session) ||
    paused(session)
  ) {
    terminalReadFocus.value = undefined
    return
  }
  const painted =
    !session.state.transitioning && session.completion?.focusedPaneId === paneId
      ? session.completion.panes.find((pane) => pane.id === paneId)?.completion
      : undefined
  const next: PaneFocus = { ...logicalFocus!, paneId, ...(painted ? { painted } : {}) }
  const previous = terminalReadFocus.value
  if (
    !previous ||
    previous.sourceId !== next.sourceId ||
    previous.windowId !== next.windowId ||
    previous.paneId !== next.paneId ||
    !sameCompletion(previous.painted, next.painted)
  )
    terminalReadFocus.value = next
  const current = session.metadata?.panes.find((pane) => pane.id === paneId)
  if (
    current?.status !== 'done' ||
    !painted ||
    !sameCompletion(current.completion, painted) ||
    (session.readCompletion?.paneId === paneId &&
      sameCompletion(session.readCompletion.completion, painted))
  )
    return
  session.readCompletion = { paneId, completion: painted }
  session.connection!.send({
    type: 'completion-read',
    generation: session.readGeneration || 0,
    paneId,
    ...painted,
  })
}
export function clearReadFocus() {
  logicalFocus = undefined
  terminalReadFocus.value = undefined
  readObserver?.disconnect()
  readHost = undefined
  readVisible = false
}

/** Tells the server whether this view shows the window, and whether the user is reading it. */
export function reportViewState(session: Session) {
  if (!online(session)) return
  const visible =
    !!session.host?.isConnected &&
    session.viewVisible !== false &&
    !document.hidden &&
    !session.editing &&
    !session.appShowing
  const focus = terminalReadFocus.value
  const focused =
    visible &&
    !!focus &&
    focus.sourceId === session.resource.sourceId &&
    focus.windowId === session.resource.windowId
  if (session.reportedVisible === visible && session.reportedFocused === focused) return
  session.reportedVisible = visible
  session.reportedFocused = focused
  session.connection!.send({ type: 'view-visible', visible, focused })
}
export function syncViewVisibility(session: Session) {
  refreshReadFocus()
  reportViewState(session)
}
