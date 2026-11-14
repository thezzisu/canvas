import type { CellMirror } from '../../../../shared/cell-wire'
import type { CompletionToken } from '../../../../shared/completion'
import type { WindowMetadata } from '../../../../shared/window-metadata'
import type { ClipboardNotice, TerminalClipboard } from '../../utils/clipboard'
import type { TerminalModifiers } from '../../utils/terminal/terminal-input'
import type { bindTerminalMouseDefaults } from '../../utils/terminal/terminal-mouse-defaults'
import type { TerminalGrid } from '../../utils/terminal/terminal-geometry'
import type { TerminalInputHold } from '../../utils/terminal/terminal-input-hold'
import type { TerminalReconnect } from '../../utils/terminal/terminal-reconnect'
import type { TerminalTouchMode } from '../../utils/terminal/terminal-touch'
import type { TerminalUploads, TerminalUploadState } from '../../utils/terminal/uploads'
import type { CellPainter } from './cell-painter'
import type { bindDesktopInput } from './desktop-input'
import type { bindMobileInput } from './mobile-input'
import type { bindMobileKeyboard } from './mobile-keyboard'
import type { TerminalConnection } from '../../utils/terminal/terminal-channels'
import type { bindTerminalKeyboardLock } from './terminal-keyboard-lock'
import type { bindTerminalMouse } from './terminal-mouse'
import type { TerminalSelection } from './terminal-selection'
import type { TerminalSettings } from './terminal-settings'
import type { bindTerminalTouchpad } from './terminal-touchpad'

/** What a card shows of its terminal. */
export type TerminalStatus = {
  layoutRestoring?: boolean
  status: 'connecting' | 'connected' | 'disconnected' | 'closed'
  screenReady?: boolean
  transitioning?: boolean
  error?: string
  readOnly?: boolean
  focusedPaneId?: string
  presentation?: { maximized: boolean; owned: boolean; token?: string; lease?: number }
  presentationCancelling?: boolean
  focusResize?: { owned: boolean }
  upload?: TerminalUploadState
  draggingFile?: boolean
  fileReading?: boolean
  clipboardError?: ClipboardNotice
  modifiers?: TerminalModifiers
  touchMode?: TerminalTouchMode
  keyboardRequested?: boolean
  keyboardMode?: 'system' | 'builtin'
  keyboardDeck?: boolean
  keyboardComposer?: boolean
  retryAttempt?: number
}
/** The panes of a painted screen, with what each has completed. */
export interface CompletionFrame {
  generation: number
  layout?: string
  focusedPaneId?: string
  panes: Array<{ id: string; completion?: CompletionToken }>
}

/**
 * One window in this browser. It outlives the cards that show it: a card mounts it into its
 * host, and a maximize or a canvas switch moves it to another host with its screen intact.
 */
export interface Session {
  resource: { sourceId: string; spaceId: string; windowId: string }
  state: TerminalStatus
  listeners: Set<(state: TerminalStatus) => void>
  /** Runs after every state change. */
  changed(): void
  settings: TerminalSettings

  /** The window's screen, the painter that shows it and the box that scales it into the host. */
  mirror: CellMirror
  painter: CellPainter
  surface: HTMLDivElement
  /** The font size in CSS pixels: the default, or a maximized view's zoom. */
  fontSize: number
  /** The revision on screen; -1 before this connection's first paint. */
  shown: number
  /** The grid on screen, with its size in the surface's own pixels. */
  painted?: TerminalGrid & { width: number; height: number }
  /** Work that waits until the screen shows the revision it arrived with. */
  awaitingPaint: { revision: number; run(): void }[]
  /** Content that was hidden stays covered until a fresh FRAME is on screen. */
  resuming: boolean

  host?: HTMLElement
  /** The host's content box from its ResizeObserver; reading it never forces layout. */
  available?: { width: number; height: number }
  viewVisible?: boolean
  reportedVisible?: boolean
  reportedFocused?: boolean
  magnified: boolean
  mobile: boolean
  editing?: boolean
  appShowing?: boolean
  resizing?: boolean
  /** The server is about to replace the frame on screen, which stays covered until then. */
  awaitingFrame: boolean
  /** Ends that wait if no answer comes; see `boundAnswer`. */
  answerLimit?: ReturnType<typeof setTimeout>
  /** What decides whether the next resize is covered; see `coversResize`. */
  covered?: boolean
  uncoveredAt?: number
  resizePrompted?: boolean
  focusResize?: { token: string; suspended: boolean; requested?: TerminalGrid }
  presentationFrame?: number
  presentationRevision?: number

