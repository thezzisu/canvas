/**
 * Whether the terminal socket still carries what is sent on it, judged as TCP judges a path: what
 * is sent is owed an acknowledgement, and only a retransmission timeout passing without progress
 * counts against the link. No single message, however late it seems, does.
 *
 * - Everything the server sends says what it had received on the socket when it wrote it: how
 *   many messages (`got`), how many bytes (`bytes`), and how long ago the last message arrived
 *   (`since`), and it says so alone soon after receiving anything (server/terminal-channels.ts),
 *   as TCP delays an ack. Progress is more messages or more bytes, as TCP's cumulative acks show
 *   it: a long paste that keeps arriving is no stall. A newly received message gives a round trip.
 * - The server writes a stamp when it sends, and a slow way down may hold it a while. One written
 *   before the oldest message owed could have arrived says nothing of it yet, so the wait for that
 *   message starts again: such a stamp can make a wait longer, never shorter.
 * - The timeout is RFC 6298's: the smoothed round trip and four times its variation, at least a
 *   second, and the server's ack delay (RFC 9002). It doubles with each one that passes without
 *   progress.
 * - After one timeout the socket is probed; after the second the link is in doubt, and the
 *   terminal says so and takes no input; after the third (RFC 1122's first threshold), or a
 *   change of network, the socket is given up for a new one.
 * - With nothing owed, the socket is asked only while a visible window shows a working agent,
 *   whose silence is itself suspicious. While another transfer shares the way up, such as an
 *   upload, nothing is judged.
 */

/** RFC 6298 §2.4: a timeout shorter than a second is rounded up to one. */
const MIN_TIMEOUT_MS = 1000
/** RFC 9002 §6.2.2: the round trip assumed before any is measured. */
const INITIAL_RTT_MS = 333
/** RFC 6298 §2: the clock's granularity. */
const GRANULARITY_MS = 1
/** RFC 1122 §4.2.3.5: the attempts after which a path is given up (R1). */
const ATTEMPTS = 3
/** How long the server waits before an ack goes alone (server/terminal-channels.ts). */
const ACK_DELAY_MS = 100

/** A link's round trip, smoothed as RFC 6298 §2 smooths it. */
export class RoundTrip {
  smoothed?: number
  variation = INITIAL_RTT_MS / 2
  sample(ms: number) {
    if (this.smoothed === undefined) {
      this.smoothed = ms
      this.variation = ms / 2
      return
    }
    this.variation = 0.75 * this.variation + 0.25 * Math.abs(this.smoothed - ms)
    this.smoothed = 0.875 * this.smoothed + 0.125 * ms
  }
  /** How long an acknowledgement may take before its absence means something. */
  get timeout() {
    const spread = Math.max(GRANULARITY_MS, 4 * this.variation)
    return Math.max(MIN_TIMEOUT_MS, (this.smoothed ?? INITIAL_RTT_MS) + spread) + ACK_DELAY_MS
  }
}

/** What the server says, on everything it sends, it had received on the socket. */
export interface Stamp {
  got: number
  bytes: number
  since: number
}
/**
 * What a stamp says of what was sent: the server received more, with the round trip of a message
 * it newly received; or it wrote the stamp before the oldest message owed could have reached it.
 */
export type Answer = { kind: 'progress'; rtt?: number } | { kind: 'early' }

/** What a browser sent on one socket that the server has yet to say it received. */
export class Outbox {
  private count = 0
  private pending: { index: number; at: number }[] = []
  /**
   * The newest message the server said it received (the connection itself is message 0, as the
   * server counts), when it was sent, and the bytes the server had received by then.
   */
  private last: { index: number; at: number; bytes: number }
  constructor(opened: number) {
    this.last = { index: 0, at: opened, bytes: 0 }
  }
  sent(now: number) {
    this.pending.push({ index: ++this.count, at: now })
  }
  /** The oldest message the server has yet to say it received. */
  get oldest(): Readonly<{ at: number }> | undefined {
    return this.pending[0]
  }
  stamped({ got, bytes, since }: Stamp, now: number): Answer | undefined {
    if (got > this.last.index && got <= this.count) {
      let newest = this.pending[0]!
      while (this.pending[0] && this.pending[0].index <= got) newest = this.pending.shift()!
      this.last = { index: got, at: newest.at, bytes }
      // From leaving here to now, less the time the server held it before saying so.
      const rtt = now - newest.at - since
      return rtt >= 0 ? { kind: 'progress', rtt } : { kind: 'progress' }
    }
    if (got !== this.last.index) return
    // Bytes of the next message arrived: it is on its way.
    if (bytes > this.last.bytes) {
      this.last.bytes = bytes
      return { kind: 'progress' }
    }
    // Written sooner after the last message arrived than the next one left after it.
    const next = this.pending[0]
    if (next && since < next.at - this.last.at) return { kind: 'early' }
  }
}

