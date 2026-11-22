import { inputKind, logIdentifier, logType, logWindow } from '../../../../shared/log-line'
import type { LogId } from '../../../../shared/log-line'
import { log, logging, sawServer } from '../diagnostics/log'
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
  /** The browser logged when it opened, so the server says when it sent what. */
  timed: boolean
  w: LogId
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
  /** The server's name for the socket, which both logs use. */
  private name?: LogId
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
        stalled: (waited) => this.abandon(waited),
      },
      () => page.now(),
    )
    socket.binaryType = 'arraybuffer'
    // The server expects the token first.
    socket.onopen = () => {
      this.write({ type: 'auth', token })
      for (const [channel, target] of this.channels) this.announce(channel, target)
    }
    socket.onmessage = (event) => this.receive(event.data)
    socket.onerror = () => this.ended('failed')
    socket.onclose = () => this.ended('closed')
  }

  open(window: TerminalWindow, view: TerminalView, events: ConnectionEvents): TerminalConnection {
    const channel = this.next++
    const target: Channel = {
      window,
      view,
      events,
      resumed: false,
      timed: logging(),
      w: logWindow(window),
    }
    this.channels.set(channel, target)
    const live = () => this.channels.has(channel) && this.socket.readyState === this.socket.OPEN
    if (live()) this.announce(channel, target)
    return {
      get open() {
        return live()
      },
      send: (message) => {
        // Before the handshake a new number would overtake the input to send again.
        if (!live() || !target.resumed) return false
        this.number(channel, target, message)
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
    for (const [channel, { events, resumed }] of this.channels) {
      if (!resumed || !events.watching?.()) continue
      this.number(channel, this.channels.get(channel)!, { type: 'ping', id: 'link' })
      this.watch.sent()
      return
    }
  }
  /** Goes first on a new channel: what the view sent before and the server has not taken. */
  private resume(channel: number, target: Channel, taken: unknown) {
    target.resumed = true
    const now = this.page.now()
    const again = target.view.resumed(taken, now)
    for (const { seq, data } of again) this.write({ type: 'input', data, channel, seq })
    log('resumed', {
      socket: this.name,
      w: target.w,
      known: typeof taken === 'number',
      taken: typeof taken === 'number' ? taken : undefined,
      again: again.length,
      stalledFor: target.view.stalledAt === undefined ? undefined : now - target.view.stalledAt,
    })
    target.view.stalledAt = undefined
    this.watch.sent()
  }
  /** Gives the stuck socket up. What still arrives on it is nobody's. */
  private abandon(waited: number) {
    const open = [...this.channels.values()]
    if (!open.length) return
    log('stall', { socket: this.name, waited, windows: open.length })
    for (const { view } of open) view.stalledAt = this.page.now()
    this.channels.clear()
    this.watch.stop()
    this.idle()
    setTimeout(() => this.socket.close(), RETIRE_MS)
    for (const { events } of open) events.closed('stalled')
  }
  /** Only the target is sent: a caller's window may be a larger object. */
  private announce(channel: number, { window, view, timed }: Channel) {
    const { sourceId, spaceId, windowId } = window
    this.write({
      type: 'open',
      channel,
      view: view.id,
      attempt: view.attempt(),
      maximized: view.maximized(),
      ...(timed ? { timed } : {}),
      sourceId,
      spaceId,
      windowId,
    })
  }
  /** Numbers a message, sends it and logs it by its type, never by what it holds. */
  private number(channel: number, target: Channel, message: object) {
    const seq = target.view.number(message, this.page.now())
    this.write({ ...message, channel, seq })
    if (!logging()) return
    const { type, data } = message as { type?: unknown; data?: unknown }
    const input = type === 'input' && typeof data === 'string'
    log('send', {
      socket: this.name,
      w: target.w,
      seq,
      type: logType(type),
      kind: input ? inputKind(data) : undefined,
      bytes: input ? data.length : undefined,
    })
  }
  /** Takes an ack, and logs what it covered with the times the server gave. */
  private acknowledge(target: Channel, ack: unknown, sentAt?: unknown, held?: unknown) {
    const from = target.view.taken,
      since = target.view.waitingSince,
      sent = typeof ack === 'number' ? target.view.sentAt(ack) : undefined
    if (!target.view.acknowledged(ack)) return
    this.watch.acknowledged()
    if (!logging()) return
    const now = this.page.now()
    let rtt: number | undefined, offset: number | undefined
    if (sent !== undefined && typeof sentAt === 'number' && typeof held === 'number') {
      // As NTP: sent here, taken there, answered there, received here.
      const received = Date.now(),
        left = received - (now - sent)
      rtt = received - left - held
      offset = (sentAt - held - left + (sentAt - received)) / 2
    }
    log('ack', {
      socket: this.name,
      w: target.w,
      from,
      to: target.view.taken,
      waited: since === undefined ? undefined : now - since,
      rtt,
      offset,
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
      const sentAt = target.timed ? integer() : undefined,
        held = target.timed ? integer() : undefined
      if (target.timed && held === undefined) return
      this.watch.received()
      if (logging()) log('receive', { socket: this.name, w: target.w, bytes: bytes.length, sentAt })
      this.acknowledge(target, ack, sentAt, held)
      target.events.cells(bytes.subarray(at))
      return
    }
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    if (message?.type === 'hello') {
      if (typeof message.socket === 'string') this.name = logIdentifier(message.socket)
      const version = typeof message.version === 'string' ? message.version : undefined,
        revision = typeof message.revision === 'string' ? message.revision : undefined
      sawServer({ version, revision })
      log('socket', {
        socket: this.name,
        version: version === undefined ? undefined : logIdentifier(version),
        revision: revision === undefined ? undefined : logIdentifier(revision),
      })
      return
    }
    const channel = message?.channel
    if (typeof channel !== 'number') return
    const target = this.channels.get(channel)
    if (!target) return
    this.watch.received()
    if (logging())
      log('receive', {
        socket: this.name,
        w: target.w,
        type: logType(message.type),
        bytes: String(data).length,
        sentAt: typeof message.sentAt === 'number' ? message.sentAt : undefined,
      })
    if (message.type === 'resume') {
      this.resume(channel, target, message.taken)
      return
    }
    this.acknowledge(target, message.ack, message.sentAt, message.held)
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