  connection?: TerminalConnection
  reconnect: TerminalReconnect
  connectionRevision: number
  connectionError?: string
  metadata?: WindowMetadata
  lastName?: string

  readGeneration?: number
  readGesture?: boolean
  /** What the screen shows of each pane's completion. */
  completion?: CompletionFrame
  readCompletion?: { paneId: string; completion: CompletionToken }

  modifiers: TerminalModifiers
  touchMode: TerminalTouchMode
  keyboardRequested: boolean
  desktopInput?: ReturnType<typeof bindDesktopInput>
  mobileInput?: ReturnType<typeof bindMobileInput>
  keyboard?: ReturnType<typeof bindMobileKeyboard>
  keyboardLock?: ReturnType<typeof bindTerminalKeyboardLock>
  /** The key a shortcut was sent for, with the on-screen modifiers it used, while it repeats. */
  nativeKey?: { id: string; virtual: TerminalModifiers }
  // Browsers without a paste event for Ctrl+Shift+V fall back to the async clipboard.
  shiftPaste?: ReturnType<typeof setTimeout>
  /** Keystrokes typed while a composer send is in flight follow its paste. */
  input: TerminalInputHold
  mouse: ReturnType<typeof bindTerminalMouse>
  selection: TerminalSelection
  clipboard: TerminalClipboard
  touchpad: ReturnType<typeof bindTerminalTouchpad>
  removeTouch(): void
  /** The right button's owner, bound by the card that shows the session now. */
  mouseDefaults?: ReturnType<typeof bindTerminalMouseDefaults>

  uploads: TerminalUploads
  pastePreview?: () => void
  fileRead?: AbortController
  fileLink?: Promise<void>
  selectionRevision?: number
  uploadUnverified?: boolean
  pickerPing?: { id: string; timer: ReturnType<typeof setTimeout> }
}

export const sessions = new Map<string, Session>()
export const sessionKey = (resource: Session['resource']) =>
  `${resource.sourceId}\u0000${resource.spaceId}\u0000${resource.windowId}`
/** Every session of a native window: one per space it has been seen in. */
export function* windowSessions(sourceId: string, windowId: string) {
  for (const session of sessions.values())
    if (session.resource.sourceId === sourceId && session.resource.windowId === windowId)
      yield session
}

export function contentFocusable(session: Session) {
  return !session.editing && !session.appShowing && (!session.mobile || session.magnified)
}
export function interactive(session: Session) {
  return contentFocusable(session) && !session.resuming
}
/** Connected, with a link that can carry a message now. */
export function online(session: Session) {
  return session.state.status === 'connected' && !!session.connection?.open
}
/** Another browser's maximized view has the window. */
export function maximizedElsewhere(session: Session) {
  return !!session.state.presentation?.maximized && !session.state.presentation.owned
}
/** The window is maximized and this view is not the one showing it so. */
export function paused(session: Session) {
  return (
    !!session.state.presentation?.maximized &&
    !(session.state.presentation.owned && session.magnified)
  )
}
/** The input this view's keyboard goes through. */
export function inputElement(session: Session) {
  return session.mobile ? session.mobileInput?.element : session.desktopInput?.element
}

export function setState(session: Session, state: TerminalStatus) {
  if (
    state.status !== 'connected' ||
    state.readOnly ||
    (state.presentation?.maximized && !state.presentation.owned)
  )
    session.touchpad.cancel()
  const next = (session.state = {
    ...state,
    modifiers: session.modifiers,
    touchMode: session.touchMode,
    keyboardRequested: session.keyboardRequested,
  })
  session.desktopInput?.refresh()
  session.keyboardLock?.refresh()
  session.touchpad.refresh()
  session.listeners.forEach((listener) => listener(next))
  session.changed()
}
export function setModifiers(session: Session, modifiers: Partial<TerminalModifiers> = {}) {
  session.modifiers = {
    shift: modifiers.shift === true,
    ctrl: modifiers.ctrl === true,
    alt: modifiers.alt === true,
    meta: modifiers.meta === true,
  }
  setState(session, { ...session.state, modifiers: session.modifiers })
}
/** Take input control of the window for this browser. */
export function claimFocus(session: Session) {
  if (!interactive(session) || !online(session) || maximizedElsewhere(session)) return
  session.connection!.send({ type: 'focus' })
  setState(session, { ...session.state, readOnly: false })
}
/** Runs once the screen shows everything received so far: at once when it already does. */
export function afterPaint(session: Session, run: () => void) {
  if (session.shown === session.mirror.revision) run()
  else session.awaitingPaint.push({ revision: session.mirror.revision, run })
}
