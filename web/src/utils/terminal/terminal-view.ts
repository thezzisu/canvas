import { inputKind } from '../../../../shared/log-line'

/** Keys and pastes, kept until taken so that they can be sent again. */
interface Owed {
  seq: number
  input: string
}
/**
 * Pointer input names cells of the screen it was meant for, which may have changed by the time
 * it could be sent again; focus reports are made afresh by the new channel.
 */
const resent = (data: string) => ['key', 'paste'].includes(inputKind(data))

/**
 * One view of a window for as long as the page lives, over any number of connections. It numbers
 * what it sends and keeps the input the server has yet to take.
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
  number(message: object) {
    const seq = ++this.sequence
    const { type, data } = message as { type?: unknown; data?: unknown }
    if (type === 'input' && typeof data === 'string' && resent(data))
      this.owed.push({ seq, input: data })
    return seq
  }
  /** When the stall that cost the view its last channel was seen. */
  stalledAt?: number
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
  resumed(taken: unknown): { seq: number; data: string }[] {
    this.acknowledged(taken)
    if (typeof taken !== 'number') this.owed = []
    return this.owed.map((o) => ({ seq: o.seq, data: o.input }))
  }
  /** The user left or gave up: what they typed is no longer sent again behind their back. */
  forgetInput() {
    this.owed = []
  }
}
