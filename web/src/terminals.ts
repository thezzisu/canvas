import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { uuid } from './api'
import { clearDownloads, disconnectDownloads, receiveDownload } from './downloads'
import { clearDirectories, receiveDirectory } from './directories'
import { bindFileInput, preventFileNavigation, TerminalUploads, type TerminalUploadState } from './uploads'
import { clipboardRestoringFocus, TerminalClipboard } from './clipboard'
import { emptyModifiers, hasModifiers, modifiedText, terminalKey, type TerminalModifiers } from './terminal-input'
import { bindTerminalTouch, type TerminalTouchMode } from './terminal-touch'
import { defaultContentFont, type ContentFontSettings } from '../../shared/settings'
import { applyTerminalFontFeatures, type FontPresentation } from './fonts'

export type TerminalStatus = {
  status: 'connecting' | 'connected' | 'disconnected'
  error?: string
  readOnly?: boolean
  presentation?: { maximized: boolean; owned: boolean }
  focusResize?: { active: boolean; owned: boolean; reason?: string }
  upload?: TerminalUploadState
  draggingFile?: boolean
  clipboardError?: string
  modifiers?: TerminalModifiers
  touchMode?: TerminalTouchMode
  keyboardRequested?: boolean
}
export interface TerminalGeometry { width: number; height: number; cols: number; rows: number }
interface FocusResize { token: string; suspended: boolean; requested?: { cols: number; rows: number } }
interface Session {
  term: Terminal
  fit: FitAddon
  surface: HTMLDivElement
  host?: HTMLElement
  magnified: boolean
  mobile: boolean
  modifiers: TerminalModifiers
  touchMode: TerminalTouchMode
  keyboardRequested: boolean
  suppressInput?: boolean
  nativeKey?: { id: string; key: string; modifiers: Partial<TerminalModifiers> }
  removeFontFeatures?: () => void
  resizeTimer?: ReturnType<typeof setTimeout>
  removeTouch?: () => void
  focusResize?: FocusResize
  presentationFrame?: number
  presentationRevision?: number
  socket?: WebSocket
  opened: boolean
  state: TerminalStatus
  listeners: Set<(state: TerminalStatus) => void>
  geometryListeners: Set<(geometry: TerminalGeometry) => void>
  resource: { sourceId: string; spaceId: string; windowId: string }
  uploads: TerminalUploads
  clipboard?: TerminalClipboard
}
const sessions = new Map<string, Session>()
let contentFont = defaultContentFont()
// The authenticated app loads bundled fonts before applying this presentation.
let fontPresentation: FontPresentation = { family: 'monospace', features: '"calt" 0, "liga" 0, "dlig" 0' }
export function setContentFont(settings: ContentFontSettings, presentation: FontPresentation) {
  contentFont = { ...settings, stack: settings.stack.map(font => ({ ...font })) }
  fontPresentation = presentation
  for (const session of sessions.values()) {
    session.term.options.fontFamily = presentation.family
    if (session.opened) session.removeFontFeatures = applyTerminalFontFeatures(session.term, contentFont)
    // Fonts alter cell metrics, not the shared native grid. Only an existing
    // magnified owner may update its temporary geometry through the usual lease.
    schedulePresentation(session)
  }
}
const scrollbarWidth = 6
let mouseOwner: Session | undefined
let mouseCoordinatesInstalled = false
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
function installMouseCoordinates() {
  if (mouseCoordinatesInstalled) return
  for (const event of mouseEvents) document.addEventListener(event, normalizeMouseCoordinates, true)
  document.addEventListener('dragover', preventFileNavigation)
  document.addEventListener('drop', preventFileNavigation)
  window.addEventListener('blur', releaseMouseOwner)
  mouseCoordinatesInstalled = true
}
const key = (sourceId: string, spaceId: string, windowId: string) => `${sourceId}\u0000${spaceId}\u0000${windowId}`
function setState(session: Session, state: TerminalStatus) {
  const next = session.state = { ...state, modifiers: session.modifiers, touchMode: session.touchMode,
    keyboardRequested: session.keyboardRequested }
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
  if (session.mobile && keyboard !== undefined) session.keyboardRequested = keyboard
  if (session.term.textarea) session.term.textarea.inputMode = session.mobile && !session.keyboardRequested ? 'none' : 'text'
  session.term.focus()
  setState(session, { ...session.state, keyboardRequested: session.keyboardRequested })
}
function schedulePresentation(session: Session) {
  if (session.presentationFrame !== undefined) return
  session.presentationFrame = requestAnimationFrame(() => {
    session.presentationFrame = undefined
    if (session.mobile && session.magnified && session.focusResize) {
      clearTimeout(session.resizeTimer)
      session.resizeTimer = setTimeout(() => { session.resizeTimer = undefined; updateFocusSize(session) }, 80)
    } else updateFocusSize(session)
    present(session)
  })
}
function connect(session: Session) {
  const url = new URL('/api/terminal', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [name, value] of Object.entries(session.resource)) url.searchParams.set(name, value)
  setState(session, { status: 'connecting' })
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  session.socket = socket
  socket.onopen = () => {
    if (session.socket !== socket) return
    setState(session, { status: 'connecting' })
  }
  socket.onmessage = event => {
    if (session.socket !== socket) return
    if (event.data instanceof ArrayBuffer) session.term.write(new Uint8Array(event.data))
    else {
      try {
        const message = JSON.parse(event.data)
        if (receiveDownload(socket, message, session.resource)) return
        if (receiveDirectory(socket, message) || session.uploads.receive(message)) return
        if (message.type === 'reset') session.term.write('\x1bc')
        else if (message.type === 'presentation') {
          const revision = session.presentationRevision = (session.presentationRevision || 0) + 1
          const presentation = { maximized: message.maximized === true, owned: message.owned === true }
          const update = () => {
            if (session.socket !== socket || session.presentationRevision !== revision) return
            setState(session, { ...session.state, presentation })
            schedulePresentation(session)
          }
          if (presentation.maximized && !presentation.owned) update()
          else session.term.write('', update)
        }
        else if (message.type === 'output') session.term.write(message.data)
        else if (message.type === 'status') {
          setState(session, { ...session.state, status: message.status === 'closed' || message.status === 'error' ? 'disconnected' : message.status, error: message.error, readOnly: message.readOnly })
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
          const revoked = !message.owned && ['external-resize', 'superseded', 'unavailable'].includes(message.reason)
          if (message.token !== request.token && !revoked) return
          request.suspended = message.owned !== true
          setState(session, { ...session.state, focusResize: { active: message.active === true, owned: message.owned === true, reason: message.reason } })
          schedulePresentation(session)
        }
        else if (message.type === 'error') setState(session, { status: 'disconnected', error: message.error || message.message })
        else if (message.type === 'exit') setState(session, { status: 'disconnected', error: message.message || '终端连接已结束' })
      } catch { session.term.write(event.data) }
    }
  }
  socket.onerror = () => {
    if (session.socket === socket) setState(session, { status: 'disconnected', error: '终端连接失败' })
  }
  socket.onclose = () => {
    disconnectDownloads(socket)
    if (session.socket === socket) {
      session.uploads.disconnected()
      setState(session, { ...session.state, status: 'disconnected', error: session.state.error })
    }
  }
}
function availableSize(host: HTMLElement) {
  const style = getComputedStyle(host)
  return {
    width: host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    height: host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
  }
}
/** A view is a scaled projection of the shared native window, not its size owner. */
function present(session: Session) {
  if (!session.host?.isConnected || !session.opened) return
  if (session.state.presentation?.maximized && (!session.state.presentation.owned || !session.magnified)) return
  const screen = session.term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen?.offsetWidth || !screen.offsetHeight) return
  const available = availableSize(session.host)
  // The viewport's scrollbar belongs beside the terminal cells. Keep its space
  // even when hidden so output/scrollback never alters the native geometry.
  const width = screen.offsetWidth + scrollbarWidth, height = screen.offsetHeight
  if (session.state.status === 'connected') {
    for (const listener of session.geometryListeners) listener({ width, height, cols: session.term.cols, rows: session.term.rows })
  }
  const scale = session.magnified ? 1 : Math.min(available.width / width, available.height / height)
  if (!(scale > 0)) return
  Object.assign(session.surface.style, { width: `${width}px`, height: `${height}px`, transform: session.magnified ? 'none' : `scale(${scale})` })
}
function proposedSize(session: Session) {
  if (!session.host?.isConnected || !session.opened) return
  const available = availableSize(session.host)
  if (session.magnified) {
    // The previous grid may overflow while the viewport is shrinking. Its
    // temporary scrollbars must not make us request an unnecessarily small
    // grid, then grow it again after the scrollbars disappear.
    const style = getComputedStyle(session.host)
    available.width = session.host.offsetWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    available.height = session.host.offsetHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  }
  if (!(available.width > 0 && available.height > 0)) return
  Object.assign(session.surface.style, { width: `${available.width}px`, height: `${available.height}px`, transform: 'none' })
  const proposed = session.fit.proposeDimensions()
  if (proposed && Number.isFinite(proposed.cols) && Number.isFinite(proposed.rows)) return {
    cols: Math.max(20, Math.min(500, proposed.cols)),
    rows: Math.max(5, Math.min(200, proposed.rows)),
  }
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
  if (proposed && session.socket?.readyState === WebSocket.OPEN) {
    claimFocus(session)
    const { cols, rows } = proposed
    if (cols !== session.term.cols || rows !== session.term.rows) {
      session.term.resize(cols, rows)
      session.socket.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }
  present(session)
}
function claimFocus(session: Session) {
  if (!interactive(session)) return
  if (session.socket?.readyState !== WebSocket.OPEN || session.state.status !== 'connected' || (session.state.presentation?.maximized && !session.state.presentation.owned)) return
  session.socket.send(JSON.stringify({ type: 'focus' }))
  setState(session, { ...session.state, readOnly: false })
}
function sendTerminalKey(session: Session, key: string, modifiers: Partial<TerminalModifiers>) {
  if (!interactive(session) || session.socket?.readyState !== WebSocket.OPEN || session.state.status !== 'connected' || (session.state.presentation?.maximized && !session.state.presentation.owned)) return false
  const data = terminalKey(key, modifiers, session.term.modes.applicationCursorKeysMode)
  if (!data) return false
  setModifiers(session)
  claimFocus(session)
  session.term.input(data, true)
  return true
}
export function mountTerminal(host: HTMLElement, resource: Session['resource'], listener: (state: TerminalStatus) => void, onGeometry?: (geometry: TerminalGeometry) => void, options: { magnified?: boolean; mobile?: boolean } = {}) {
  installMouseCoordinates()
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
      theme: { background: '#111317', foreground: '#d5d7dd', cursor: '#e8b183', selectionBackground: '#415168', black: '#20242b', red: '#f08080', green: '#9ecb8f', yellow: '#e5c285', blue: '#8daed7', magenta: '#c7a0df', cyan: '#8fc5c4', white: '#d5d7dd', brightBlack: '#66707f', brightWhite: '#f6f6f7' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
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
    session = { term, fit, surface, uploads, opened: false, magnified: false, mobile: !!options.mobile,
      modifiers: emptyModifiers(), touchMode: 'scroll', keyboardRequested: false,
      state: { status: 'connecting' }, listeners: new Set(), geometryListeners: new Set(), resource: { sourceId: resource.sourceId, spaceId: resource.spaceId, windowId: resource.windowId } }
    const current = session
    function sendInput(data: string, binary = false) {
      // onData includes terminal query replies; passive viewers must never
      // claim control or send duplicate replies merely by rendering output.
      if (current.suppressInput || !interactive(current) || current.socket?.readyState !== WebSocket.OPEN || current.state.readOnly || current.state.status !== 'connected' || (current.state.presentation?.maximized && !current.state.presentation.owned)) return
      if (current.mobile && !binary && data.length === 1 && hasModifiers(current.modifiers)) {
        data = modifiedText(data, current.modifiers)
        setModifiers(current)
      }
      current.socket.send(JSON.stringify({ type: 'input', data, ...(binary ? { encoding: 'binary' } : {}) }))
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
    term.attachCustomKeyEventHandler(event => {
      if (!interactive(current)) return false
      if (current.clipboard?.key(event) === false) return false
      if (current.mobile) {
        const id = event.code || event.key
        if (event.type === 'keyup' && current.nativeKey?.id === id) current.nativeKey = undefined
        if (event.isComposing || event.keyCode === 229 || ['Dead', 'AltGraph'].includes(event.key) || event.getModifierState('AltGraph')) {
          current.nativeKey = undefined
          setModifiers(current)
          return true
        }
        if (event.type === 'keypress' && current.nativeKey) { event.preventDefault(); return false }
        if (event.type === 'keydown') {
          const repeat = event.repeat && current.nativeKey?.id === id ? current.nativeKey : undefined
          if (!repeat) current.nativeKey = undefined
          if (repeat || hasModifiers(current.modifiers)) {
            // Printable DOM keys already include physical Shift/Caps/layout.
            // Apply only an additional virtual Shift, never physical Shift twice.
            const modifiers = repeat?.modifiers || {
              shift: event.key.length === 1 ? current.modifiers.shift && !event.shiftKey : current.modifiers.shift || event.shiftKey,
              ctrl: current.modifiers.ctrl || event.ctrlKey,
              alt: current.modifiers.alt || event.altKey,
              meta: current.modifiers.meta || event.metaKey,
            }
            const key = repeat?.key || event.key
            if (sendTerminalKey(current, key, modifiers)) {
              current.nativeKey = { id, key, modifiers }
              event.preventDefault()
              return false
            }
          }
        }
      }
      if (event.type === 'keydown' && current.state.readOnly) claimFocus(current)
      return true
    })
    sessions.set(id, session)
  }
  // Vue may mount a replacement host before disposing the old component. Only
  // the current host owns its presentation and temporary size request.
  if (session.host !== host) endFocusSize(session)
  session.host = host
  session.mobile = options.mobile === true
  session.magnified = options.magnified === true
  session.nativeKey = undefined
  session.term.options.disableStdin = !interactive(session)
  if (!interactive(session)) { session.keyboardRequested = false; session.term.blur() }
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
  if (session.term.textarea) {
    session.term.textarea.readOnly = !interactive(session)
    session.term.textarea.tabIndex = interactive(session) ? 0 : -1
    session.term.textarea.inputMode = session.mobile && !session.keyboardRequested ? 'none' : 'text'
    // Keep the hidden input large enough to avoid iOS focus zoom; xterm's
    // rendered font and native grid stay independent of this input element.
    session.term.textarea.style.fontSize = session.mobile ? '16px' : ''
    session.term.textarea.setAttribute('autocapitalize', 'off')
    session.term.textarea.setAttribute('autocorrect', 'off')
    session.term.textarea.spellcheck = false
  }
  session.listeners.add(listener)
  if (onGeometry) session.geometryListeners.add(onGeometry)
  listener(session.state)
  if (!session.socket || session.socket.readyState === WebSocket.CLOSED) { session.term.reset(); connect(session) }
  const current = session
  const removeFileInput = bindFileInput(host, current.uploads, draggingFile => {
    if (current.host === host) setState(current, { ...current.state, draggingFile })
  })
  const observer = new ResizeObserver(() => { if (current.host === host) schedulePresentation(current) })
  observer.observe(host)
  schedulePresentation(current)
  return {
    focus(options: { keyboard?: boolean } = {}) { focusTerminal(current, options.keyboard) },
    blur() { current.keyboardRequested = false; current.term.blur(); setModifiers(current); setState(current, { ...current.state, keyboardRequested: false }) },
    setModifiers(modifiers: Partial<TerminalModifiers>) { setModifiers(current, modifiers) },
    sendKey(key: string, modifiers: Partial<TerminalModifiers> = current.modifiers) {
      sendTerminalKey(current, key, modifiers)
    },
    uploadFiles(files: File[]) { current.uploads.enqueue(files) },
    selectionText() { return current.term.getSelection() },
    viewportText() {
      const buffer = current.term.buffer.active, lines: string[] = []
      for (let row = buffer.viewportY; row < Math.min(buffer.length, buffer.viewportY + current.term.rows); row++) lines.push(buffer.getLine(row)?.translateToString(true) || '')
      return lines.join('\n').trimEnd()
    },
    copySelection(text = current.term.getSelection()) { return current.clipboard?.copyText(text) ?? false },
    pasteText(text: string) { if (interactive(current)) { setModifiers(current); claimFocus(current); current.term.paste(text) } },
    setTouchMode(mode: TerminalTouchMode) { current.touchMode = mode; setModifiers(current); setState(current, { ...current.state, touchMode: mode }) },
    resize() { resize(current) },
    cancelUpload() { current.uploads.cancel() },
    reconnect() {
      endFocusSize(current)
      current.uploads.disconnected()
      current.socket?.close()
      current.socket = undefined
      current.term.reset()
      connect(current)
    },
    dispose() {
      removeFileInput()
      observer.disconnect()
      current.listeners.delete(listener)
      if (onGeometry) current.geometryListeners.delete(onGeometry)
      if (current.host === host) {
        endFocusSize(current)
        current.host = undefined
        current.magnified = false
        current.keyboardRequested = false
        if (current.mobile) current.term.blur()
      }
    },
  }
}
export function clearTerminals() {
  clearDownloads()
  clearDirectories()
  for (const session of sessions.values()) {
    session.uploads.clear()
    session.removeTouch?.()
    session.removeFontFeatures?.()
    endFocusSize(session)
    if (session.presentationFrame !== undefined) cancelAnimationFrame(session.presentationFrame)
    const socket = session.socket
    session.socket = undefined
    socket?.close()
    session.clipboard?.dispose()
    session.term.dispose()
  }
  sessions.clear()
  for (const event of mouseEvents) document.removeEventListener(event, normalizeMouseCoordinates, true)
  document.removeEventListener('dragover', preventFileNavigation)
  document.removeEventListener('drop', preventFileNavigation)
  window.removeEventListener('blur', releaseMouseOwner)
  mouseCoordinatesInstalled = false
  mouseOwner = undefined
}
