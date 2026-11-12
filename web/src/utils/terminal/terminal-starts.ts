/**
 * Terminals start a few at a time. Creating a renderer, connecting and painting the first frame
 * is the expensive part of a card, and a canvas of many would otherwise do all of it at once.
 */
export interface TerminalStart {
  /** The terminal has painted, failed, or has nothing to paint yet: the next one may start. */
  done(): void
  /** The card left before or while it started. */
  cancel(): void
}
interface Entry {
  rank(): number
  start(): void
  handle: TerminalStart
  timer?: ReturnType<typeof setTimeout>
}

/** A rank that starts at once, whatever is already starting: the terminal the user is looking at alone. */
export const immediateStart = 0
// A place is for the work of starting, not for waiting on the network: a terminal that has not
// painted by then lets the next one start.
const startLimit = 300

export function createTerminalStarts(concurrency = 2) {
  const waiting: Entry[] = [],
    running = new Set<Entry>()
  function run(entry: Entry) {
    running.add(entry)
    entry.timer = setTimeout(() => finish(entry), startLimit)
    entry.start()
  }
  function finish(entry: Entry) {
    if (!running.delete(entry)) return
    clearTimeout(entry.timer)
    // The finished terminal paints before the next one takes the main thread.
    setTimeout(next, 0)
  }
  function next() {
    while (running.size < concurrency && waiting.length) {
      // The lowest rank now, not when it was queued: the view may have moved since.
      const ranks = waiting.map((entry) => entry.rank())
      run(waiting.splice(ranks.indexOf(Math.min(...ranks)), 1)[0]!)
    }
  }
  return {
    /** `start` may run before this returns, and receives the same handle. */
    request(rank: () => number, start: (handle: TerminalStart) => void): TerminalStart {
      const entry: Entry = {
        rank,
        start: () => start(entry.handle),
        handle: {
          done: () => finish(entry),
          cancel() {
            const index = waiting.indexOf(entry)
            if (index >= 0) waiting.splice(index, 1)
            else finish(entry)
          },
        },
      }
      if (rank() === immediateStart) run(entry)
      else {
        waiting.push(entry)
        next()
      }
      return entry.handle
    },
  }
}
export const terminalStarts = createTerminalStarts()
