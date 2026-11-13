import { isCompletionToken } from '../../../../shared/completion'
import { isWindowMetadata } from '../../../../shared/window-metadata'
import { apiContext, apiFetch, apiUrl, isCurrentApi, uuid } from '../../api/api'
import { t } from '../../plugins/i18n'
import { sameTerminalGrid } from '../../utils/terminal/terminal-geometry'
import { terminalInputHasFocus } from '../../utils/terminal/terminal-reconnect'
import { disconnectDownloads, receiveDownload } from '../files/downloads'
import { receiveCapture, removeCaptures } from './capture'
import { receiveDirectory } from './directories'
import { openTerminalConnection, type TerminalConnection } from './terminal-connection'
import { liveTerminalMetadata, metadataKey, updateMetadata } from './terminal-metadata'
import {
  endFocusSize,
  nativeResizeSettled,
  present,
  schedulePresentation,
} from './terminal-presentation'
import { refreshReadFocus, syncViewVisibility } from './terminal-read-focus'
import {
  afterPaint,
  claimFocus,
  inputElement,
  online,
  setState,
  windowSessions,
  type CompletionFrame,
  type Session,
} from './terminal-session'
import { receiveUrl } from './urls'

// A session's stream: the connection, what arrives on it, and when the screen shows it.

function clearPickerPing(session: Session) {
  if (session.pickerPing) clearTimeout(session.pickerPing.timer)
  session.pickerPing = undefined
}
/** Lets pending uploads proceed; after a file picker, first proves the connection is alive. */
export function refreshUploads(session: Session) {
  if (!session.uploads.hasPending) {
    session.uploadUnverified = false
    clearPickerPing(session)
    return
  }
  const connection = session.connection
  // A picker may deliver its change event while the page is still hidden.
  // Probe this connection only after return, without spending background retry time.
  if (
    session.uploadUnverified &&
    !session.pickerPing &&
    !document.hidden &&
    session.host?.isConnected &&
    online(session)
  ) {
    const id = uuid()
    const timer = setTimeout(() => {
      if (session.pickerPing?.id !== id || session.connection !== connection) return
      clearPickerPing(session)
      if (!document.hidden) connectionFailed(session, t('terminal.connection.timeout'))
    }, 3000)
    session.pickerPing = { id, timer }
    connection!.send({ type: 'ping', id })
  }
  session.uploads.refresh()
}
/** Pending uploads wait until the next connection, or this one after an absence, answers a ping. */
function doubtUploads(session: Session) {
  clearPickerPing(session)
  if (session.uploads.hasPending) session.uploadUnverified = true
}

/** Ends the connection. The screen stays as it was until another connection's first frame. */
export function disconnect(session: Session) {
  const connection = session.connection
  session.connection = undefined
  doubtUploads(session)
  session.touchpad.cancel()
  session.pastePreview?.()
  session.pastePreview = undefined
  updateMetadata(session)
  session.reportedVisible = undefined
  session.reportedFocused = undefined
  session.completion = undefined
  session.readCompletion = undefined
  session.readGeneration = 0
  session.readGesture = false
  session.connectionRevision++
  session.mirror.detach()
  session.shown = -1
  session.awaitingPaint = []
  session.connectionProbe?.abort()
  session.connectionProbe = undefined
  endFocusSize(session)
  if (connection) {
    disconnectDownloads(connection)
    connection.close()
  }
  session.uploads.disconnected()
  clearTimeout(session.nativeResize)
  session.nativeResize = undefined
  session.presentationRevision = (session.presentationRevision || 0) + 1
  setState(session, {
    ...session.state,
    readOnly: true,
    presentation: undefined,
    presentationCancelling: false,
    focusResize: undefined,
  })
}
export function connectionFailed(
  session: Session,
  error = t('terminal.connection.disconnected'),
  retry = true,
) {
  disconnect(session)
  session.connectionError = error
  session.reconnect.failed(retry)
}
/** The native window is gone: every view of it closes for good. */
export function windowRemoved(session: Session) {
  const { sourceId, windowId } = session.resource
  removeCaptures(sourceId, windowId)
  for (const view of windowSessions(sourceId, windowId)) {
    if (view.state.status === 'closed') continue
    view.selectionRevision = (view.selectionRevision || 0) + 1
    view.uploads.invalidate(t('terminal.closed'))
    view.reconnect.stop()
    disconnect(view)
    view.fileRead?.abort()
    view.fileRead = undefined
    view.uploads.clear()
    view.keyboard?.blur()
    view.desktopInput?.element.blur()
    setState(view, {
      ...view.state,
      status: 'closed',
      error: undefined,
      retryAttempt: undefined,
      fileReading: false,
    })
  }
  const key = metadataKey(session.resource)
  if (liveTerminalMetadata.value.get(key) !== null) {
    const next = new Map(liveTerminalMetadata.value)
    next.set(key, null)
    liveTerminalMetadata.value = next
  }
}