export type StallReason = 'silent' | 'network'
interface Link {
  oldest(): { at: number } | undefined
  /** Something else shares the way up and may hold it, such as an upload. */
  busy(): boolean
  /** The page is shown. A hidden one judges nothing. */
  visible(): boolean
  /** A view shows a working agent, so silence on the socket is suspicious. */
  watching(): boolean
  /** Sends a message only to have it acknowledged. */
  probe(): void
  doubt(on: boolean): void
  stalled(reason: StallReason): void
}

/** Judges one socket by the progress of what was sent on it. */
export class LinkWatch {
  readonly rtt = new RoundTrip()
  /** Timeouts that passed in a row without progress. */
  private failures = 0
  private doubted = false
  private timer?: ReturnType<typeof setTimeout>
  /** When anything last arrived from the server. */
  private heard: number
  /**
   * The earliest the current wait may have begun: at progress, an early stamp, a timeout passing,
   * a transfer sharing the way up, or the page shown again.
   */
  private waitFrom: number
  private ended = false
  constructor(
    private readonly link: Link,
    private readonly now: () => number,
  ) {
    this.heard = this.waitFrom = now()
  }
  /** The timeout now, doubled for each that passed without progress. */
  get timeout() {
    return this.rtt.timeout * 2 ** this.failures
  }
  sent() {
    this.schedule()
  }
  received(answer?: Answer) {
    if (this.ended) return
    this.heard = this.now()
    if (answer) this.waitFrom = this.heard
    if (answer?.kind === 'progress') {
      if (answer.rtt !== undefined) this.rtt.sample(answer.rtt)
      this.failures = 0
      if (this.doubted) {
        this.doubted = false
        this.link.doubt(false)
      }
    }
    this.schedule()
  }
  /** The page is shown again: what is outstanding is asked about afresh. */
  shown() {
    if (this.ended) return
    this.failures = 0
    this.waitFrom = this.now()
    if (this.link.oldest()) this.link.probe()
    else this.schedule()
  }
  /** The browser moved to another network, where the socket's path is gone. */
  network() {
    if (!this.ended) this.link.stalled('network')
  }
  stop() {
    this.ended = true
    clearTimeout(this.timer)
    this.timer = undefined
  }
  /**
   * When the wait in progress began: for what is owed, since it was sent; with nothing owed,
   * under a working agent, since anything was heard.
   */
  private waitingSince() {
    const oldest = this.link.oldest()
    if (oldest) return Math.max(oldest.at, this.waitFrom)
    if (this.link.watching()) return Math.max(this.heard, this.waitFrom)
  }
  private schedule() {
    clearTimeout(this.timer)
    this.timer = undefined
    const since = this.ended ? undefined : this.waitingSince()
    if (since !== undefined)
      this.timer = setTimeout(() => this.check(), Math.max(0, since + this.timeout - this.now()))
  }
  private check() {
    this.timer = undefined
    if (!this.link.visible()) return
    const now = this.now(),
      since = this.waitingSince()
    if (since === undefined) return
    if (now - since < this.timeout) return this.schedule()
    // Another transfer up the same way may hold it: the wait starts again.
    if (this.link.busy()) {
      this.waitFrom = now
      return this.schedule()
    }
    // Silence under a working agent: ask, and judge the answer as anything owed.
    if (!this.link.oldest()) return this.link.probe()
    this.failures++
    this.waitFrom = now
    if (this.failures >= ATTEMPTS) return this.link.stalled('silent')
    if (this.failures === 1) this.link.probe()
    else if (!this.doubted) {
      this.doubted = true
      this.link.doubt(true)
    }
    this.schedule()
  }
}
