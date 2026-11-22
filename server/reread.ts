import { serverTime } from './server-time.ts'

const COLLAPSE_MS = 100

/**
 * Reads again after changes are announced: a burst is one read, reads never overlap, and a
 * change announced during a read is followed by another. The first failure ends it.
 */
export class Reread implements Disposable {
  private timer?: ReturnType<typeof setTimeout>
  private reading = false
  private changed = false
  private closed = false
  constructor(
    /** `readAt` is when the read began: it holds whatever changed before then. */
    private readonly read: (readAt: number) => Promise<void>,
    private readonly failed: (error: Error) => void,
  ) {}
  /** Something changed. */
  schedule(delay = COLLAPSE_MS) {
    if (this.closed) return
    this.changed = true
    if (this.timer || this.reading) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.now()
    }, delay)
    this.timer.unref()
  }
  /** What was known may be wrong: read without waiting for more. */
  async now() {
    if (this.closed) return
    if (this.reading) {
      this.changed = true
      return
    }
    clearTimeout(this.timer)
    this.timer = undefined
    this.reading = true
    this.changed = false
    try {
      await this.read(serverTime())
    } catch (error) {
      if (!this.closed) this.failed(error instanceof Error ? error : new Error('Read failed'))
      return
    } finally {
      this.reading = false
    }
    if (this.changed) this.schedule()
  }
  [Symbol.dispose]() {
    this.closed = true
    clearTimeout(this.timer)
  }
}