/** Content that was hidden shows again once a fresh frame is on screen. */
function resumed(session: Session) {
  if (!session.resuming) return
  session.resuming = false
  setState(session, { ...session.state, layoutRestoring: false })
  // An explicit return may focus the input while its fresh frame is pending.
  // Claim it only if the user has not moved focus elsewhere in the meantime.
  if (terminalInputHasFocus(inputElement(session))) claimFocus(session)
}
/** A note editor or a captured app takes the place of the terminal's content, or gives it back. */
export function setContentHidden(
  session: Session,
  reason: 'editing' | 'appShowing',
  value: boolean,
) {
  if (session[reason] === value) return
  const wasHidden = !!(session.editing || session.appShowing)
  session[reason] = value
  const hidden = !!(session.editing || session.appShowing)
  if (hidden) {
    session.touchpad.cancel()
    session.desktopInput?.element.blur()
    session.keyboard?.blur()
    session.resuming = false
  } else if (wasHidden && session.state.status === 'connected') session.resuming = true
  setState(session, { ...session.state, layoutRestoring: session.resuming })
  syncViewVisibility(session)
  if (hidden) present(session)
  else schedulePresentation(session)
}

/** A cell message. One that does not apply means the stream is lost: connect again. */
function cells(session: Session, bytes: Uint8Array) {
  let change: { frame: boolean; rows: number[] }
  try {
    change = session.mirror.apply(bytes)
  } catch {
    connectionFailed(session)
    return
  }
  session.selection.changed(change)
  session.painter.update(change)
  if (!change.frame) return
  // The window's default background also fills the card around the grid.
  if (session.host) session.host.style.backgroundColor = session.painter.background
  session.completion = undefined
  session.readCompletion = undefined
  refreshReadFocus()
  if (session.resuming) afterPaint(session, () => resumed(session))
  // A grid on the way to the one this view asked for stays covered.
  const asked = session.focusResize?.suspended ? undefined : session.focusResize?.requested
  if (session.nativeResize !== undefined && (!asked || sameTerminalGrid(asked, session.mirror)))
    afterPaint(session, () => nativeResizeSettled(session))
}
/** The painter put a revision on screen. */
export function painted(session: Session, revision: number) {
  const { mirror, painter, host } = session
  const cell = painter.metrics
  const previous = session.painted
  const next = (session.painted = {
    cols: mirror.cols,
    rows: mirror.rows,
    width: mirror.cols * cell.width,
    height: mirror.rows * cell.height,
  })
  session.shown = revision
  const cursor = painter.cursorBox()
  if (cursor) session.desktopInput?.moveTo(cursor)
  const due = session.awaitingPaint.filter((entry) => entry.revision <= revision)
  session.awaitingPaint = session.awaitingPaint.filter((entry) => entry.revision > revision)
  for (const entry of due) entry.run()
  if (!session.state.screenReady && host?.isConnected)
    setState(session, { ...session.state, screenReady: true })
  present(session)
  refreshReadFocus()
  if (previous?.width !== next.width || previous.height !== next.height)
    schedulePresentation(session)
}

