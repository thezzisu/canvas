// The terminal socket: one per browser tab, carrying a channel for each window it shows.
//
// The first message authenticates the socket (websocket-auth.ts). After that:
//   browser to server   { type: 'open', channel, view, attempt, maximized, sourceId, spaceId,
//                         windowId }
//                       { type: 'close', channel }
//                       { channel, seq, ...message }, a window message (terminals.ts)
//                       any other message, such as { type: 'ping' }, only counts as received
//   server to browser   { type: 'hello', socket, version, revision }, once after signing in
//                       { channel, ack, ...message }
//                       { type: 'ack' }, when nothing else went out in time
//                       { type: 'close', channel, ack }, the server ended the channel
//                       binary: unsigned LEB128 integers, the channel, the ack, then `got`,
//                       `bytes` and `since` (and `sentAt` when timed), then a cell message
//                       every JSON message also carries `got`, `bytes` and `since`
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
// - `ack` is the view's last message taken, so it is cumulative. It rides on the channel's
//   messages and lets the browser forget input it would otherwise send again (`resume`).
//
// Liveness (web/src/utils/terminal/link-watch.ts), as TCP acknowledges: everything sent on the
// socket says what the server had received on it when it was sent. `got` counts its messages, the
// authentication first, and `bytes` the bytes under them, so a long message shows its progress
// while it arrives; `since` is how many milliseconds ago the last message arrived, which gives the
// browser its round trips. A `{ type: 'ack' }` goes alone when nothing else went out within
// ACK_DELAY_MS of bytes arriving. Nothing acknowledges it, and nothing is acknowledged before the
// authentication.
//
// An `open` with `timed` is a browser keeping its diagnostic log: its channel's messages also
// carry `sentAt`, the server's wall clock, which with `since` gives the clock offset.
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { log, logging } from './log.ts'
import { inputKind, logIdentifier, logType, logWindow, type LogWord } from '../shared/log-line.ts'
import type { TerminalTarget } from './terminals.ts'

/** No tab shows more windows at once than the server keeps open. */
const MAX_CHANNELS = 128
const MAX_CHANNEL = 0x7fffffff
/** How long the server waits for a message that would carry what it received, before an ack. */
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

/** What the server has received on the socket, as each message it sends there says it. */
interface Stamp {
  got: number
  bytes: number
  since: number
}
/**
 * One browser's terminal socket, which stamps all it sends with what it has received. It must
 * be made before anything else listens to the socket, so that it counts the authentication.
 */
export class TerminalSocket {
  private got = 0
  private bytes = 0
  private messageAt = performance.now()
  private owedAck?: ReturnType<typeof setTimeout>
  constructor(
    readonly ws: WebSocket,
    /** The stream under the socket, whose bytes say that the browser's way up moves. */
    stream?: {
      prependListener(event: 'data', listener: (chunk: { length: number }) => void): unknown
    },
  ) {
    ws.on('message', () => {
      this.got++
      this.messageAt = performance.now()
      this.oweAck()
    })
    // Counted before the socket reads them, so a message's own stamp includes its bytes.
    stream?.prependListener('data', (chunk) => {
      this.bytes += chunk.length
      this.oweAck()
    })
    ws.once('close', () => this.settleAck())
  }
  get open() {
    return this.ws.readyState === 1
  }
  private stamp(): Stamp {
    return {
      got: this.got,
      bytes: this.bytes,
      since: Math.round(performance.now() - this.messageAt),
    }
  }
  /** What arrived is acknowledged by the next thing sent, or alone after ACK_DELAY_MS. */
  private oweAck() {
    if (!this.open || !this.got) return
    this.owedAck ??= setTimeout(() => this.send({ type: 'ack' }), ACK_DELAY_MS)
    this.owedAck.unref()
  }
  private settleAck() {
    clearTimeout(this.owedAck)
    this.owedAck = undefined
  }
  /** Sends a JSON message with the stamp. */
  send(message: object, sent?: () => void) {
    this.settleAck()
    if (this.open) this.ws.send(JSON.stringify({ ...message, ...this.stamp() }), sent)
  }
  /** Sends a cell message: `prefix` integers, the stamp, `suffix` integers, then the cells. */
  sendCells(prefix: number[], suffix: number[], cells: Uint8Array, sent?: () => void) {
    this.settleAck()
    if (!this.open) return
    const { got, bytes, since } = this.stamp()
    const head: number[] = []
    for (const value of [...prefix, got, bytes, since, ...suffix]) pushInteger(head, value)
    const message = new Uint8Array(head.length + cells.length)
    message.set(head)
    message.set(cells, head.length)
    this.ws.send(message, sent)
  }
}

