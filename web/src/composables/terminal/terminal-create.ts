import { CellMirror } from '../../../../shared/cell-wire'
import { isCurrentApi, uuid, type ApiContext } from '../../api/api'
import { t } from '../../plugins/i18n'
import { TerminalClipboard } from '../../utils/clipboard'
import type { CellTheme } from '../../utils/terminal/cell-style'
import { emptyModifiers } from '../../utils/terminal/terminal-input'
import { TerminalInputHold } from '../../utils/terminal/terminal-input-hold'
import { TerminalReconnect } from '../../utils/terminal/terminal-reconnect'
import { bindTerminalTouch } from '../../utils/terminal/terminal-touch'
import { TerminalUploads } from '../../utils/terminal/uploads'
import { pendingWrites } from '../pending-writes'
import { CellPainter } from './cell-painter'
import { openTerminalLink } from './terminal-files'
import { focusTerminal, operable, sendInput } from './terminal-keys'
import { schedulePresentation, terminalFont } from './terminal-presentation'
import { finishTerminalReadGesture, refreshReadFocus } from './terminal-read-focus'
import {
  contentFocusable,
  inputElement,
  interactive,
  maximizedElsewhere,
  online,
  setState,
  type Session,
} from './terminal-session'
import { TerminalSelection } from './terminal-selection'
import type { TerminalSettings } from './terminal-settings'
import { connect, connectionFailed, painted, refreshUploads } from './terminal-stream'
import { bindTerminalMouse } from './terminal-mouse'
import { bindTerminalTouchpad } from './terminal-touchpad'

const theme: CellTheme = {
  foreground: 0xd5d7dd,
  background: 0x111317,
  cursor: 0xe8b183,
  cursorAccent: 0x000000,
  selectionBackground: 0x415168,
  // The normal eight and bright black and white are Canvas's; the rest are xterm.js's defaults.
  ansi: [
    0x20242b, 0xf08080, 0x9ecb8f, 0xe5c285, 0x8daed7, 0xc7a0df, 0x8fc5c4, 0xd5d7dd, 0x66707f,
    0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xf6f6f7,
  ],
}

/** Shift selects in this browser instead of reaching the program, except on a Mac. */
const selects = (event: MouseEvent) => event.shiftKey && !/Mac/.test(navigator.platform)

