import { watch } from 'vue'
import { locale, t } from './i18n'
import { Terminal } from '@xterm/xterm'
import { terminalUnicodeAddon } from '../../shared/terminal-unicode'
import { apiContext, apiFetch, apiUrl, isCurrentApi, uuid } from './api'
import { clearDownloads, disconnectDownloads, receiveDownload } from './downloads'
import { clearDirectories, receiveDirectory } from './directories'
import { clearUrls, receiveUrl } from './urls'
import { bindFileInput, preventFileNavigation, TerminalUploads, type TerminalUploadState } from './uploads'
import { clipboardRestoringFocus, TerminalClipboard, type ClipboardNotice } from './clipboard'
import { emptyModifiers, hasModifiers, modifiedText, terminalKey, terminalShortcut, type TerminalModifiers } from './terminal-input'
import { terminalInputChunks } from './terminal-input-chunks'
import { bindTerminalKeyboardLock } from './terminal-keyboard-lock'
import { bindTerminalTouch, type TerminalTouchMode } from './terminal-touch'
import { defaultContentFont, type ContentFontSettings } from '../../shared/settings'
import { applyTerminalFontFeatures, type FontPresentation } from './fonts'
import { bindMobileKeyboard } from './mobile-keyboard'
import { bindMobileInput } from './mobile-input'
import { copiedFile } from './file-clipboard'
import { loadCanvasFile } from './file-transfer'
import type { CanvasFileReference } from './file-reference'
import { fitTerminalGrid, terminalBox } from './terminal-geometry'
import { TerminalReconnect } from './terminal-reconnect'

