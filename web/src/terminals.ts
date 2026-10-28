import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { uuid } from './api'

export type TerminalStatus = {
  status: 'connecting' | 'connected' | 'disconnected'
  error?: string
  readOnly?: boolean
  focusResize?: { active: boolean; owned: boolean; reason?: string }
}
export interface TerminalGeometry { width: number; height: number; cols: number; rows: number }
interface FocusResize { token: string; suspended: boolean; requested?: { cols: number; rows: number } }
interface Session {
  term: Terminal
  fit: FitAddon
  surface: HTMLDivElement
  host?: HTMLElement
  magnified: boolean
  focusResize?: FocusResize
  presentationFrame?: number
  socket?: WebSocket
  opened: boolean
  state: TerminalStatus
  listeners: Set<(state: TerminalStatus) => void>
  geometryListeners: Set<(geometry: TerminalGeometry) => void>
  resource: { sourceId: string; spaceId: string; windowId: string }
}
const sessions = new Map<string, Session>()
const scrollbarWidth = 6
let mouseOwner: Session | undefined
let mouseCoordinatesInstalled = false
const mouseEvents = ['mousedown', 'mousemove', 'mouseup', 'wheel'] as const
function normalizeMouseCoordinates(event: MouseEvent) {
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
  window.addEventListener('blur', releaseMouseOwner)
  mouseCoordinatesInstalled = true
}
const key = (sourceId: string, spaceId: string, windowId: string) => `${sourceId}\u0000${spaceId}\u0000${windowId}`
function setState(session: Session, state: TerminalStatus) {
  session.state = state
  session.listeners.forEach(listener => listener(state))
}
function schedulePresentation(session: Session) {
  if (session.presentationFrame !== undefined) return
  session.presentationFrame = requestAnimationFrame(() => {
    session.presentationFrame = undefined
    updateFocusSize(session)
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
        if (message.type === 'output') session.term.write(message.data)
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
    if (session.socket === socket) setState(session, { status: 'disconnected', error: session.state.error })
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
  const request = session.focusResize
  if (!request) return
  session.focusResize = undefined
  if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'focus-resize-end', token: request.token }))
  setState(session, { ...session.state, focusResize: undefined })
}
function resize(session: Session) {
  if (session.magnified || session.state.status !== 'connected') return
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
  if (session.socket?.readyState !== WebSocket.OPEN || session.state.status !== 'connected') return
  session.socket.send(JSON.stringify({ type: 'focus' }))
  setState(session, { ...session.state, readOnly: false })
}
export function mountTerminal(host: HTMLElement, resource: Session['resource'], listener: (state: TerminalStatus) => void, onGeometry?: (geometry: TerminalGeometry) => void, options: { magnified?: boolean } = {}) {
  installMouseCoordinates()
  const id = key(resource.sourceId, resource.spaceId, resource.windowId)
  let session = sessions.get(id)
  if (!session) {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      lineHeight: 1,
      scrollback: 5000,
      overviewRuler: { width: scrollbarWidth },
      allowProposedApi: false,
      theme: { background: '#111317', foreground: '#d5d7dd', cursor: '#e8b183', selectionBackground: '#415168', black: '#20242b', red: '#f08080', green: '#9ecb8f', yellow: '#e5c285', blue: '#8daed7', magenta: '#c7a0df', cyan: '#8fc5c4', white: '#d5d7dd', brightBlack: '#66707f', brightWhite: '#f6f6f7' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const surface = document.createElement('div')
    surface.className = 'terminal-surface'
    Object.assign(surface.style, { transformOrigin: 'top left', width: '100%', height: '100%' })
    session = { term, fit, surface, opened: false, magnified: false, state: { status: 'connecting' }, listeners: new Set(), geometryListeners: new Set(), resource: { sourceId: resource.sourceId, spaceId: resource.spaceId, windowId: resource.windowId } }
    const current = session
    function sendInput(data: string, binary = false) {
      // onData includes terminal query replies; passive viewers must never
      // claim control or send duplicate replies merely by rendering output.
      if (current.socket?.readyState !== WebSocket.OPEN || current.state.readOnly || current.state.status !== 'connected') return
      current.socket.send(JSON.stringify({ type: 'input', data, ...(binary ? { encoding: 'binary' } : {}) }))
    }
    term.onData(data => sendInput(data))
    // Legacy mouse coordinates are bytes, not UTF-8 text. Encoding them as
    // Unicode changes bytes above 127 and leaves stray characters in the PTY.
    term.onBinary(data => sendInput(data, true))
    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && current.state.readOnly) claimFocus(current)
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyC' && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection())
        return false
      }
      return true
    })
    sessions.set(id, session)
  }
  // Vue may mount a replacement host before disposing the old component. Only
  // the current host owns its presentation and temporary size request.
  if (session.host !== host) endFocusSize(session)
  session.host = host
  session.magnified = options.magnified === true
  host.appendChild(session.surface)
  if (!session.opened) {
    session.term.open(session.surface); session.opened = true
    const current = session
    session.term.textarea?.addEventListener('focus', () => claimFocus(current))
    session.term.textarea?.addEventListener('paste', () => claimFocus(current), { capture: true })
  }
  session.listeners.add(listener)
  if (onGeometry) session.geometryListeners.add(onGeometry)
  listener(session.state)
  if (!session.socket || session.socket.readyState === WebSocket.CLOSED) { session.term.reset(); connect(session) }
  const current = session
  const observer = new ResizeObserver(() => { if (current.host === host) schedulePresentation(current) })
  observer.observe(host)
  schedulePresentation(current)
  return {
    focus() { claimFocus(current); current.term.focus() },
    resize() { resize(current) },
    reconnect() {
      endFocusSize(current)
      current.socket?.close()
      current.socket = undefined
      current.term.reset()
      connect(current)
    },
    dispose() {
      observer.disconnect()
      current.listeners.delete(listener)
      if (onGeometry) current.geometryListeners.delete(onGeometry)
      if (current.host === host) {
        endFocusSize(current)
        current.host = undefined
        current.magnified = false
      }
    },
  }
}
export function clearTerminals() {
  for (const session of sessions.values()) {
    endFocusSize(session)
    if (session.presentationFrame !== undefined) cancelAnimationFrame(session.presentationFrame)
    session.socket?.close()
    session.term.dispose()
  }
  sessions.clear()
  for (const event of mouseEvents) document.removeEventListener(event, normalizeMouseCoordinates, true)
  window.removeEventListener('blur', releaseMouseOwner)
  mouseCoordinatesInstalled = false
  mouseOwner = undefined
}
