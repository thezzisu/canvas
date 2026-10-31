interface Point { pointerId: number; isPrimary: boolean; button: number; clientX: number; clientY: number }

/** A preview opens on a short tap; movement, a second pointer and cancellation remain canvas gestures. */
export class PreviewTap {
  private start?: { id: number; x: number; y: number; at: number }
  private eligible = false
  down(event: Point, now: number) {
    this.eligible = false
    if (!event.isPrimary || event.button !== 0 || this.start && this.start.id !== event.pointerId) { this.cancel(); return }
    this.start = { id: event.pointerId, x: event.clientX, y: event.clientY, at: now }
  }
  move(event: Point) {
    if (this.start && (event.pointerId !== this.start.id || Math.hypot(event.clientX - this.start.x, event.clientY - this.start.y) > 6)) this.cancel()
  }
  up(event: Point, now: number) {
    const start = this.start
    this.cancel()
    this.eligible = !!start && start.id === event.pointerId && now - start.at < 600 && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6
  }
  cancel() { this.start = undefined; this.eligible = false }
  click(detail: number) { const eligible = this.eligible || detail === 0; this.cancel(); return eligible }
}
