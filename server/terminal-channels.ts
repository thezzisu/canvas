// The terminal socket: one per browser tab, carrying a channel for each window it shows.
//
// The first message authenticates the socket (websocket-auth.ts). After that:
//   browser to server   { type: 'open', channel, view, attempt, sourceId, spaceId, windowId }
//                       { type: 'close', channel }
//                       { channel, seq, ...message }, a window message (terminals.ts)
//   server to browser   { channel, ack, ...message }
//                       { type: 'ack', channel, ack, at }, when nothing else carried it in time
//                       { type: 'close', channel, ack }, the server ended the channel
//                       binary: the channel and the ack as unsigned LEB128 integers, then a
//                       cell message
//
// The browser picks the channel number, a non-negative integer it has not used on this socket.
// A channel is what a window's own socket would be: it opens with `status`, and its end, from
// either side, means what that socket closing would. Channels share nothing but the order of
// the bytes. Each window keeps at most one cell message in flight (terminals.ts), so what is
// queued on the socket is at most one cell message per channel, and a window that redraws
// without pause waits its turn behind the others' messages instead of ahead of them.
//
// Delivery:
// - A `view` is one page's view of a window, over any number of channels; `attempt` counts them.
//   `seq` numbers the view's messages and goes on across its channels.
// - A message is taken when it arrives, whether it is then applied or refused, so a program
//   that is slow to answer never reads as a link that lost the message. One that is not newer
//   than the last taken is dropped.
// - `ack` is the last taken, so it is cumulative. It rides on whatever the channel sends next,
//   or goes alone after ACK_DELAY_MS. An ack is never acknowledged. `at` is the server's clock.
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { serverTime } from './server-time.ts'
import type { TerminalTarget } from './terminals.ts'

/** No tab shows more windows at once than the server keeps open. */
const MAX_CHANNELS = 128
const MAX_CHANNEL = 0x7fffffff
/** How long an ack waits for a message to ride on. */
export const ACK_DELAY_MS = 100
const VIEW = /^[A-Za-z0-9_-]{8,64}$/u

/** An unsigned LEB128 integer. */
function pushInteger(bytes: number[], value: number) {
  let rest = value
  while (rest > 0x7f) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
}

/** `readyState` is 1 while open and 3 after, as a socket's; `message` and `close` are emitted. */
export class TerminalChannel extends EventEmitter<{
  message: [message: Record<string, unknown>]
  close: []
}> {
  readyState: 1 | 3 = 1
  /** The view's last message taken; it is cumulative. */
  taken = 0
  private owedAck?: ReturnType<typeof setTimeout>
  constructor(
    private readonly socket: WebSocket,
    readonly id: number,
    /** The page's view this channel carries, and which of its channels this is. */
    readonly view: string,
    readonly attempt: number,
  ) {
    super()
  }
  /** Takes a numbered message; false for one that was taken before or has no number. */
  take(seq: unknown): boolean {
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return false
    this.owedAck ??= setTimeout(
      () => this.send({ type: 'ack', at: serverTime() }),
      ACK_DELAY_MS,
    ).unref()
    if (seq <= this.taken) return false
    this.taken = seq
    return true
  }
  /** `sent` runs once the message has left for the network. */
  send(message: object | Uint8Array, sent?: () => void) {
    this.settleAck()
    if (this.readyState !== 1 || this.socket.readyState !== 1) return
    if (!(message instanceof Uint8Array)) {
      this.socket.send(JSON.stringify({ ...message, channel: this.id, ack: this.taken }), sent)
      return
    }
    const prefix: number[] = []
    pushInteger(prefix, this.id)
    pushInteger(prefix, this.taken)
    const bytes = new Uint8Array(prefix.length + message.length)
    bytes.set(prefix)
    bytes.set(message, prefix.length)
    this.socket.send(bytes, sent)
  }
  private settleAck() {
    clearTimeout(this.owedAck)
    this.owedAck = undefined
  }
  close() {
    if (this.readyState !== 1) return
    if (this.socket.readyState === 1)
      this.socket.send(JSON.stringify({ type: 'close', channel: this.id, ack: this.taken }))
    this.ended()
  }
  /** The browser, or the socket, ended it. */
  ended() {
    if (this.readyState !== 1) return
    this.readyState = 3
    this.settleAck()
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
    else if (message.type !== 'open') {
      if (channel?.take(message.seq)) channel.emit('message', message)
    } else if (!channel && channels.size < MAX_CHANNELS) {
      const { sourceId, spaceId, windowId, view, attempt } = message
      if (
        typeof sourceId !== 'string' ||
        typeof spaceId !== 'string' ||
        typeof windowId !== 'string' ||
        !sourceId ||
        !spaceId ||
        !windowId ||
        typeof view !== 'string' ||
        !VIEW.test(view) ||
        typeof attempt !== 'number' ||
        !Number.isSafeInteger(attempt) ||
        attempt < 1
      ) {
        socket.send(JSON.stringify({ type: 'close', channel: id, ack: 0 }))
        return
      }
      const opened = new TerminalChannel(socket, id, view, attempt)
      channels.set(id, opened)
      opened.once('close', () => channels.delete(id))
      open(opened, { sourceId, spaceId, windowId })
    }
  })
  socket.once('close', () => {
    for (const channel of [...channels.values()]) channel.ended()
  })
}
