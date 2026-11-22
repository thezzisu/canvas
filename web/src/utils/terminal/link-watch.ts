/**
 * Whether the terminal socket still carries what is sent on it, judged as TCP and QUIC judge a
 * path: by the round trip it is measured to have, and by progress, not by fixed limits.
 *
 * - Everything the server sends says what it had received on the socket: how many messages
 *   (`got`), how long ago the last of them arrived (`since`), and how long ago any byte did
 *   (`quiet`) (server/terminal-channels.ts).
 * - Each newly received message gives a round trip: from when it left here to now, less the time
 *   the server held it. They are smoothed as RFC 6298 smooths them.
 * - A timeout is that round trip and four times its variation, at least a second (RFC 6298), and
 *   the server's ack delay (RFC 9002). It doubles with each one that passes without progress.
 * - Progress is the server receiving more, bytes of the next message reaching it, or bytes
 *   leaving this browser's buffer. Bytes arriving here that the server sent before the next
 *   message could have reached it prove nothing, and are waited through.
 * - After one timeout without progress the socket is probed; after the probe's own, in silence,
 *   the link is in doubt and the terminal shows it and takes no input. Bytes the server sent well
 *   after the next message should have reached it, without it, prove the way up holds it: the
 *   link is in doubt at once. After a third timeout without progress (RFC 1122's first threshold)
 *   or a change of network, the socket is given up for a new one.
 */

/** RFC 6298 §2.4: a timeout shorter than a second is rounded up to one. */
const MIN_TIMEOUT_MS = 1000
/** RFC 9002 §6.2.2: the round trip assumed before any is measured. */
const INITIAL_RTT_MS = 333
/** RFC 6298 §2: the clock's granularity. */
const GRANULARITY_MS = 1
/** RFC 1122 §4.2.3.5: the attempts after which a path is in doubt (R1). */
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
  /** How far an answer's delay may stray from the usual. */
  get spread() {
    return Math.max(GRANULARITY_MS, 4 * this.variation)
  }
  /** How long an answer may take before its absence means something. */
  get timeout() {
    return Math.max(MIN_TIMEOUT_MS, (this.smoothed ?? INITIAL_RTT_MS) + this.spread) + ACK_DELAY_MS
  }
}

/** What the server says, on each message, it had received on the socket. */
export interface Stamp {
  got: number
  since: number
  quiet: number
}
/** What a message from the server says of what this browser sent. */
export interface Verdict {
  /** The way up moved: the server received more, or bytes of the next message. */
  progressed?: boolean
  /** A round trip, of the message the server newly received. */
  sample?: number
  /** The server sent this well after the next message should have reached it. */
  held?: boolean
  /** The server sent this before the next message could have reached it. */
  queued?: boolean
}
interface Sent {
  index: number
  /** Its last byte, counted as `bufferedAmount` counts them. */
  end: number
  at: number
  /** When it left this browser's buffer. */
  left?: number
}

/** What a browser sent on one socket that the server has yet to say it received. */
export class Outbox {
  private count = 0
  private bytes = 0
  private drainedBytes = 0
  private pending: Sent[] = []
  /** The last message the server said it received, when it left here, and its byte gap. */
  private last: { index: number; left: number; gap: number }
  constructor(opened: number) {
    // The connection itself is message 0, as the server counts.
    this.last = { index: 0, left: opened, gap: 0 }
  }
  sent(bytes: number, now: number, buffered: number) {
    this.bytes += bytes
    this.pending.push({ index: ++this.count, end: this.bytes, at: now })
    this.drain(buffered, now)
  }
  /** Notes what left the browser's buffer; whether anything did since the last look. */
  drain(buffered: number, now: number) {
    const drained = this.bytes - buffered
    if (drained <= this.drainedBytes) return false
    this.drainedBytes = drained
    for (const sent of this.pending)
      if (sent.left === undefined && sent.end <= drained) sent.left = now
    return true
  }
  /** The oldest message the server has yet to say it received. */
  get oldest(): Readonly<Sent> | undefined {
    return this.pending[0]
  }
  /** Reads a stamp. `spread` is how far a one-way delay may stray from the usual. */
  stamped({ got, since, quiet }: Stamp, now: number, spread: number): Verdict {
    if (got > this.last.index && got <= this.count) {
      let newest: Sent | undefined
      while (this.pending[0] && this.pending[0].index <= got) newest = this.pending.shift()
      const left = newest!.left ?? newest!.at
      this.last = { index: got, left, gap: since - quiet }
      const sample = now - left - since
      return { progressed: true, ...(sample >= 0 ? { sample } : {}) }
    }
    if (got !== this.last.index) return {}
    // Bytes arrived after the last message: the next is on its way.
    if (since - quiet > this.last.gap) {
      this.last.gap = since - quiet
      return { progressed: true }
    }
    const next = this.pending[0]
    if (next?.left === undefined) return {}
    // The server had been waiting `since` ms when it sent this; the next message left here
    // `next.left - last.left` ms after the last one. The difference is how long after the next
    // one would have arrived, as the last one did, the server sent this without it.
    const overdue = since - (next.left - this.last.left)
    return overdue > spread ? { held: true } : { queued: true }
  }
}

