import { inputKind, logIdentifier, logType, logWindow } from '../../../../shared/log-line'
import type { LogId } from '../../../../shared/log-line'
import { log, logging, sawServer } from '../diagnostics/log'
import { LinkWatch, Outbox, type Stamp, type StallReason } from './link-watch'
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
  /** The view sends something else up the same way, such as an upload, which may hold it. */
  busy?(): boolean
  /** The link may be stuck: the view says so and takes no input until it is clear. */
  doubted?(on: boolean): void
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
/** The page the socket lives in. */
export interface TerminalPage {
  now(): number
  visible(): boolean
  /** Calls `changed` when the browser moves to another network. */
  onNetwork?(changed: () => void): () => void
}

const stampOf = (message: Record<string, unknown>): Stamp | undefined => {
  const { got, bytes, since } = message
  return [got, bytes, since].every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
    ? { got: got as number, bytes: bytes as number, since: since as number }
    : undefined
}

/** Where the browser's network changes: another kind of link, or back online. */
export function followNetwork(changed: () => void): () => void {
  const connection = (
    navigator as Navigator & {
      connection?: EventTarget & { type?: string }
    }
  ).connection
  let type = connection?.type
  const typeChanged = () => {
    if (connection?.type === type) return
    type = connection?.type
    changed()
  }
  connection?.addEventListener('change', typeChanged)
  window.addEventListener('online', changed)
  return () => {
    connection?.removeEventListener('change', typeChanged)
    window.removeEventListener('online', changed)
  }
}

/**
 * The page's one terminal socket, with a channel on it for each window: the browser's side of
 * `server/terminal-channels.ts`. The socket's end is the end of every channel still on it, and
 * `idle` reports the last channel leaving, after which the socket is closed and of no more use.
 */
export class TerminalChannels {
  private readonly channels = new Map<number, Channel>()
  private readonly watch: LinkWatch
  /** What was sent on the socket and not yet received, from its opening. */
  private outbox?: Outbox
  /** The server's name for the socket, which both logs use. */
  private name?: LogId
  /** Channel numbers are never used twice on a socket. */
  private next = 0
  private readonly unfollow?: () => void

  constructor(
    private readonly socket: WebSocket,
    token: string,
    private readonly idle: () => void,
    private readonly page: TerminalPage = {
      now: () => performance.now(),
      visible: () => !document.hidden,
      onNetwork: followNetwork,
    },
  ) {
    this.watch = new LinkWatch(
      {
        oldest: () => this.outbox?.oldest,
        busy: () => [...this.channels.values()].some(({ events }) => events.busy?.()),
        visible: () => page.visible(),
        watching: () =>
          [...this.channels.values()].some(({ resumed, events }) => resumed && events.watching?.()),
        probe: () => this.write({ type: 'ping' }),
        doubt: (on) => this.doubt(on),
        stalled: (reason) => this.abandon(reason),
      },
      () => page.now(),
    )
    this.unfollow = page.onNetwork?.(() => this.watch.network())
    socket.binaryType = 'arraybuffer'
    // The server expects the token first.
    socket.onopen = () => {
      this.outbox = new Outbox(page.now())
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
  /** Goes first on a new channel: what the view sent before and the server has not taken. */
  private resume(channel: number, target: Channel, taken: unknown) {
    target.resumed = true
    const now = this.page.now()
    const again = target.view.resumed(taken)
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
    // A resumed view may watch an agent at work, so the socket's silence may now be questioned.
    this.watch.received()
  }
  private doubt(on: boolean) {
    log('stall', {
      socket: this.name,
      state: on ? 'doubt' : 'clear',
      rtt: this.watch.rtt.smoothed,
      timeout: this.watch.timeout,
    })
    for (const { events } of this.channels.values()) events.doubted?.(on)
  }
  /** Gives the stuck socket up. What still arrives on it is nobody's. */
  private abandon(reason: StallReason) {
    const open = [...this.channels.values()]
    if (!open.length) return
    const oldest = this.outbox?.oldest
    log('stall', {
      socket: this.name,
      state: 'stalled',
      reason,
      waited: oldest ? this.page.now() - oldest.at : undefined,
      windows: open.length,
    })
    for (const { view } of open) view.stalledAt = this.page.now()
    this.channels.clear()
    this.stop()
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
    const seq = target.view.number(message)
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
  private write(message: object) {
    this.socket.send(JSON.stringify(message))
    this.outbox?.sent(this.page.now())
    this.watch.sent()
  }
  private release(channel: number) {
    if (!this.channels.delete(channel)) return false
    if (!this.channels.size) {
      this.stop()
      this.socket.close()
    }
    return true
  }
  private stop() {
    this.watch.stop()
    this.unfollow?.()
    this.idle()
  }
  /** Reads what the server says it received, which everything it sends carries. */
  private stamped(stamp: Stamp | undefined, sentAt?: number) {
    if (!stamp || !this.outbox) return
    const answer = this.outbox.stamped(stamp, this.page.now())
    this.watch.received(answer)
    if (answer?.kind !== 'progress' || answer.rtt === undefined || !logging()) return
    // As NTP: left here, received there, sent there, received here, each on its own clock.
    const received = Date.now(),
      left = received - answer.rtt - stamp.since
    log('ack', {
      socket: this.name,
      got: stamp.got,
      rtt: answer.rtt,
      srtt: this.watch.rtt.smoothed,
      offset:
        sentAt === undefined ? undefined : (sentAt - stamp.since - left + (sentAt - received)) / 2,
    })
  }
  private receive(data: unknown) {
    if (data instanceof ArrayBuffer) {
      // Unsigned LEB128 integers precede the cell message: the channel, the view's ack, the
      // stamp, and the server's clock when the channel is timed.
      const message = new Uint8Array(data)
      let at = 0
      const integer = () => {
        let value = 0
        for (let shift = 0; shift < 8 && at < message.length; shift++) {
          const byte = message[at++]!
          value += (byte & 0x7f) * 2 ** (7 * shift)
          if (byte < 0x80) return value
        }
        return undefined
      }
      const [channel, ack, got, bytes, since] = [
        integer(),
        integer(),
        integer(),
        integer(),
        integer(),
      ]
      if (since === undefined) return
      const target = this.channels.get(channel!)
      const sentAt = target?.timed ? integer() : undefined
      this.stamped({ got: got!, bytes: bytes!, since }, sentAt)
      if (!target || (target.timed && sentAt === undefined)) return
      if (logging())
        log('receive', { socket: this.name, w: target.w, bytes: message.length, sentAt })
      target.view.acknowledged(ack)
      target.events.cells(message.subarray(at))
      return
    }
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    const sentAt = typeof message.sentAt === 'number' ? message.sentAt : undefined
    this.stamped(stampOf(message), sentAt)
    if (message.type === 'hello') {
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
    const channel = message.channel
    if (typeof channel !== 'number') return
    const target = this.channels.get(channel)
    if (!target) return
    if (logging())
      log('receive', {
        socket: this.name,
        w: target.w,
        type: logType(message.type),
        bytes: String(data).length,
        sentAt,
      })
    if (message.type === 'resume') {
      this.resume(channel, target, message.taken)
      return
    }
    target.view.acknowledged(message.ack)
    if (message.type !== 'close') target.events.message(message)
    // The server ended this channel alone.
    else if (this.release(channel)) target.events.closed('closed')
  }
  private ended(end: LinkEnd) {
    this.watch.stop()
    this.unfollow?.()
    const open = [...this.channels.values()]
    if (!open.length) return
    this.channels.clear()
    this.idle()
    this.socket.close()
    for (const { events } of open) events.closed(end)
  }
}
