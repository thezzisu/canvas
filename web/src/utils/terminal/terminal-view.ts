interface Owed {
  seq: number
  at: number
  /** Input, kept until it is taken so that it can be sent again. */
  input?: string
}

/**
 * One view of a window for as long as the page lives, over any number of connections. It numbers
 * what it sends and keeps what the server has yet to take.
 */
export class TerminalView {
  private attempts = 0
  private sequence = 0
  private owed: Owed[] = []
  /** The server has taken every message up to this one. */
  taken = 0
  constructor(
    /** Random, so no other page's view has it. */
    readonly id: string,
    /** Whether the view is maximized now, which a new channel tells the server. */
    readonly maximized: () => boolean = () => false,
  ) {}
  /** Another channel for this view: a later one is never mistaken for an earlier one. */
  attempt() {
    return ++this.attempts
  }
  /** Numbers a message about to be sent. */
  number(message: object, at: number) {
    const seq = ++this.sequence
    const { type, data } = message as { type?: unknown; data?: unknown }
    this.owed.push({
      seq,
      at,
      ...(type === 'input' && typeof data === 'string' ? { input: data } : {}),
    })
    return seq
  }
  /** When the stall that cost the view its last channel was seen. */
  stalledAt?: number
  /** When a message not yet taken was sent. */
  sentAt(sequence: number): number | undefined {
    return this.owed.find((owed) => owed.seq === sequence)?.at
  }
  /** When the oldest message not yet taken was sent. */
  get waitingSince(): number | undefined {
    return this.owed[0]?.at
  }
  /** Whether it took more. Cumulative, so an ack that comes late or twice changes nothing. */
  acknowledged(sequence: unknown): boolean {
    if (
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence <= this.taken ||
      sequence > this.sequence
    )
      return false
    this.taken = sequence
    while (this.owed.length && this.owed[0]!.seq <= sequence) this.owed.shift()
    return true
  }
  /**
   * A new channel named how far the view was taken. Returns the input to send again, under its
   * old numbers and before anything new. A window that does not know the view gets none: that
   * input may have been applied, so it is lost rather than typed twice.
   */
  resumed(taken: unknown, at: number): { seq: number; data: string }[] {
    this.acknowledged(taken)
    const again = typeof taken === 'number' ? this.owed.filter((o) => o.input !== undefined) : []
    // Whatever else was owed is told afresh by the new channel's handshake.
    this.owed = again.map((o) => ({ ...o, at }))
    return again.map((o) => ({ seq: o.seq, data: o.input! }))
  }
  /** The user left or gave up: what they typed is no longer sent again behind their back. */
  forgetInput() {
    this.owed = this.owed.map(({ seq, at }) => ({ seq, at }))
  }
}
