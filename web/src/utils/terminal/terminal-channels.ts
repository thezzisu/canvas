/**
 * A window's link to the server, as a session sees it: JSON either way, cell messages in.
 * Sessions hold nothing else of the transport.
 */
export interface TerminalConnection {
  readonly open: boolean
  /** False when the link is not open; the message is dropped. */
  send(message: object): boolean
  /** Ends the link. Nothing is reported after it. */
  close(): void
}
export interface ConnectionEvents {
  message(message: Record<string, unknown>): void
  cells(bytes: Uint8Array): void
  /** The link ended without `close`; `failed` when the socket never opened or broke with an error. */
  closed(failed: boolean): void
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
  private readonly channels = new Map<
    number,
    { window: TerminalWindow; events: ConnectionEvents }
  >()
  /** Channel numbers are never used twice on a socket. */
  private next = 0

  constructor(
    private readonly socket: WebSocket,
    token: string,
    private readonly idle: () => void,
  ) {
    socket.binaryType = 'arraybuffer'
    // The server expects the token first.
    socket.onopen = () => {
      this.write({ type: 'auth', token })
      for (const [channel, { window }] of this.channels) this.announce(channel, window)
    }
    socket.onmessage = (event) => this.receive(event.data)
    socket.onerror = () => this.ended(true)
    socket.onclose = () => this.ended(false)
  }

  open(window: TerminalWindow, events: ConnectionEvents): TerminalConnection {
    const channel = this.next++
    this.channels.set(channel, { window, events })
    const live = () => this.channels.has(channel) && this.socket.readyState === this.socket.OPEN
    if (live()) this.announce(channel, window)
    return {
      get open() {
        return live()
      },
      send: (message) => {
        if (!live()) return false
        this.write({ ...message, channel })
        return true
      },
      close: () => {
        if (live()) this.write({ type: 'close', channel })
        this.release(channel)
      },
    }
  }

  /** Only the target is sent: a caller's window may be a larger object. */
  private announce(channel: number, { sourceId, spaceId, windowId }: TerminalWindow) {
    this.write({ type: 'open', channel, sourceId, spaceId, windowId })
  }
  private write(message: object) {
    this.socket.send(JSON.stringify(message))
  }
  private release(channel: number) {
    if (!this.channels.delete(channel)) return false
    if (!this.channels.size) {
      this.idle()
      this.socket.close()
    }
    return true
  }
  private receive(data: unknown) {
    if (data instanceof ArrayBuffer) {
      // The channel number, an unsigned LEB128 integer, precedes the cell message.
      const bytes = new Uint8Array(data)
      let channel = 0
      for (let at = 0; at < 5 && at < bytes.length; at++) {
        channel += (bytes[at]! & 0x7f) * 2 ** (7 * at)
        if (bytes[at]! < 0x80) {
          this.channels.get(channel)?.events.cells(bytes.subarray(at + 1))
          return
        }
      }
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
    const events = this.channels.get(channel)?.events
    if (message.type !== 'close') events?.message(message)
    // The server ended this channel alone.
    else if (this.release(channel)) events!.closed(false)
  }
  private ended(failed: boolean) {
    const open = [...this.channels.values()]
    if (!open.length) return
    this.channels.clear()
    this.idle()
    this.socket.close()
    for (const { events } of open) events.closed(failed)
  }
}