function completionFrame(message: Record<string, unknown>): CompletionFrame | undefined {
  if (
    !Number.isSafeInteger(message.generation) ||
    !Array.isArray(message.panes) ||
    !message.panes.every(
      (pane: unknown) =>
        pane &&
        typeof pane === 'object' &&
        'id' in pane &&
        typeof pane.id === 'string' &&
        (!('completion' in pane) ||
          pane.completion === undefined ||
          isCompletionToken(pane.completion)),
    )
  )
    return
  return {
    generation: message.generation as number,
    layout: typeof message.layout === 'string' ? message.layout : undefined,
    focusedPaneId: typeof message.focusedPaneId === 'string' ? message.focusedPaneId : undefined,
    panes: message.panes,
  }
}
/** A JSON message; `probe` marks a connection that replaced a lost one. */
function receive(
  session: Session,
  connection: TerminalConnection,
  message: Record<string, unknown>,
  probe: boolean,
) {
  const { sourceId, windowId } = session.resource
  if (message.type === 'pong' && session.pickerPing?.id === message.id) {
    clearPickerPing(session)
    session.uploadUnverified = false
    refreshUploads(session)
  } else if (
    receiveDownload(connection, message, session.resource) ||
    receiveCapture(sourceId, windowId, message) ||
    receiveDirectory(connection, message) ||
    receiveUrl(connection, message) ||
    session.uploads.receive(message)
  )
    return
  else if (message.type === 'metadata') {
    if (isWindowMetadata(message.window) && message.window.id === windowId)
      updateMetadata(session, message.window)
  } else if (message.type === 'completion-frame') {
    const frame = completionFrame(message)
    // It follows the cells that painted it: it counts once those are on screen.
    if (frame?.generation === (session.readGeneration || 0))
      afterPaint(session, () => {
        if (frame.generation !== (session.readGeneration || 0)) return
        session.completion = frame
        refreshReadFocus()
      })
  } else if (message.type === 'pane-focus')
    setState(session, {
      ...session.state,
      focusedPaneId: typeof message.paneId === 'string' ? message.paneId : undefined,
    })
  else if (message.type === 'clipboard') {
    if (typeof message.data === 'string') session.clipboard.programCopy(message.data)
  } else if (message.type === 'presentation') {
    const revision = (session.presentationRevision = (session.presentationRevision || 0) + 1)
    const presentation = {
      maximized: message.maximized === true,
      owned: message.owned === true,
      ...(typeof message.token === 'string' && Number.isSafeInteger(message.lease)
        ? { token: message.token, lease: message.lease as number }
        : {}),
    }
    const update = () => {
      if (session.presentationRevision !== revision) return
      if (!presentation.owned && session.state.presentation?.owned && session.focusResize)
        session.focusResize.suspended = true
      setState(session, { ...session.state, presentation, presentationCancelling: false })
      schedulePresentation(session)
    }
    // A view that resumes shows its fresh frame first; one that pauses is covered at once.
    if (presentation.maximized && !presentation.owned) update()
    else afterPaint(session, update)
  } else if (message.type === 'status') {
    if (message.status === 'removed') windowRemoved(session)
    else if (message.status === 'closed' || message.status === 'error')
      connectionFailed(session, typeof message.error === 'string' ? message.error : undefined)
    else if (message.status === 'connected' || message.status === 'connecting') {
      const restoreInputFocus =
        probe && message.status === 'connected' && session.state.status !== 'connected'
      if (message.status === 'connected') session.reconnect.connected()
      setState(session, {
        ...session.state,
        status: message.status,
        error: undefined,
        retryAttempt: message.status === 'connected' ? undefined : session.state.retryAttempt,
        readOnly: message.readOnly === true,
      })
      syncViewVisibility(session)
      present(session)
      schedulePresentation(session)
      if (
        restoreInputFocus &&
        session.host?.isConnected &&
        session.viewVisible !== false &&
        terminalInputHasFocus(inputElement(session))
      )
        claimFocus(session)
    }
  } else if (message.type === 'focus-resize') {
    const request = session.focusResize
    if (!request) return
    // A competing view's token can revoke our request, but a late ended
    // acknowledgement from an older request must not end the new one.
    const revoked = !message.owned && message.reason === 'superseded'
    if (message.token !== request.token && !revoked) return
    request.suspended = message.owned !== true
    if (request.suspended) nativeResizeSettled(session)
    setState(session, { ...session.state, focusResize: { owned: message.owned === true } })
    schedulePresentation(session)
  }
}

export async function connect(session: Session, probe: boolean) {
  const revision = ++session.connectionRevision,
    context = apiContext()
  if (probe) {
    const controller = (session.connectionProbe = new AbortController())
    try {
      // A socket error hides an HTTP 401. Check the existing account/source
      // before retrying instead of repeatedly opening a rejected connection.
      const response = await apiFetch('/api/state', { signal: controller.signal }, context)
      if (session.connectionRevision !== revision) return
      if (response.status === 401) {
        connectionFailed(session, t('terminal.connection.expired'), false)
        return
      }
      if (!response.ok) throw new Error(t('terminal.connection.failed'))
      const state = (await response.json()) as { sources: Array<{ id: string }> }
      if (session.connectionRevision !== revision) return
      if (!state.sources.some((source) => source.id === session.resource.sourceId)) {
        connectionFailed(session, t('terminal.connection.removed'), false)
        return
      }
    } catch {
      if (session.connectionRevision === revision)
        connectionFailed(session, t('terminal.connection.failed'))
      return
    } finally {
      if (session.connectionProbe === controller) session.connectionProbe = undefined
    }
  }
  if (session.connectionRevision !== revision || !session.host?.isConnected || document.hidden)
    return
  const url = apiUrl('/api/terminal', context)
  url.searchParams.set('apiBase', context.base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [name, value] of Object.entries(session.resource)) url.searchParams.set(name, value)
  const connection: TerminalConnection = openTerminalConnection(url, context.token, {
    message: (message) => {
      if (isCurrentApi(context)) receive(session, connection, message, probe)
    },
    cells: (bytes) => {
      if (isCurrentApi(context)) cells(session, bytes)
    },
    // A policy close can also mean an authentication timeout or a changed connection.
    // The reconnect probe verifies the session before signing out.
    closed: (failed) =>
      connectionFailed(session, failed ? t('terminal.connection.failed') : undefined),
  })
  session.connection = connection
}

/** The page went to the background or came back. */
export function terminalVisibilityChanged(session: Session) {
  syncViewVisibility(session)
  if (document.hidden) {
    doubtUploads(session)
    session.reconnect.pause()
    // Keep healthy connections alive. Pending authentication and handshakes are
    // restarted in the foreground instead of timing out behind the user.
    if (session.state.status !== 'connected') disconnect(session)
  } else if (session.host?.isConnected) {
    if (session.state.status === 'connected') {
      if (session.connection?.open) session.reconnect.connected()
      else connectionFailed(session)
    } else session.reconnect.resume()
    refreshUploads(session)
  }
}
