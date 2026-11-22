/**
 * One view of a window for as long as the page lives, over any number of connections. It numbers
 * what it sends, and knows up to where the server has taken it.
 */
export class TerminalView {
  private attempts = 0
  private sequence = 0
  /** The server has taken every message up to this one. */
  taken = 0
  /** `id` is random, so no other page's view has it. */
  constructor(
    readonly id: string,
    /** Whether the view is maximized now, which a new channel tells the server. */
    readonly maximized: () => boolean = () => false,
  ) {}
  /** Another channel for this view: a later one is never mistaken for an earlier one. */
  attempt() {
    return ++this.attempts
  }
  number() {
    return ++this.sequence
  }
  /** Cumulative, so an acknowledgement that comes late or twice changes nothing. */
  acknowledged(sequence: unknown) {
    if (
      typeof sequence === 'number' &&
      Number.isSafeInteger(sequence) &&
      sequence > this.taken &&
      sequence <= this.sequence
    )
      this.taken = sequence
  }
}
