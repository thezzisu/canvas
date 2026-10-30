import type { WebSocket, RawData } from 'ws'

/** No terminal is attached until the first application frame authenticates. */
export function authenticateWebSocket(socket: WebSocket, valid: (token: string) => boolean,
  accepted: (token: string) => void, timeoutMs = 5000) {
  const timer = setTimeout(() => { cleanup(); socket.close(1008, 'Authentication required') }, timeoutMs)
  timer.unref()
  const cleanup = () => { clearTimeout(timer); socket.off('message', first); socket.off('close', cleanup) }
  const first = (bytes: RawData, binary: boolean) => {
    cleanup()
    if (socket.readyState !== 1) return
    let token = ''
    try {
      if (binary || Buffer.byteLength(bytes.toString()) > 1024) throw new Error()
      const message = JSON.parse(bytes.toString())
      if (!message || message.type !== 'auth' || Object.keys(message).length !== 2
          || typeof message.token !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(message.token)) throw new Error()
      token = message.token
    } catch { socket.close(1008, 'Authentication required'); return }
    if (!valid(token)) { socket.close(1008, 'Session expired'); return }
    accepted(token)
  }
  socket.once('message', first)
  socket.once('close', cleanup)
  socket.on('error', () => socket.close())
}