/** A session with its screen, pointer devices and transfers; a card mounts it and adds a keyboard. */
export function createSession(
  resource: Session['resource'],
  settings: TerminalSettings,
  context: ApiContext,
): Session {
  const mirror = new CellMirror()
  const surface = document.createElement('div')
  surface.className = 'terminal-surface'
  Object.assign(surface.style, { transformOrigin: 'top left', width: '100%', height: '100%' })
  const painter = new CellPainter(surface, mirror, {
    font: terminalFont(12),
    theme,
    onPaint: (revision) => painted(session, revision),
    onMetrics: () => schedulePresentation(session),
    // A selection gesture ending on a link selects; a tap of the virtual pointer never selects.
    onLink: (uri, event) => {
      if (session.host?.isConnected && (!event.isTrusted || !session.selection.active))
        openTerminalLink(session, uri)
    },
  })
  const selection = new TerminalSelection(mirror, painter)
  /** May send pointer input: the user controls the window from this view. */
  const pointing = () => operable(session) && !session.state.readOnly
  const cell = (x: number, y: number) => painter.cellAt(x, y)
  const send = (data: string) => sendInput(session, data)
  const rowHeight = () =>
    mirror.rows ? painter.element.getBoundingClientRect().height / mirror.rows : 0
  const touching = () => session.mobile && session.magnified && pointing()
  const copyGesture = () => session.clipboard.touchSelectionCompleted()
  const removeTouch = bindTerminalTouch(surface, {
    active: touching,
    mode: () => session.touchMode,
    focus: () => focusTerminal(session),
    copyGesture,
    cell,
    send,
    rowHeight,
  })
  // The touch handler releases its mouse input first.
  surface.addEventListener('touchend', finishTerminalReadGesture)
  surface.addEventListener('touchcancel', finishTerminalReadGesture)
  // Browser uploads and composer deliveries stop if the page closes.
  const transfer = `terminal-upload:${uuid()}`
  const session: Session = {
    resource: { ...resource },
    state: { status: 'connecting' },
    listeners: new Set(),
    changed: () => {
      refreshUploads(session)
      refreshReadFocus()
    },
    settings,
    mirror,
    painter,
    surface,
    fontSize: 12,
    shown: -1,
    awaitingPaint: [],
    resuming: false,
    magnified: false,
    mobile: false,
    connectionRevision: 0,
    modifiers: emptyModifiers(),
    touchMode: 'scroll',
    keyboardRequested: false,
    input: new TerminalInputHold(),
    selection,
    removeTouch,
    mouse: bindTerminalMouse(surface, {
      active: pointing,
      cell,
      send,
      hover: () => session.settings.mouseHover,
      selection,
      selects,
      rowHeight,
    }),
    touchpad: bindTerminalTouchpad(surface, painter.element, {
      active: touching,
      enabled: () => session.touchMode === 'touchpad',
      focus: () => focusTerminal(session),
      hover: () => session.settings.mouseHover,
      modifiers: () => session.modifiers,
      copyGesture,
      grid: () => mirror,
      send,
      selecting: () => selection.active,
      point: (at) => painter.setPointer(at),
      click: ({ column, row }) => {
        const uri = painter.linkAt(column, row)
        if (uri) openTerminalLink(session, uri)
      },
    }),
    clipboard: new TerminalClipboard(surface, {
      visible: () =>
        !!session.host?.isConnected &&
        !(
          session.state.presentation?.maximized &&
          (!session.state.presentation.owned || !session.magnified)
        ),
      controlsInput: () =>
        interactive(session) && session.state.status === 'connected' && !session.state.readOnly,
      focused: () => document.activeElement === inputElement(session),
      selection: () => selection.text,
      selects,
      copyError: (clipboardError) => setState(session, { ...session.state, clipboardError }),
    }),
    reconnect: new TerminalReconnect({
      active: () => !!session.host?.isConnected && !document.hidden,
      connect: (probe) => void connect(session, probe),
      waiting: (attempt) =>
        setState(session, {
          ...session.state,
          status: 'connecting',
          error: undefined,
          retryAttempt: attempt || undefined,
        }),
      failed: () =>
        setState(session, {
          ...session.state,
          status: 'disconnected',
          error: session.connectionError,
          retryAttempt: undefined,
        }),
      timeout: () => connectionFailed(session, t('terminal.connection.timeout')),
    }),
    uploads: new TerminalUploads({
      readiness: () => {
        if (
          !isCurrentApi(context) ||
          !session.host?.isConnected ||
          !contentFocusable(session) ||
          session.state.status === 'closed' ||
          session.state.status === 'disconnected' ||
          (session.state.presentation?.maximized && !session.magnified)
        )
          return 'unavailable'
        if (
          document.hidden ||
          session.uploadUnverified ||
          session.resuming ||
          !session.state.screenReady ||
          !online(session) ||
          (session.magnified && (!session.state.focusResize?.owned || maximizedElsewhere(session)))
        )
          return 'waiting'
        return 'ready'
      },
      unavailableReason: () =>
        session.state.status === 'closed'
          ? t('terminal.closed')
          : maximizedElsewhere(session)
            ? t('terminal.maximized')
            : session.state.status === 'disconnected'
              ? t('terminal.upload.disconnected')
              : t('terminal.upload.targetChanged'),
      focus: () => focusTerminal(session),
      send: (message) => !!session.connection?.send(message),
      changed: (upload) => {
        setState(session, { ...session.state, upload })
        if (upload && ['waiting', 'preparing', 'uploading'].includes(upload.state))
          pendingWrites.start(transfer, 'upload')
        else pendingWrites.stop(transfer, 'upload')
      },
    }),
  }
  return session
}

/** Ends a session for good: its devices, transfers and connection. */
export function disposeSession(session: Session) {
  session.fileRead?.abort()
  session.uploads.clear()
  session.keyboardLock?.dispose()
  session.mouseDefaults?.dispose()
  session.removeTouch()
  session.touchpad.dispose()
  session.mouse.dispose()
  session.keyboard?.dispose()
  session.mobileInput?.dispose()
  session.desktopInput?.dispose()
  session.reconnect.pause()
  if (session.presentationFrame !== undefined) cancelAnimationFrame(session.presentationFrame)
  session.clipboard.dispose()
  session.painter.dispose()
}
