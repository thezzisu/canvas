/** While any hold is open, writes wait in order; releasing the last hold runs them. */
export class TerminalInputHold {
  private holds = 0
  private queued: Array<() => void> = []
  hold() {
    this.holds++
    let open = true
    return () => {
      if (!open) return
      open = false
      if (--this.holds) return
      const queued = this.queued
      this.queued = []
      for (const write of queued) write()
    }
  }
  write(write: () => void) {
    if (this.holds) this.queued.push(write)
    else write()
  }
}
