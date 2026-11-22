import { LinkWatch } from './link-watch'
import type { TerminalView } from './terminal-view'

/**
 * How long a stuck socket is left open after it was given up. Closing it at once would release
 * a maximized window on the server before the view's next channel can take it over.
 */
export const RETIRE_MS = 12_000

/**
 * A window's link to the server, as a session sees it: JSON either way, cell messages in.
 * Sessions hold nothing else of the transport.
 */
export interface TerminalConnection {
  readonly open: boolean
  /** False when the link is not open or has not resumed the view; the message is dropped. */
  send(message: object): boolean
  /** Ends the link. Nothing is reported after it. */
  close(): void
}
export interface ConnectionEvents {
  message(message: Record<string, unknown>): void
  cells(bytes: Uint8Array): void
  /** The link ended without `close`. */
  closed(end: LinkEnd): void
  /** The view is shown with a working agent in it, so silence on its socket is suspicious. */
  watching?(): boolean
}
/** `failed`: the socket never opened or broke with an error. `stalled`: it stopped answering. */
export type LinkEnd = 'closed' | 'failed' | 'stalled'
interface Channel {
  window: TerminalWindow
  view: TerminalView
  events: ConnectionEvents
  /** The server has said how far it took the view; until then nothing of it is owed here. */
  resumed: boolean
}
export interface TerminalWindow {
  sourceId: string
  spaceId: string
  windowId: string
}

/**
 * The page's one terminal socket, with a channel on it for each window: the browser's side of
 * `server/terminal-channels.ts`. The socket's end is the end of every channel still on it, and
 * `idle` reports the last channel leaving, after which the socket is closed and of no more use.
 */
export class TerminalChannels {
  private readonly channels = new Map<number, Channel>()
  private readonly watch: LinkWatch
  /** Channel numbers are never used twice on a socket. */
  private next = 0

  constructor(
    private readonly socket: WebSocket,
    token: string,
    private readonly idle: () => void,
    private readonly page: { now(): number; visible(): boolean } = {
      now: () => performance.now(),
      visible: () => !document.hidden,
    },
  ) {
    this.watch = new LinkWatch(
      {
        waitingSince: () => this.waitingSince(),
        probe: () => this.probe(),
        visible: () => page.visible(),
        stalled: () => this.abandon(),
      },
      () => page.now(),
    )
    socket.binaryType = 'arraybuffer'
    // The server expects the token first.
    socket.onopen = () => {
      this.write({ type: 'auth', token })
      for (const [channel, { window, view }] of this.channels) this.announce(channel, window, view)
    }
    socket.onmessage = (event) => this.receive(event.data)
    socket.onerror = () => this.ended('failed')
    socket.onclose = () => this.ended('closed')
  }

  open(window: TerminalWindow, view: TerminalView, events: ConnectionEvents): TerminalConnection {
    const channel = this.next++
    this.channels.set(channel, { window, view, events, resumed: false })
    const live = () => this.channels.has(channel) && this.socket.readyState === this.socket.OPEN
    if (live()) this.announce(channel, window, view)
    return {
      get open() {
        return live()
      },
      send: (message) => {
        // Before the handshake a new number would overtake the input to send again.
        if (!live() || !this.channels.get(channel)!.resumed) return false
        this.write({ ...message, channel, seq: view.number(message, this.page.now()) })
        this.watch.sent()
        return true
      },
      close: () => {
        if (live()) this.write({ type: 'close', channel })
        this.release(channel)
      },
    }
  }

  /** The page is shown again. */
  shown() {
    this.watch.shown()
  }
  private waitingSince() {
    let oldest: number | undefined
    for (const { view, resumed } of this.channels.values()) {
      const since = resumed ? view.waitingSince : undefined
      if (since !== undefined && (oldest === undefined || since < oldest)) oldest = since
    }
    return oldest
  }
  private probe() {
    for (const [channel, { view, events, resumed }] of this.channels) {
      if (!resumed || !events.watching?.()) continue
      const message = { type: 'ping', id: 'link' }
      this.write({ ...message, channel, seq: view.number(message, this.page.now()) })
      this.watch.sent()
      return
    }
  }
  /** Goes first on a new channel: what the view sent before and the server has not taken. */
  private resume(channel: number, target: Channel, taken: unknown) {
    target.resumed = true
    for (const { seq, data } of target.view.resumed(taken, this.page.now()))
      this.write({ type: 'input', data, channel, seq })
    this.watch.sent()
  }
  /** Gives the stuck socket up. What still arrives on it is nobody's. */
  private abandon() {
    const open = [...this.channels.values()]
    if (!open.length) return
    this.channels.clear()
    this.watch.stop()
    this.idle()
    setTimeout(() => this.socket.close(), RETIRE_MS)
    for (const { events } of open) events.closed('stalled')
  }
  /** Only the target is sent: a caller's window may be a larger object. */
  private announce(
    channel: number,
    { sourceId, spaceId, windowId }: TerminalWindow,
    view: TerminalView,
  ) {
    this.write({
      type: 'open',
      channel,
      view: view.id,
      attempt: view.attempt(),
      maximized: view.maximized(),
      sourceId,
      spaceId,
      windowId,
    })
  }
  private write(message: object) {
    this.socket.send(JSON.stringify(message))
  }
  private release(channel: number) {
    if (!this.channels.delete(channel)) return false
    if (!this.channels.size) {
      this.watch.stop()
      this.idle()
      this.socket.close()
    }
    return true
  }
  private receive(data: unknown) {
    if (data instanceof ArrayBuffer) {
      // The channel and the ack, unsigned LEB128 integers, precede the cell message.
      const bytes = new Uint8Array(data)
      let at = 0
      const integer = () => {
        let value = 0
        for (let shift = 0; shift < 8 && at < bytes.length; shift++) {
          const byte = bytes[at++]!
          value += (byte & 0x7f) * 2 ** (7 * shift)
          if (byte < 0x80) return value
        }
        return undefined
      }
      const channel = integer(),
        ack = integer()
      if (channel === undefined || ack === undefined) return
      const target = this.channels.get(channel)
      if (!target) return
      this.watch.received()
      if (target.view.acknowledged(ack)) this.watch.acknowledged()
      target.events.cells(bytes.subarray(at))
      return
    }
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    const channel = message?.channel
    if (typeof channel !== 'number') return
    const target = this.channels.get(channel)
    if (!target) return
    this.watch.received()
    if (message.type === 'resume') {
      this.resume(channel, target, message.taken)
      return
    }
    if (target.view.acknowledged(message.ack)) this.watch.acknowledged()
    if (message.type === 'ack') return
    if (message.type !== 'close') target.events.message(message)
    // The server ended this channel alone.
    else if (this.release(channel)) target.events.closed('closed')
  }
  private ended(end: LinkEnd) {
    this.watch.stop()
    const open = [...this.channels.values()]
    if (!open.length) return
    this.channels.clear()
    this.idle()
    this.socket.close()
    for (const { events } of open) events.closed(end)
  }
}
