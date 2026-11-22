/** A line, or bytes still waiting for their newline, longer than the reader allows. */
export class LineTooLong extends Error {
  constructor() {
    super('Line is too long')
  }
}

/**
 * Splits bytes into newline-ended lines as they arrive, for the newline-delimited JSON that
 * Canvas speaks with its helpers, herdr and herdr-core. Neither a line nor what waits for its
 * newline may be longer than `max` bytes.
 */
export class LineSplitter {
  private pending: Buffer = Buffer.alloc(0)
  constructor(private readonly max: number) {}
  /** The lines this chunk completes, without their newline. Throws `LineTooLong`. */
  push(chunk: Uint8Array): Buffer[] {
    this.pending = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const lines: Buffer[] = []
    for (let end; (end = this.pending.indexOf(10)) >= 0;) {
      if (end > this.max) throw new LineTooLong()
      lines.push(this.pending.subarray(0, end))
      this.pending = this.pending.subarray(end + 1)
    }
    if (this.pending.length > this.max) throw new LineTooLong()
    return lines
  }
  /** What arrived after the last complete line. */
  get rest(): Buffer {
    return this.pending
  }
}