export type StallReason = 'silent' | 'held' | 'network'
interface Link {
  /** Notes what left the browser's buffer; whether anything did since the last look. */
  drained(): boolean
  oldest(): { at: number; left?: number } | undefined
  /** Something else shares the way up and may hold it, such as an upload. */
  busy(): boolean
  /** The page is shown. A hidden one judges nothing. */
  visible(): boolean
  /** A view shows a working agent, so silence on the socket is suspicious. */
  watching(): boolean
  /** Sends a message only to have it received. */
  probe(): void
  doubt(on: boolean, reason?: StallReason): void
  stalled(reason: StallReason): void
}

/** Judges one socket, on its round trip and its progress. */
export class LinkWatch {
  readonly rtt = new RoundTrip()
  /** Timeouts that passed in a row without progress. */
  private failures = 0
  private doubted = false
  private timer?: ReturnType<typeof setTimeout>
  private due = 0
  /** When bytes last arrived from the server. */
  private heard: number
  /** When the current wait for an answer began: progress, or bytes the answer was behind. */
  private waitFrom = 0
  private ended = false
  constructor(
    private readonly link: Link,
    private readonly now: () => number,
  ) {
    this.heard = now()
  }
  /** The timeout now, doubled for each that passed without progress. */
  get timeout() {
    return this.rtt.timeout * 2 ** this.failures
  }
  sent() {
    this.arm(this.now() + this.timeout)
  }
  received(verdict: Verdict) {
    if (this.ended) return
    const now = (this.heard = this.now())
    if (verdict.sample !== undefined) this.rtt.sample(verdict.sample)
    if (verdict.progressed) this.progress()
    else if (verdict.held) this.doubt('held')
    // The answer is behind what arrives now, so its wait starts again.
    else if (verdict.queued) {
      this.waitFrom = now
      this.arm(now + this.timeout, true)
    } else if (!this.link.oldest()) this.idle()
  }
  /** The page is shown again: what is outstanding is asked about afresh. */
  shown() {
    if (this.ended) return
    this.failures = 0
    this.waitFrom = this.now()
    if (this.link.oldest()) this.link.probe()
    else this.idle()
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
  private progress() {
    this.failures = 0
    this.waitFrom = this.now()
    if (this.doubted) {
      this.doubted = false
      this.link.doubt(false)
    }
    const oldest = this.link.oldest()
    if (oldest) this.arm(this.now() + this.timeout, true)
    else this.idle()
  }
  private doubt(reason: StallReason) {
    if (this.doubted) return
    this.doubted = true
    this.link.doubt(true, reason)
  }
  /** Nothing is outstanding: under a working agent, silence is questioned. */
  private idle() {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.link.watching()) this.arm(this.heard + this.timeout)
  }
  private arm(at: number, reset = false) {
    if (this.ended || (!reset && this.timer !== undefined && this.due <= at)) return
    clearTimeout(this.timer)
    this.due = at
    this.timer = setTimeout(() => this.check(), Math.max(0, at - this.now()))
  }
  private check(late = true) {
    this.timer = undefined
    if (!this.link.visible()) return
    const now = this.now()
    // A timer this late says the page was busy or frozen: what arrived meanwhile is read first.
    if (late && now - this.due > ACK_DELAY_MS) {
      this.timer = setTimeout(() => this.check(false), 0)
      return
    }
    if (this.link.drained() || this.link.busy()) return this.progress()
    const oldest = this.link.oldest()
    if (!oldest) {
      if (!this.link.watching()) return
      if (now - this.heard < this.timeout) return this.arm(this.heard + this.timeout)
      return this.link.probe()
    }
    const waited = now - Math.max(oldest.left ?? oldest.at, this.waitFrom)
    if (waited < this.timeout) return this.arm(now + this.timeout - waited, true)
    this.failures++
    if (this.failures >= ATTEMPTS) return this.link.stalled(this.doubted ? 'held' : 'silent')
    if (this.failures === 1) this.link.probe()
    else this.doubt('silent')
    this.arm(now + this.timeout, true)
  }
}
