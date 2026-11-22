// One watch of each connection, shared by whoever follows it. While anyone does, the source's
// connections are held, so its SSH forward lasts until it breaks.
import { logIdentifier } from '../shared/log-line.ts'
import { log } from './log.ts'
import { holdConnections, onRelease } from './source-connections.ts'
import { sourceConnectionKey, type Source } from './state.ts'

/** Opens a runtime's watch. It reports until closed, or until it ends. */
export type StartWatch<T> = (
  source: Source,
  handlers: { snapshot(value: T, readAt: number): void; ended(error: Error): void },
  signal: AbortSignal,
) => Promise<{ refresh(): void; close(): void }>

export interface FollowListener<T> {
  snapshot(value: T, readAt: number): void
  /** Nothing is known of the source until its next snapshot. */
  failed(error: Error): void
}
export interface Following extends Disposable {
  refresh(): void
}

const FIRST_RETRY_MS = 250
const LAST_RETRY_MS = 5000

class Follower<T> {
  readonly listeners = new Set<FollowListener<T>>()
  private readonly held: AsyncDisposable
  private readonly aborted = new AbortController()
  private watch?: { refresh(): void; close(): void }
  private retry?: ReturnType<typeof setTimeout>
  private delay = FIRST_RETRY_MS
  private attempt = 0
  private failure?: Error
  constructor(
    readonly source: Source,
    private readonly start: StartWatch<T>,
  ) {
    this.held = holdConnections(source)
    void this.open()
  }
  private async open() {
    const attempt = ++this.attempt
    const current = () => !this.aborted.signal.aborted && this.attempt === attempt
    try {
      const watch = await this.start(
        this.source,
        {
          snapshot: (value, readAt) => {
            if (!current()) return
            this.failure = undefined
            this.delay = FIRST_RETRY_MS
            for (const listener of this.listeners) listener.snapshot(value, readAt)
          },
          ended: (error) => {
            if (current()) this.failed(error)
          },
        },
        this.aborted.signal,
      )
      if (!current()) {
        watch.close()
        return
      }
      this.watch = watch
      log('source', 'watch', { source: logIdentifier(this.source.id), state: 'open' })
    } catch (error) {
      if (current()) this.failed(error instanceof Error ? error : new Error('Connection failed'))
    }
  }
  private failed(error: Error) {
    this.attempt++
    this.watch?.close()
    this.watch = undefined
    this.failure = error
    log('source', 'watch', {
      source: logIdentifier(this.source.id),
      state: 'error',
      retry: this.delay,
    })
    for (const listener of this.listeners) listener.failed(error)
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.open()
    }, this.delay)
    this.retry.unref()
    this.delay = Math.min(this.delay * 2, LAST_RETRY_MS)
  }
  add(listener: FollowListener<T>) {
    this.listeners.add(listener)
    // A newcomer reads for itself: nothing that was read is kept here.
    if (this.failure) listener.failed(this.failure)
    else this.watch?.refresh()
  }
  refresh() {
    if (this.retry) {
      clearTimeout(this.retry)
      this.retry = undefined
      void this.open()
    } else this.watch?.refresh()
  }
  close() {
    if (this.aborted.signal.aborted) return
    this.aborted.abort()
    clearTimeout(this.retry)
    this.watch?.close()
    this.listeners.clear()
    log('source', 'watch', { source: logIdentifier(this.source.id), state: 'close' })
    void this.held[Symbol.asyncDispose]()
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
