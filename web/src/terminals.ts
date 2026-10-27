import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

export type TerminalStatus = { status: 'connecting' | 'connected' | 'disconnected'; error?: string; readOnly?: boolean }
interface Session {
  term: Terminal
  fit: FitAddon
  socket?: WebSocket
  opened: boolean
  state: TerminalStatus
  listeners: Set<(state: TerminalStatus) => void>
  lastSize: string
  resource: { sourceId: string; spaceId: string; windowId: string }
}
const sessions = new Map<string, Session>()
const key = (sourceId: string, spaceId: string, windowId: string) => `${sourceId}\u0000${spaceId}\u0000${windowId}`
function setState(session: Session, state: TerminalStatus) {
  session.state = state
  session.listeners.forEach(listener => listener(state))
}
function connect(session: Session) {
  const url = new URL('/api/terminal', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [name, value] of Object.entries(session.resource)) url.searchParams.set(name, value)
  setState(session, { status: 'connecting' })
  session.lastSize = ''
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
          setState(session, { status: message.status === 'closed' || message.status === 'error' ? 'disconnected' : message.status, error: message.error, readOnly: message.readOnly })
          if (message.status === 'connected' && !message.readOnly) { session.lastSize = ''; resize(session) }
        }
        else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
          session.term.resize(message.cols, message.rows)
          session.lastSize = `${message.cols}x${message.rows}`
        }
        else if (message.type === 'error') setState(session, { status: 'disconnected', error: message.error || message.message })
        else if (message.type === 'exit') setState(session, { status: 'disconnected', error: message.message || '终端连接已结束' })
      } catch { session.term.write(event.data) }
    }
  }
  socket.onerror = () => setState(session, { status: 'disconnected', error: '终端连接失败，请重连或检查连接配置' })
  socket.onclose = () => {
    if (session.socket === socket) setState(session, { status: 'disconnected', error: session.state.error })
  }
}
function resize(session: Session) {
  if (!session.opened || session.state.readOnly || session.state.status !== 'connected') return
  try { session.fit.fit() } catch { return }
  const { cols, rows } = session.term
  const size = `${cols}x${rows}`
  if (cols > 1 && rows > 1 && size !== session.lastSize && session.socket?.readyState === WebSocket.OPEN) {
    session.socket.send(JSON.stringify({ type: 'resize', cols, rows }))
    session.lastSize = size
  }
}
function claimFocus(session: Session) {
  if (session.socket?.readyState !== WebSocket.OPEN || session.state.status !== 'connected') return
  session.socket.send(JSON.stringify({ type: 'focus' }))
  setState(session, { ...session.state, readOnly: false })
  session.lastSize = ''
  resize(session)
}
export function mountTerminal(host: HTMLElement, resource: Session['resource'], listener: (state: TerminalStatus) => void) {
  const id = key(resource.sourceId, resource.spaceId, resource.windowId)
  let session = sessions.get(id)
  if (!session) {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      lineHeight: 1.16,
      scrollback: 5000,
      allowProposedApi: false,
      theme: { background: '#111317', foreground: '#d5d7dd', cursor: '#e8b183', selectionBackground: '#415168', black: '#20242b', red: '#f08080', green: '#9ecb8f', yellow: '#e5c285', blue: '#8daed7', magenta: '#c7a0df', cyan: '#8fc5c4', white: '#d5d7dd', brightBlack: '#66707f', brightWhite: '#f6f6f7' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    session = { term, fit, opened: false, state: { status: 'connecting' }, listeners: new Set(), lastSize: '', resource }
    const current = session
    function sendInput(data: string) {
      // onData includes terminal query replies; passive viewers must never
      // claim control or send duplicate replies merely by rendering output.
      if (current.socket?.readyState !== WebSocket.OPEN || current.state.readOnly || current.state.status !== 'connected') return
      current.socket.send(JSON.stringify({ type: 'input', data }))
    }
    term.onData(sendInput)
    term.onBinary(sendInput)
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
  if (!session.opened) {
    session.term.open(host); session.opened = true
    const current = session
    session.term.textarea?.addEventListener('focus', () => claimFocus(current))
    session.term.textarea?.addEventListener('paste', () => claimFocus(current), { capture: true })
  }
  else if (session.term.element) host.appendChild(session.term.element)
  session.listeners.add(listener)
  listener(session.state)
  if (!session.socket || session.socket.readyState === WebSocket.CLOSED) { session.term.reset(); connect(session) }
  const current = session
  const observer = new ResizeObserver(() => resize(current))
  observer.observe(host)
  requestAnimationFrame(() => resize(current))
  return {
    focus() { claimFocus(current); current.term.focus() },
    reconnect() {
      current.socket?.close()
      current.socket = undefined
      current.term.reset()
      connect(current)
    },
    dispose() { observer.disconnect(); current.listeners.delete(listener) },
  }
}
export function clearTerminals() {
  for (const session of sessions.values()) { session.socket?.close(); session.term.dispose() }
  sessions.clear()
}