export type TerminalStatus = {
  status: 'connecting' | 'connected' | 'disconnected'
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
  retryAttempt?: number
}
export interface TerminalGeometry { width: number; height: number }
interface FocusResize { token: string; suspended: boolean; requested?: { cols: number; rows: number } }
interface Session {
  term: Terminal
  surface: HTMLDivElement
  host?: HTMLElement
  viewVisible?: boolean
  reportedVisible?: boolean
  magnified: boolean
  mobile: boolean
  modifiers: TerminalModifiers
  touchMode: TerminalTouchMode
  keyboardRequested: boolean
  keyboard?: ReturnType<typeof bindMobileKeyboard>
  mobileInput?: ReturnType<typeof bindMobileInput>
  keyHandler?: (event: KeyboardEvent) => boolean
  suppressInput?: boolean
  nativeKey?: { id: string; virtual: TerminalModifiers }
  keyboardLock?: ReturnType<typeof bindTerminalKeyboardLock>
  removeFontFeatures?: () => void
  resizeTimer?: ReturnType<typeof setTimeout>
  removeTouch?: () => void
  focusResize?: FocusResize
  presentationFrame?: number
  presentationRevision?: number
  socket?: WebSocket
  reconnect?: TerminalReconnect
  connectionRevision: number
  connectionProbe?: AbortController
  connectionError?: string
  opened: boolean
  rendered?: TerminalGeometry & { cols: number; rows: number }
  state: TerminalStatus
  listeners: Set<(state: TerminalStatus) => void>
  geometryListeners: Set<(geometry: TerminalGeometry) => void>
  resource: { sourceId: string; spaceId: string; windowId: string }
  uploads: TerminalUploads
  fileRead?: AbortController
  clipboard?: TerminalClipboard
}
const sessions = new Map<string, Session>()
function syncViewVisibility(session: Session) {
  if (session.state.status !== 'connected' || session.socket?.readyState !== WebSocket.OPEN) return
  const visible = !!session.host?.isConnected && session.viewVisible !== false && !document.hidden
  if (session.reportedVisible === visible) return
  session.reportedVisible = visible
  session.socket.send(JSON.stringify({ type: 'view-visible', visible }))
}
function acceptsFile(session: Session) {
  return interactive(session) && session.state.status === 'connected' && session.socket?.readyState === WebSocket.OPEN &&
    !(session.state.presentation?.maximized && (!session.state.presentation.owned || !session.magnified))
}
async function uploadReference(session: Session, reference: CanvasFileReference) {
  if (session.fileRead) return
  if (!acceptsFile(session)) { session.uploads.reject(t('terminal.upload.disconnected')); return }
  const context = apiContext(), controller = session.fileRead = new AbortController()
  setState(session, { ...session.state, fileReading: true })
  try {
    const file = await loadCanvasFile(reference, AbortSignal.any([context.signal, controller.signal]))
    if (!isCurrentApi(context) || controller.signal.aborted) return
    if (!acceptsFile(session)) throw new Error('terminal.upload.disconnected')
    session.uploads.enqueue([file])
  } catch (reason) {
    if (!isCurrentApi(context) || controller.signal.aborted) return
    const message = reason instanceof Error && (reason.message.startsWith('fileTransfer.') || reason.message === 'terminal.upload.disconnected') ? t(reason.message) : t('fileTransfer.failed')
    session.uploads.reject(message)
  } finally {
    if (session.fileRead === controller) { session.fileRead = undefined; setState(session, { ...session.state, fileReading: false }) }
  }
}
export function pasteFileIntoWindow(sourceId: string, windowId: string) {
  const reference = copiedFile.value?.reference
  const session = [...sessions.values()].find(value => value.resource.sourceId === sourceId && value.resource.windowId === windowId && value.host?.isConnected)
  if (reference && session) return uploadReference(session, reference)
}
watch(locale, () => {
  Terminal.strings.promptLabel = t('terminal.keyboard.input')
  Terminal.strings.tooMuchOutput = t('terminal.tooMuchOutput')
  for (const session of sessions.values()) session.term.textarea?.setAttribute('aria-label', Terminal.strings.promptLabel)
}, { immediate: true })
export function hasLiveTerminal(sourceId: string, windowId: string): boolean {
  return [...sessions.values()].some(session => session.resource.sourceId === sourceId && session.resource.windowId === windowId &&
    session.host?.isConnected && session.state.status !== 'disconnected')
}
let contentFont = defaultContentFont()
// The authenticated app loads bundled fonts before applying this presentation.
let fontPresentation: FontPresentation = { family: 'monospace', features: '"calt" 0, "liga" 0, "dlig" 0' }
export function setContentFont(settings: ContentFontSettings, presentation: FontPresentation) {
  contentFont = { ...settings, stack: settings.stack.map(font => ({ ...font })) }
  fontPresentation = presentation
  for (const session of sessions.values()) {
    session.rendered = undefined
    session.term.options.fontFamily = presentation.family
    if (session.opened) session.removeFontFeatures = applyTerminalFontFeatures(session.term, contentFont)
    // Fonts alter cell metrics, not the shared native grid. Only an existing
    // magnified owner may update its temporary geometry through the usual lease.
    schedulePresentation(session)
  }
}
const scrollbarWidth = 6
let mouseOwner: Session | undefined
let terminalEventsInstalled = false
const mouseEvents = ['mousedown', 'mousemove', 'mouseup', 'wheel'] as const
export function terminalConsumesWheel(event: WheelEvent): boolean {
  if (event.ctrlKey) return false
  const target = event.target
  return target instanceof Node && [...sessions.values()].some(session =>
    session.term.element?.contains(target) &&
    session.term.element.contains(document.activeElement) && document.hasFocus() &&
    session.state.status === 'connected' && !session.state.readOnly &&
    !(session.state.presentation?.maximized && !session.state.presentation.owned) &&
    session.term.modes.mouseTrackingMode !== 'none')
}
function normalizeMouseCoordinates(event: MouseEvent) {
  // Canvas gestures need screen coordinates; only native wheel reports need
  // conversion into the terminal's unscaled cell coordinate system.
  if (event instanceof WheelEvent && !terminalConsumesWheel(event)) return
  const target = event.target
  const pointed = target instanceof Node
    ? [...sessions.values()].find(session => session.term.element?.contains(target))
    : undefined
  if (event.type === 'mousemove' && event.buttons === 0 && !pointed) mouseOwner = undefined
  if (event.type === 'mousedown') mouseOwner = pointed
  const session = event.type === 'mousemove' || event.type === 'mouseup' ? mouseOwner || pointed : pointed
  if (event.type === 'mouseup') mouseOwner = undefined
  const screen = session?.term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen?.isConnected) return
  const rect = screen.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  // xterm 6 measures cells in untransformed CSS pixels. Normalize at its input
  // boundary for both canvas zoom and the native-window projection. Document
  // capture also covers selection/native mouse drags outside the screen.
  Object.defineProperties(event, {
    clientX: { configurable: true, value: rect.left + (event.clientX - rect.left) * screen.offsetWidth / rect.width },
    clientY: { configurable: true, value: rect.top + (event.clientY - rect.top) * screen.offsetHeight / rect.height },
  })
}
function releaseMouseOwner() { mouseOwner = undefined }
function installTerminalEvents() {
  if (terminalEventsInstalled) return
  for (const event of mouseEvents) document.addEventListener(event, normalizeMouseCoordinates, true)
  document.addEventListener('dragover', preventFileNavigation)
  document.addEventListener('drop', preventFileNavigation)
  document.addEventListener('visibilitychange', terminalVisibilityChanged)
  window.addEventListener('blur', releaseMouseOwner)
  terminalEventsInstalled = true
}
const key = (sourceId: string, spaceId: string, windowId: string) => `${sourceId}\u0000${spaceId}\u0000${windowId}`
function setState(session: Session, state: TerminalStatus) {
  const next = session.state = { ...state, modifiers: session.modifiers, touchMode: session.touchMode,
    keyboardRequested: session.keyboardRequested }
  session.keyboardLock?.refresh()
  session.listeners.forEach(listener => listener(next))
}
function interactive(session: Session) { return !session.mobile || session.magnified }
function setModifiers(session: Session, modifiers: Partial<TerminalModifiers> = {}) {
  session.modifiers = { shift: modifiers.shift === true, ctrl: modifiers.ctrl === true, alt: modifiers.alt === true, meta: modifiers.meta === true }
  setState(session, { ...session.state, modifiers: session.modifiers })
}
function focusTerminal(session: Session, keyboard?: boolean) {
  if (!interactive(session)) return
  claimFocus(session)
  if (session.mobile) session.keyboard?.focus(keyboard)
  else session.term.focus()
}
export function focusWindow(sourceId: string, spaceId: string, windowId: string, keyboard?: boolean): boolean {
  const session = sessions.get(key(sourceId, spaceId, windowId))
  if (!session?.host?.isConnected || !interactive(session)) return false
  focusTerminal(session, keyboard)
  return session.term.element?.contains(document.activeElement) === true
}
function schedulePresentation(session: Session) {
  if (session.presentationFrame !== undefined) return
  session.presentationFrame = requestAnimationFrame(() => {
    session.presentationFrame = undefined
    if (session.mobile && session.magnified && session.focusResize) {
      clearTimeout(session.resizeTimer)
      session.resizeTimer = setTimeout(() => { session.resizeTimer = undefined; updateFocusSize(session) }, 200)
    } else updateFocusSize(session)
    present(session)
  })
}
function disconnect(session: Session) {
  session.reportedVisible = undefined
  session.connectionRevision++
  session.connectionProbe?.abort(); session.connectionProbe = undefined
  endFocusSize(session)
  const socket = session.socket
  session.socket = undefined
  if (socket) { disconnectDownloads(socket); socket.close() }
  session.uploads.disconnected()
  session.presentationRevision = (session.presentationRevision || 0) + 1
  setState(session, { ...session.state, readOnly: true, presentation: undefined, presentationCancelling: false, focusResize: undefined })
}
function connectionFailed(session: Session, error = t('terminal.connection.disconnected'), retry = true) {
  disconnect(session)
  session.connectionError = error
  session.reconnect?.failed(retry)
}
function terminalVisibilityChanged() {
  for (const session of sessions.values()) {
    syncViewVisibility(session)
    if (document.hidden) {
      session.reconnect?.pause()
      // Keep healthy sockets alive. Pending authentication and handshakes are
      // restarted in the foreground instead of timing out behind the user.
      if (session.state.status !== 'connected') disconnect(session)
    } else if (session.host?.isConnected) {
      if (session.state.status === 'connected') {
        if (session.socket?.readyState === WebSocket.OPEN) session.reconnect?.connected()
        else connectionFailed(session)
      } else session.reconnect?.resume()
    }
  }
}
async function connect(session: Session, probe: boolean) {
  const revision = ++session.connectionRevision, context = apiContext()
  if (probe) {
    const controller = session.connectionProbe = new AbortController()
    try {
      // WebSocket errors hide an HTTP 401. Check the existing account/source
      // before retrying instead of repeatedly opening a rejected connection.
      const response = await apiFetch('/api/state', { signal: controller.signal }, context)
      if (session.connectionRevision !== revision) return
      if (response.status === 401) {
        connectionFailed(session, t('terminal.connection.expired'), false)
        return
      }
      if (!response.ok) throw new Error(t('terminal.connection.failed'))
      const state = await response.json() as { sources: Array<{ id: string }> }
      if (session.connectionRevision !== revision) return
      if (!state.sources.some(source => source.id === session.resource.sourceId)) {
        connectionFailed(session, t('terminal.connection.removed'), false); return
      }
    } catch {
      if (session.connectionRevision === revision) connectionFailed(session, t('terminal.connection.failed'))
      return
    } finally { if (session.connectionProbe === controller) session.connectionProbe = undefined }
  }
  if (session.connectionRevision !== revision || !session.host?.isConnected || document.hidden) return
  const url = apiUrl('/api/terminal', context)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [name, value] of Object.entries(session.resource)) url.searchParams.set(name, value)
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  session.socket = socket
  socket.onopen = () => {
    if (session.socket !== socket || !isCurrentApi(context)) { socket.close(); return }
    socket.send(JSON.stringify({ type: 'auth', token: context.token }))
  }
  socket.onmessage = event => {
    if (session.socket !== socket) return
    if (event.data instanceof ArrayBuffer) session.term.write(new Uint8Array(event.data))
    else {
      try {
        const message = JSON.parse(event.data)
        if (receiveDownload(socket, message, session.resource)) return
        if (receiveDirectory(socket, message) || receiveUrl(socket, message) || session.uploads.receive(message)) return
        if (message.type === 'reset') session.term.write('\x1bc')
        else if (message.type === 'pane-focus') setState(session, { ...session.state, focusedPaneId: typeof message.paneId === 'string' ? message.paneId : undefined })
        else if (message.type === 'presentation') {
          const revision = session.presentationRevision = (session.presentationRevision || 0) + 1
          const presentation = { maximized: message.maximized === true, owned: message.owned === true,
            ...(typeof message.token === 'string' && Number.isSafeInteger(message.lease) ? { token: message.token, lease: message.lease as number } : {}) }
          const update = () => {
            if (session.socket !== socket || session.presentationRevision !== revision) return
            if (!presentation.owned && session.state.presentation?.owned && session.focusResize) session.focusResize.suspended = true
            setState(session, { ...session.state, presentation, presentationCancelling: false })
            schedulePresentation(session)
          }
          if (presentation.maximized && !presentation.owned) update()
          else session.term.write('', update)
        }
        else if (message.type === 'status') {
          if (message.status === 'closed' || message.status === 'error') {
            connectionFailed(session, typeof message.error === 'string' ? message.error : undefined); return
          }
          if (message.status !== 'connected' && message.status !== 'connecting') return
          if (message.status === 'connected') session.reconnect?.connected()
          setState(session, { ...session.state, status: message.status, error: undefined,
            retryAttempt: message.status === 'connected' ? undefined : session.state.retryAttempt, readOnly: message.readOnly === true })
          syncViewVisibility(session)
          schedulePresentation(session)
        }
        else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
          session.term.resize(message.cols, message.rows)
          schedulePresentation(session)
        }
        else if (message.type === 'focus-resize') {
          const request = session.focusResize
          if (!request) return
          // A competing view's token can revoke our request, but a late ended
          // acknowledgement from an older request must not end the new one.
          const revoked = !message.owned && message.reason === 'superseded'
          if (message.token !== request.token && !revoked) return
          request.suspended = message.owned !== true
          setState(session, { ...session.state, focusResize: { owned: message.owned === true } })
          schedulePresentation(session)
        }
      } catch { /* Terminal bytes arrive as binary; malformed control frames are ignored. */ }
    }
  }
  socket.onerror = () => {
    if (session.socket === socket) connectionFailed(session, t('terminal.connection.failed'))
  }
  socket.onclose = event => {
    if (session.socket === socket) {
      connectionFailed(session, event.code === 1008 ? t('terminal.connection.expired') : undefined, event.code !== 1008)
      if (event.code === 1008) window.dispatchEvent(new Event('canvas:unauthorized'))
    }
  }
}
function availableSize(host: HTMLElement) {
  const box = terminalBox(host)
  return { width: box.contentWidth, height: box.contentHeight }
}
function terminalGeometry(session: Session): TerminalGeometry | undefined {
  const screen = session.term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) return
  const { width, height } = terminalBox(screen)
  if (width > 0 && height > 0) return { width, height }
}
/** A view is a scaled projection of the shared native window, not its size owner. */
function present(session: Session) {
  if (!session.host?.isConnected || !session.opened) return
  if (session.state.presentation?.maximized && (!session.state.presentation.owned || !session.magnified)) return
  const geometry = terminalGeometry(session)
  if (!geometry) return
  const available = availableSize(session.host)
  // xterm's scrollbar overlays the grid; it does not reserve a permanent gutter.
  const { width, height } = geometry
  if (session.state.status === 'connected') {
    for (const listener of session.geometryListeners) listener({ width, height })
  }
  const scale = session.magnified ? 1 : available.width / width
  if (!(scale > 0)) return
  Object.assign(session.surface.style, { width: `${width}px`, height: `${height}px`, transform: session.magnified ? 'none' : `scale(${scale})` })
}
function proposedSize(session: Session) {
  if (!session.host?.isConnected || !session.opened) return
  const available = availableSize(session.host)
  if (!session.rendered) return
  if (!(available.width > 0 && available.height > 0)) return
  return fitTerminalGrid(available, session.rendered)
}
function updateFocusSize(session: Session) {
  if (!session.magnified || session.focusResize?.suspended || session.state.status !== 'connected' || session.socket?.readyState !== WebSocket.OPEN) return
  const proposed = proposedSize(session)
  if (!proposed) return
  if (!session.focusResize) {
    session.focusResize = { token: uuid(), suspended: false, requested: proposed }
    claimFocus(session)
    session.socket.send(JSON.stringify({ type: 'focus-resize-begin', token: session.focusResize.token, ...proposed }))
    return
  }
  const request = session.focusResize
  if (proposed.cols === request.requested?.cols && proposed.rows === request.requested?.rows) return
  request.requested = proposed
  session.socket.send(JSON.stringify({ type: 'focus-resize-update', token: request.token, ...proposed }))
}
function endFocusSize(session: Session) {
  clearTimeout(session.resizeTimer); session.resizeTimer = undefined
  const request = session.focusResize
  if (!request) return
  session.focusResize = undefined
  if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'focus-resize-end', token: request.token }))
  setState(session, { ...session.state, focusResize: undefined })
}
function resize(session: Session) {
  if (session.magnified || session.state.status !== 'connected' || (session.state.presentation?.maximized && !session.state.presentation.owned)) return
  const proposed = proposedSize(session)
  if (!proposed || session.socket?.readyState !== WebSocket.OPEN) return
  claimFocus(session)
  const { cols, rows } = proposed
  if (cols !== session.term.cols || rows !== session.term.rows) {
    session.term.resize(cols, rows)
    session.socket.send(JSON.stringify({ type: 'resize', cols, rows }))
  }
  present(session)
  return terminalGeometry(session)
}
function claimFocus(session: Session) {
  if (!interactive(session)) return
  if (session.socket?.readyState !== WebSocket.OPEN || session.state.status !== 'connected' || (session.state.presentation?.maximized && !session.state.presentation.owned)) return
  session.socket.send(JSON.stringify({ type: 'focus' }))
  setState(session, { ...session.state, readOnly: false })
}
function sendTerminalKey(session: Session, key: string, modifiers: Partial<TerminalModifiers>) {
  return sendTerminalData(session, terminalKey(key, modifiers, session.term.modes.applicationCursorKeysMode))
}
function sendTerminalData(session: Session, data: string) {
  if (!interactive(session) || session.socket?.readyState !== WebSocket.OPEN || session.state.status !== 'connected' || (session.state.presentation?.maximized && !session.state.presentation.owned)) return false
  if (!data) return false
  setModifiers(session)
  claimFocus(session)
  session.term.input(data, true)
  return true
}
export function mountTerminal(host: HTMLElement, resource: Session['resource'], listener: (state: TerminalStatus) => void, onGeometry?: (geometry: TerminalGeometry) => void, options: { magnified?: boolean; mobile?: boolean } = {}) {
  installTerminalEvents()
  const id = key(resource.sourceId, resource.spaceId, resource.windowId)
  let session = sessions.get(id)
  if (!session) {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: fontPresentation.family,
      lineHeight: 1,
      scrollback: 5000,
      overviewRuler: { width: scrollbarWidth },
      allowProposedApi: true,
      theme: { overviewRulerBorder: 'transparent', background: '#111317', foreground: '#d5d7dd', cursor: '#e8b183', selectionBackground: '#415168', black: '#20242b', red: '#f08080', green: '#9ecb8f', yellow: '#e5c285', blue: '#8daed7', magenta: '#c7a0df', cyan: '#8fc5c4', white: '#d5d7dd', brightBlack: '#66707f', brightWhite: '#f6f6f7' },
    })
    term.loadAddon(terminalUnicodeAddon())
    const surface = document.createElement('div')
    surface.className = 'terminal-surface'
    Object.assign(surface.style, { transformOrigin: 'top left', width: '100%', height: '100%' })
    const uploads = new TerminalUploads({
      available: () => interactive(session!) && session!.state.status === 'connected' && !(session!.state.presentation?.maximized && !session!.state.presentation.owned),
      focus: () => { focusTerminal(session!) },
      send: message => {
        if (session!.socket?.readyState !== WebSocket.OPEN) return false
        session!.socket.send(JSON.stringify(message)); return true
      },
      changed: upload => setState(session!, { ...session!.state, upload }),
    })
    session = { term, surface, uploads, opened: false, magnified: false, mobile: !!options.mobile, connectionRevision: 0,
      modifiers: emptyModifiers(), touchMode: 'scroll', keyboardRequested: false,
      state: { status: 'connecting' }, listeners: new Set(), geometryListeners: new Set(), resource: { sourceId: resource.sourceId, spaceId: resource.spaceId, windowId: resource.windowId } }
    const current = session
    current.reconnect = new TerminalReconnect({
      active: () => !!current.host?.isConnected && !document.hidden,
      connect: probe => { void connect(current, probe) },
      waiting: attempt => setState(current, { ...current.state, status: 'connecting', error: undefined, retryAttempt: attempt || undefined }),
      failed: () => setState(current, { ...current.state, status: 'disconnected', error: current.connectionError, retryAttempt: undefined }),
      timeout: () => connectionFailed(current, t('terminal.connection.timeout')),
    })
    // Offscreen xterm buffers can resize before the DOM renderer catches up.
    // Keep each measured grid paired with the dimensions that actually painted it.
    term.onRender(() => {
      const grid = terminalGeometry(current)
      if (!grid) return
      const previous = current.rendered
      if (previous?.width === grid.width && previous.height === grid.height && previous.cols === term.cols && previous.rows === term.rows) return
      current.rendered = { ...grid, cols: term.cols, rows: term.rows }
      schedulePresentation(current)
    })
    function sendInput(data: string, binary = false) {
      // onData includes terminal query replies; passive viewers must never
      // claim control or send duplicate replies merely by rendering output.
      const socket = current.socket, context = apiContext()
      const writable = () => isCurrentApi(context) && current.socket === socket && socket?.readyState === WebSocket.OPEN &&
        !current.suppressInput && interactive(current) && !current.state.readOnly && current.state.status === 'connected' &&
        !(current.state.presentation?.maximized && !current.state.presentation.owned)
      if (!writable()) return
      if (current.mobile && !binary && data.length === 1 && hasModifiers(current.modifiers)) {
        data = modifiedText(data, current.modifiers)
        setModifiers(current)
      }
      for (const chunk of binary ? [data] : terminalInputChunks(data)) {
        if (!writable()) return
        socket!.send(JSON.stringify({ type: 'input', data: chunk, ...(binary ? { encoding: 'binary' } : {}) }))
      }
    }
    term.onData(data => sendInput(data))
    // Legacy mouse coordinates are bytes, not UTF-8 text. Encoding them as
    // Unicode changes bytes above 127 and leaves stray characters in the PTY.
    term.onBinary(data => sendInput(data, true))
    current.clipboard = new TerminalClipboard(term, surface, {
      visible: () => !!current.host?.isConnected && !(current.state.presentation?.maximized && (!current.state.presentation.owned || !current.magnified)),
      controlsInput: () => interactive(current) && current.state.status === 'connected' && !current.state.readOnly,
      copyError: clipboardError => setState(current, { ...current.state, clipboardError }),
    })
    current.keyHandler = event => {
      if (!interactive(current)) return false
      if (document.activeElement !== (current.mobile ? current.mobileInput?.element : current.term.textarea)) return true
      if (current.clipboard?.key(event) === false) { current.nativeKey = undefined; return false }
      if (event.isComposing || event.keyCode === 229 || ['Process', 'Dead', 'AltGraph'].includes(event.key) || event.getModifierState('AltGraph')) {
        current.nativeKey = undefined; setModifiers(current); return true
      }
      const id = event.code || event.key
      if (event.type === 'keyup' && current.nativeKey?.id === id) {
        current.nativeKey = undefined; event.preventDefault(); event.stopPropagation(); return false
      }
      if (event.type === 'keypress' && current.nativeKey) { event.preventDefault(); event.stopPropagation(); return false }
      if (event.type === 'keydown') {
        // A virtual latch is consumed once, but remains held for auto-repeat.
        // Physical modifiers are read afresh on every repeated keydown.
        const virtual = current.mobile && event.repeat && current.nativeKey?.id === id ? current.nativeKey.virtual : current.modifiers
        current.nativeKey = undefined
        const data = terminalShortcut(event, virtual, current.term.modes.applicationCursorKeysMode, navigator.platform)
        if (data && sendTerminalData(current, data)) {
          current.nativeKey = { id, virtual }
          event.preventDefault(); event.stopPropagation(); return false
        }
      }
      if (current.mobile && document.activeElement === current.mobileInput?.element && event.type === 'keydown' &&
        !event.isComposing && event.keyCode !== 229 &&
        (event.key.length !== 1 || !current.keyboardRequested && !event.ctrlKey && !event.altKey && !event.metaKey) &&
        sendTerminalKey(current, event.key, { shift: event.key.length !== 1 && event.shiftKey,
          ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey })) {
        event.preventDefault(); return false
      }
      if (event.type === 'keydown' && current.state.readOnly) claimFocus(current)
      return true
    }
    term.attachCustomKeyEventHandler(current.keyHandler)
    sessions.set(id, session)
  }
  // Vue may mount a replacement host before disposing the old component. Only
  // the current host owns its presentation and temporary size request.
  if (session.host !== host) endFocusSize(session)
  session.host = host
  session.viewVisible = true
  session.mobile = options.mobile === true
  session.magnified = options.magnified === true
  session.nativeKey = undefined
  session.term.options.disableStdin = !interactive(session)
  if (!interactive(session)) { session.keyboard?.blur(); session.keyboardRequested = false; session.term.blur() }
  setModifiers(session)
  host.appendChild(session.surface)
  if (!session.opened) {
    session.term.open(session.surface); session.opened = true
    session.removeFontFeatures = applyTerminalFontFeatures(session.term, contentFont)
    const current = session
    session.term.textarea?.addEventListener('focus', () => { if (!clipboardRestoringFocus()) claimFocus(current) })
    session.term.textarea?.addEventListener('paste', event => {
      if (!interactive(current)) { event.preventDefault(); event.stopImmediatePropagation(); return }
      current.nativeKey = undefined; setModifiers(current); claimFocus(current)
    }, { capture: true })
    session.term.textarea?.addEventListener('compositionstart', () => { current.nativeKey = undefined; setModifiers(current) })
    session.term.textarea?.addEventListener('blur', () => { current.nativeKey = undefined; setModifiers(current) })
    session.removeTouch = bindTerminalTouch(session.surface, session.term, {
      active: () => current.mobile && current.magnified && current.state.status === 'connected' && !current.state.readOnly,
      mode: () => current.touchMode,
      focus: () => focusTerminal(current),
      copyGesture: () => current.clipboard?.touchSelectionCompleted(),
      suppressInput: action => {
        const previous = current.suppressInput
        current.suppressInput = true
        try { action() } finally { current.suppressInput = previous }
      },
    })
  }
  if (!session.mobile && session.keyboard) {
    session.keyboard.dispose(); session.keyboard = undefined
    session.mobileInput?.dispose(); session.mobileInput = undefined
  }
  if (session.mobile && !session.keyboard && session.term.textarea && session.term.element) {
    const current = session
    const input = session.mobileInput = bindMobileInput(session.term.element, {
      active: () => current.mobile && interactive(current) && !!current.host?.isConnected,
      input: text => { claimFocus(current); current.term.input(text, true) },
      paste: text => { current.nativeKey = undefined; setModifiers(current); claimFocus(current); current.term.paste(text) },
      files: files => current.uploads.enqueue(files),
      key: event => { current.keyHandler?.(event) },
      special: key => { sendTerminalKey(current, key, current.modifiers) },
      composing: () => { current.nativeKey = undefined; setModifiers(current) },
      // xterm's public input stays the renderer's focus signal; actual IME
      // focus belongs to the rich input so Android can deliver image commits.
      focus: () => current.term.textarea?.dispatchEvent(new FocusEvent('focus')),
      blur: () => current.term.textarea?.dispatchEvent(new FocusEvent('blur')),
    })
    session.keyboard = bindMobileKeyboard(input.element, {
      active: () => current.mobile && current.magnified && !!current.host?.isConnected,
      changed: requested => { current.keyboardRequested = requested; setState(current, { ...current.state }) },
      setEditable: input.setEditable,
    })
  }
  if (session.term.textarea) {
    // xterm internally focuses its textarea on mouse presses. Disable that
    // mobile target so it cannot steal the rich editor's IME connection.
    session.term.textarea.disabled = session.mobile
    session.term.textarea.readOnly = !interactive(session) || session.mobile
    session.term.textarea.tabIndex = interactive(session) && !session.mobile ? 0 : -1
    session.term.textarea.inputMode = session.mobile ? 'none' : 'text'
    // Keep the hidden input large enough to avoid iOS focus zoom; xterm's
    // rendered font and native grid stay independent of this input element.
    session.term.textarea.style.fontSize = session.mobile ? '16px' : ''
    session.term.textarea.setAttribute('autocapitalize', 'off')
    session.term.textarea.setAttribute('autocorrect', 'off')
    session.term.textarea.spellcheck = false
  }
  session.keyboardLock?.dispose()
  const keyboardInput = session.mobile ? session.mobileInput?.element : session.term.textarea
  if (keyboardInput) session.keyboardLock = bindTerminalKeyboardLock(keyboardInput, () =>
    !!session.host?.isConnected && interactive(session) && session.state.status === 'connected' && !session.state.readOnly &&
    !(session.state.presentation?.maximized && !session.state.presentation.owned))
  session.listeners.add(listener)
  if (onGeometry) session.geometryListeners.add(onGeometry)
  listener(session.state)
  if (!session.socket || session.socket.readyState === WebSocket.CLOSED) session.reconnect?.resume()
  else if (session.state.status === 'connected') session.reconnect?.connected()
  const current = session
  const mountingContext = apiContext()
  const removeFileInput = bindFileInput(host, current.uploads, draggingFile => {
    if (current.host === host) setState(current, { ...current.state, draggingFile })
  })
  const observer = new ResizeObserver(() => { if (current.host === host) schedulePresentation(current) })
  observer.observe(host)
  const intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    if (current.host !== host) return
    const entry = entries.at(-1)
    if (!entry) return
    current.viewVisible = entry.isIntersecting
    syncViewVisibility(current)
  }, { rootMargin: '96px' }) : undefined
  intersection?.observe(host)
  syncViewVisibility(current)
  schedulePresentation(current)
  const canPasteText = () => isCurrentApi(mountingContext) && current.host === host && host.isConnected && interactive(current) && current.state.status === 'connected' && current.socket?.readyState === WebSocket.OPEN &&
    !(current.state.presentation?.maximized && (!current.state.presentation.owned || !current.magnified))
  return {
    focus(options: { keyboard?: boolean } = {}) { focusTerminal(current, options.keyboard) },
    blur() { if (current.mobile) current.keyboard?.blur(); else current.term.blur(); setModifiers(current) },
    setModifiers(modifiers: Partial<TerminalModifiers>) { setModifiers(current, modifiers) },
    sendKey(key: string, modifiers: Partial<TerminalModifiers> = current.modifiers) {
      sendTerminalKey(current, key, modifiers)
    },
    uploadFiles(files: File[]) { current.uploads.enqueue(files) },
    uploadReference(reference: CanvasFileReference) { return uploadReference(current, reference) },
    cancelMaximized() {
      const presentation = current.state.presentation
      if (!isCurrentApi(mountingContext) || !presentation?.maximized || presentation.lease === undefined || !presentation.token ||
          current.state.presentationCancelling || current.state.status !== 'connected' || current.socket?.readyState !== WebSocket.OPEN) return
      setState(current, { ...current.state, presentationCancelling: true })
      current.socket.send(JSON.stringify({ type: 'presentation-cancel', token: presentation.token, lease: presentation.lease }))
    },
    selectionText() { return current.term.getSelection() },
    viewportText() {
      const buffer = current.term.buffer.active, lines: string[] = []
      for (let row = buffer.viewportY; row < Math.min(buffer.length, buffer.viewportY + current.term.rows); row++) lines.push(buffer.getLine(row)?.translateToString(true) || '')
      return lines.join('\n').trimEnd()
    },
    copySelection(text = current.term.getSelection()) { return current.clipboard?.copyText(text) ?? false },
    canPasteText,
    pasteText(text: string) {
      if (!text || !canPasteText()) return false
      current.nativeKey = undefined; setModifiers(current); claimFocus(current); current.term.paste(text)
      return true
    },
    setTouchMode(mode: TerminalTouchMode) { current.touchMode = mode; setModifiers(current); setState(current, { ...current.state, touchMode: mode }) },
    resize() { return resize(current) },
    cancelUpload() { current.uploads.cancel() },
    reconnect() {
      disconnect(current)
      current.reconnect?.restart()
    },
    dispose() {
      removeFileInput()
      observer.disconnect()
      intersection?.disconnect()
      current.listeners.delete(listener)
      if (onGeometry) current.geometryListeners.delete(onGeometry)
      if (current.host === host) {
        endFocusSize(current)
        if (current.mobile) current.keyboard?.blur()
        current.host = undefined
        syncViewVisibility(current)
        current.keyboardLock?.dispose(); current.keyboardLock = undefined
        current.magnified = false
        current.keyboardRequested = false
        current.reconnect?.pause()
        if (current.state.status !== 'connected') disconnect(current)
      }
    },
  }
}
export function clearTerminals() {
  clearDownloads()
  clearDirectories()
  clearUrls()
  for (const session of sessions.values()) {
    session.fileRead?.abort(); session.fileRead = undefined
    session.uploads.clear()
    session.keyboardLock?.dispose()
    session.removeTouch?.()
    session.removeFontFeatures?.()
    session.keyboard?.dispose()
    session.mobileInput?.dispose()
    session.reconnect?.pause()
    disconnect(session)
    if (session.presentationFrame !== undefined) cancelAnimationFrame(session.presentationFrame)
    session.clipboard?.dispose()
    session.term.dispose()
  }
  sessions.clear()
  for (const event of mouseEvents) document.removeEventListener(event, normalizeMouseCoordinates, true)
  document.removeEventListener('dragover', preventFileNavigation)
  document.removeEventListener('drop', preventFileNavigation)
  window.removeEventListener('blur', releaseMouseOwner)
  document.removeEventListener('visibilitychange', terminalVisibilityChanged)
  terminalEventsInstalled = false
  mouseOwner = undefined
}