/** `readyState` is 1 while open and 3 after, as a socket's; `message` and `close` are emitted. */
export class TerminalChannel extends EventEmitter<{
  message: [message: Record<string, unknown>]
  close: []
}> {
  readyState: 1 | 3 = 1
  /** The view's last message taken; it is cumulative. */
  taken = 0
  /** When it last took a message, on the wall clock. */
  takenAt = 0
  /** Who ended it, for the log. */
  endedBy?: Extract<LogWord, 'browser' | 'server' | 'superseded' | 'socket'>
  private acked = 0
  constructor(
    private readonly socket: TerminalSocket,
    readonly id: number,
    /** The page's view this channel carries, and which of its channels this is. */
    readonly view: string,
    readonly attempt: number,
    /** The view is maximized: it keeps the window's size from the channel before. */
    readonly maximized: boolean,
    /** The browser logs, so what is sent says when. */
    private readonly timed = false,
    /** The names both logs use for the socket and the window. */
    readonly names: Record<string, ReturnType<typeof logIdentifier>> = {},
  ) {
    super()
  }
  /** Takes a numbered message; false for one that was taken before or has no number. */
  take(seq: unknown): boolean {
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return false
    if (seq <= this.taken) return false
    this.taken = seq
    this.takenAt = Date.now()
    return true
  }
  /** `sent` runs once the message has left for the network. */
  send(message: object | Uint8Array, sent?: () => void) {
    if (this.readyState !== 1) return
    if (this.taken !== this.acked) {
      this.acked = this.taken
      log('link', 'ack', { ...this.names, channel: this.id, seq: this.taken })
    }
    const timed = this.timed ? [Date.now()] : []
    if (message instanceof Uint8Array)
      this.socket.sendCells([this.id, this.taken], timed, message, sent)
    else
      this.socket.send(
        {
          ...message,
          ...(this.timed ? { sentAt: timed[0] } : {}),
          channel: this.id,
          ack: this.taken,
        },
        sent,
      )
  }
  /** The server ends it, or a later channel of its view replaces it. */
  close(reason: 'server' | 'superseded' = 'server') {
    if (this.readyState !== 1) return
    this.socket.send({ type: 'close', channel: this.id, ack: this.taken })
    this.ended(reason)
  }
  /** The browser, or the socket, ended it. */
  ended(by: NonNullable<TerminalChannel['endedBy']>) {
    if (this.readyState !== 1) return
    this.endedBy = by
    this.readyState = 3
    this.emit('close')
  }
}

/** Runs the channels of an authenticated socket; `open` attaches a window to a new one. */
export function serveTerminalChannels(
  socket: TerminalSocket,
  open: (channel: TerminalChannel, target: TerminalTarget) => void,
  socketName = logIdentifier(''),
) {
  const channels = new Map<number, TerminalChannel>()
  socket.ws.on('message', (bytes, binary) => {
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
    if (message.type === 'close') channel?.ended('browser')
    else if (message.type !== 'open') {
      if (!channel) return
      const started = performance.now()
      const taken = channel.take(message.seq)
      if (taken) channel.emit('message', message)
      if (!logging('link')) return
      const input = message.type === 'input' && typeof message.data === 'string'
      log('link', 'message', {
        ...channel.names,
        channel: id,
        type: logType(message.type),
        seq: typeof message.seq === 'number' ? message.seq : undefined,
        taken,
        kind: input ? inputKind(message.data as string) : undefined,
        bytes: input ? (message.data as string).length : undefined,
        ms: performance.now() - started,
      })
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
        socket.send({ type: 'close', channel: id, ack: 0 })
        return
      }
      const names = { socket: socketName, w: logWindow({ sourceId, windowId }) }
      const maximized = message.maximized === true,
        timed = message.timed === true
      const opened = new TerminalChannel(socket, id, view, attempt, maximized, timed, names)
      channels.set(id, opened)
      const line = { ...names, channel: id, view: logIdentifier(view), attempt }
      log('link', 'channel', { ...line, state: 'open' })
      opened.once('close', () => {
        channels.delete(id)
        log('link', 'channel', {
          ...line,
          state: 'close',
          reason: opened.endedBy,
          seq: opened.taken,
        })
      })
      open(opened, { sourceId, spaceId, windowId })
    }
  })
  socket.ws.once('close', () => {
    for (const channel of [...channels.values()]) channel.ended('socket')
  })
}
