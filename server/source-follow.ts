// One watch of each connection, shared by whoever follows it. While anyone does, the source's
// connections are held, so its SSH forward lasts until it breaks.
import { setTimeout as sleep } from 'node:timers/promises'
import { logIdentifier } from '../shared/log-line.ts'
import { log } from './log.ts'
import { holdConnections, onRelease } from './source-connections.ts'
import { sourceConnectionKey, type Source } from './state.ts'

interface Watch {
  refresh(): void
  close(): void
}
/** Opens a runtime's watch. It reports until closed, or until it ends. */
export type StartWatch<T> = (
  source: Source,
  handlers: { snapshot(value: T, readAt: number): void; ended(error: Error): void },
  signal: AbortSignal,
) => Promise<Watch>

export interface FollowListener<T> {
  snapshot(value: T, readAt: number): void
  /** Nothing is known of the source until its next snapshot. */
  failed(error: Error): void
}
export interface Following extends Disposable {
  refresh(): void
  /** The source's connections were released, which ends its watch for good. */
  readonly closed: boolean
}

const FIRST_RETRY_MS = 250
const LAST_RETRY_MS = 5000
const asError = (error: unknown) =>
  error instanceof Error ? error : new Error('Connection failed')

/**
 * Watches, and when the watch ends, tells the followers why at once, waits and watches again:
 * soon after a watch that read something, then each time twice as long. A refresh meanwhile
 * waits too, since every attempt may cost an SSH login.
 */
class Follower<T> {
  readonly listeners = new Set<FollowListener<T>>()
  private readonly stopping = new AbortController()
  private delay = FIRST_RETRY_MS
  /** The open watch. */
  private watch?: Watch
  /** Why there is no watch, until one reads again. */
  private failure?: Error
  constructor(
    readonly source: Source,
    start: StartWatch<T>,
  ) {
    void this.run(start)
  }
  private get name() {
    return logIdentifier(this.source.id)
  }
  private async run(start: StartWatch<T>) {
    await using _held = holdConnections(this.source)
    const { signal } = this.stopping
    while (!signal.aborted) {
      await this.watchOnce(start)
      await sleep(this.delay, undefined, { signal, ref: false }).catch(() => {})
      this.delay = Math.min(this.delay * 2, LAST_RETRY_MS)
    }
  }
  /** Resolves once a watch has opened and ended, or failed to open. */
  private watchOnce(start: StartWatch<T>) {
    const { signal } = this.stopping
    const ended = Promise.withResolvers<void>(),
      done = new AbortController()
    const end = (error?: Error) => {
      if (done.signal.aborted) return
      done.abort()
      this.watch?.close()
      this.watch = undefined
      if (error && !signal.aborted) this.failed(error)
      ended.resolve()
    }
    signal.addEventListener('abort', () => end(), { signal: done.signal })
    const handlers = {
      snapshot: (value: T, readAt: number) => {
        if (!done.signal.aborted) this.read(value, readAt)
      },
      ended: end,
    }
    start(this.source, handlers, signal).then(
      (watch) => {
        if (done.signal.aborted) return watch.close()
        this.watch = watch
        log('source', 'watch', { source: this.name, state: 'open' })
      },
      (error) => end(asError(error)),
    )
    return ended.promise
  }
  private read(value: T, readAt: number) {
    this.failure = undefined
    this.delay = FIRST_RETRY_MS
    log('source', 'watch', { source: this.name, state: 'read' })
    for (const listener of this.listeners) listener.snapshot(value, readAt)
  }
  private failed(error: Error) {
    this.failure = error
    log('source', 'watch', { source: this.name, state: 'error', retry: this.delay })
    for (const listener of this.listeners) listener.failed(error)
  }
  add(listener: FollowListener<T>) {
    this.listeners.add(listener)
    // A newcomer reads for itself: nothing that was read is kept here.
    if (this.failure) listener.failed(this.failure)
    else this.watch?.refresh()
  }
  refresh() {
    this.watch?.refresh()
  }
  get closed() {
    return this.stopping.signal.aborted
  }
  close() {
    if (this.closed) return
    this.listeners.clear()
    this.stopping.abort()
    log('source', 'watch', { source: this.name, state: 'close' })
  }
}

const followers = new Map<string, Follower<unknown>>()
onRelease((sourceId) => {
  for (const [key, follower] of followers)
    if (sourceId === undefined || follower.source.id === sourceId) {
      followers.delete(key)
      follower.close()
    }
})

/** Follows a source until disposed. `start` is the source's runtime's. */
export function followSource<T>(
  source: Source,
  start: StartWatch<T>,
  listener: FollowListener<T>,
): Following {
  const key = sourceConnectionKey(source)
  let follower = followers.get(key) as Follower<T> | undefined
  if (!follower) {
    follower = new Follower(source, start)
    followers.set(key, follower as Follower<unknown>)
  }
  const joined = follower
  joined.add(listener)
  return {
    refresh: () => joined.refresh(),
    get closed() {
      return joined.closed
    },
    [Symbol.dispose]() {
      if (!joined.listeners.delete(listener) || joined.listeners.size) return
      if (followers.get(key) === (joined as Follower<unknown>)) followers.delete(key)
      joined.close()
    },
  }
}

/** Reads a source again after Canvas changed it, for whoever follows it. */
export function refreshSource(source: Source) {
  followers.get(sourceConnectionKey(source))?.refresh()
}
