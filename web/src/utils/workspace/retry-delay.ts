/** A wait that doubles after each failure, up to a limit, and starts over after a success. */
export class RetryDelay {
  private next: number
  constructor(
    private readonly first: number,
    private readonly limit: number,
  ) {
    this.next = first
  }
  /** The wait before the next attempt; the one after it is longer. */
  take() {
    const delay = this.next
    this.next = Math.min(this.next * 2, this.limit)
    return delay
  }
  reset() {
    this.next = this.first
  }
}
