// The terminal socket: one per browser tab, carrying a channel for each window it shows.
//
// The first message authenticates the socket (websocket-auth.ts). After that:
//   browser to server   { type: 'open', channel, sourceId, spaceId, windowId }
//                       { type: 'close', channel }
//                       { channel, ...message }, a window message (terminals.ts)
//   server to browser   { channel, ...message }
//                       { type: 'close', channel }, the server ended the channel
//                       binary: the channel as an unsigned LEB128 integer, then a cell message
//
// The browser picks the channel number, a non-negative integer it has not used on this socket.
// A channel is what a window's own socket would be: it opens with `status`, and its end, from
// either side, means what that socket closing would. Channels share nothing but the order of
// the bytes. Each window keeps at most one cell message in flight (terminals.ts), so what is
// queued on the socket is at most one cell message per channel, and a window that redraws
// without pause waits its turn behind the others' messages instead of ahead of them.
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import type { TerminalTarget } from './terminals.ts'

/** No tab shows more windows at once than the server keeps open. */
const MAX_CHANNELS = 128
const MAX_CHANNEL = 0x7fffffff

/** `readyState` is 1 while open and 3 after, as a socket's; `message` and `close` are emitted. */
export class TerminalChannel extends EventEmitter<{
  message: [message: Record<string, unknown>]
  close: []
}> {
  readyState: 1 | 3 = 1
  private readonly prefix: Uint8Array
  constructor(
    private readonly socket: WebSocket,
    readonly id: number,
  ) {
    super()
    const prefix: number[] = []
    for (let rest = id; ; rest >>>= 7) {
      prefix.push(rest > 0x7f ? (rest & 0x7f) | 0x80 : rest)
      if (rest <= 0x7f) break
    }
    this.prefix = Uint8Array.from(prefix)
  }
  /** `sent` runs once a cell message has left for the network. */
  send(message: object | Uint8Array, sent?: () => void) {
    if (this.readyState !== 1 || this.socket.readyState !== 1) return
    if (!(message instanceof Uint8Array)) {
      this.socket.send(JSON.stringify({ ...message, channel: this.id }))
      return
    }
    const bytes = new Uint8Array(this.prefix.length + message.length)
    bytes.set(this.prefix)
    bytes.set(message, this.prefix.length)
    this.socket.send(bytes, sent)
  }
  close() {
    if (this.readyState !== 1) return
    if (this.socket.readyState === 1)
      this.socket.send(JSON.stringify({ type: 'close', channel: this.id }))
    this.ended()
  }
  /** The browser, or the socket, ended it. */
  ended() {
    if (this.readyState !== 1) return
    this.readyState = 3
    this.emit('close')
  }
}

/** Runs the channels of an authenticated socket; `open` attaches a window to a new one. */
export function serveTerminalChannels(
  socket: WebSocket,
  open: (channel: TerminalChannel, target: TerminalTarget) => void,
) {
  const channels = new Map<number, TerminalChannel>()
  socket.on('message', (bytes, binary) => {
    if (binary) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(bytes.toString())
    } catch {
      return
    }
    const id = message?.channel
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id > MAX_CHANNEL) return
    const channel = channels.get(id)
    if (message.type === 'close') channel?.ended()
    else if (message.type !== 'open') channel?.emit('message', message)
    else if (!channel && channels.size < MAX_CHANNELS) {
      const { sourceId, spaceId, windowId } = message
      const opened = new TerminalChannel(socket, id)
      if (
        typeof sourceId !== 'string' ||
        typeof spaceId !== 'string' ||
        typeof windowId !== 'string' ||
        !sourceId ||
        !spaceId ||
        !windowId
      ) {
        opened.close()
        return
      }
      channels.set(id, opened)
      opened.once('close', () => channels.delete(id))
      open(opened, { sourceId, spaceId, windowId })
    }
  })
  socket.once('close', () => {
    for (const channel of [...channels.values()]) channel.ended()
  })
}
