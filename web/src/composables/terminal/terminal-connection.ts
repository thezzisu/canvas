/**
 * A window's link to the server, as a session sees it: JSON either way, cell messages in.
 * Sessions hold nothing else of the transport, so several windows can later share one socket.
 */
export interface TerminalConnection {
  readonly open: boolean
  /** False when the link is not open; the message is dropped. */
  send(message: object): boolean
  /** Ends the link. Nothing is reported after it. */
  close(): void
}

interface ConnectionEvents {
  message(message: Record<string, unknown>): void
  cells(bytes: Uint8Array): void
  /** The link ended without `close`; `failed` when it never opened or broke with an error. */
  closed(failed: boolean): void
}

/** One socket for one window. The server expects the token as the first message. */
export function openTerminalConnection(
  url: URL,
  token: string,
  events: ConnectionEvents,
): TerminalConnection {
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  let live = true
  const ended = (failed: boolean) => {
    if (!live) return
    live = false
    socket.close()
    events.closed(failed)
  }
  socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token }))
  socket.onmessage = (event) => {
    if (!live) return
    if (event.data instanceof ArrayBuffer) {
      events.cells(new Uint8Array(event.data))
      return
    }
    let message: unknown
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message && typeof message === 'object') events.message(message as Record<string, unknown>)
  }
  socket.onerror = () => ended(true)
  socket.onclose = () => ended(false)
  return {
    get open() {
      return live && socket.readyState === WebSocket.OPEN
    },
    send(message) {
      if (!live || socket.readyState !== WebSocket.OPEN) return false
      socket.send(JSON.stringify(message))
      return true
    },
    close() {
      live = false
      socket.close()
    },
  }
}
