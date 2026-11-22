/** A message not taken for this long, with no progress since, means the socket is stuck. */
export const STALL_MS = 2000
/** A socket silent this long under a working agent is asked whether it still works. */
export const SILENCE_MS = 2000
/** A check this late says the page was busy or frozen: what arrived meanwhile is read first. */
const LATE_MS = 100
const CATCH_UP_MS = 250

interface LinkState {
  /** The oldest message sent and not taken. */
  waitingSince(): number | undefined
  /** Asks the server for an answer, if a view would show by changing that the socket works. */
  probe(): void
  /** The page is shown. A hidden one judges nothing. */
  visible(): boolean
  stalled(waited: number): void
}

/**
 * Judges one socket. Only an ack shows that both directions work: cells go on arriving over a
 * socket whose way up is stuck. Each ack restarts the wait, so a long paste on a slow link that
 * is getting through is no stall.
 */
export class LinkWatch {
  private timer?: ReturnType<typeof setTimeout>
  private due = 0
  private heard: number
  private progressed = -Infinity
  private ended = false
  constructor(
    private readonly link: LinkState,
    private readonly now: () => number,
  ) {
    this.heard = now()
  }
  received() {
    this.heard = this.now()
    this.arm(this.heard + SILENCE_MS)
  }
  acknowledged() {
    this.progressed = this.now()
  }
  sent() {
    this.arm(this.now() + STALL_MS)
  }
  /** The page is shown again. */
  shown() {
    this.arm(this.now() + CATCH_UP_MS)
  }
  stop() {
    this.ended = true
    clearTimeout(this.timer)
    this.timer = undefined
  }
  private arm(at: number) {
    if (this.ended || (this.timer !== undefined && this.due <= at)) return
    clearTimeout(this.timer)
    this.due = at
    this.timer = setTimeout(() => this.check(), Math.max(0, at - this.now()))
  }
  private check() {
    this.timer = undefined
    if (!this.link.visible()) return
    const now = this.now()
    if (now - this.due > LATE_MS) {
      this.arm(now + CATCH_UP_MS)
      return
    }
    const waiting = this.link.waitingSince()
    if (waiting !== undefined) {
      const since = Math.max(waiting, this.progressed)
      if (now - since >= STALL_MS) this.link.stalled(now - waiting)
      else this.arm(since + STALL_MS)
      return
    }
    if (now - this.heard < SILENCE_MS) this.arm(this.heard + SILENCE_MS)
    else this.link.probe()
  }
}
