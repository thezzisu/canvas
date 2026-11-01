import { PAGE_GESTURE_IDLE_MS } from './overview-paging'

/** A wheel stream keeps its owner through momentum and moving content. */
export class WheelOwner<T> {
  private owner: T | null = null
  private last = -Infinity
  private pinch = false

  resolve(candidate: T | null, now: number, pinch = false): T | null {
    if (now - this.last > PAGE_GESTURE_IDLE_MS || pinch !== this.pinch) this.owner = candidate
    this.last = now
    this.pinch = pinch
    return this.owner
  }

  reset() { this.last = -Infinity; this.owner = null }
}
