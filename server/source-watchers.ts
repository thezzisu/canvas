// What every source lists, pushed while a browser listens. The runtimes say when to read; the
// server keeps no copy, only a digest so that a read which found nothing new is not sent.
import { createHash } from 'node:crypto'
import { Events } from './channels.ts'
import type { RuntimeListing, SourceResource } from './runtimes.ts'
import type { FollowListener, Following } from './source-follow.ts'
import { serverTime } from './server-time.ts'
import { sourceConnectionKey, type Source } from './state.ts'

/** How long the watches outlast the last browser, as an open terminal does. */
const GRACE_MS = 20_000

interface Watched {
  source: Source
  key: string
  following?: Following
  sent?: string
}

export class SourceWatchers implements Disposable {
  readonly changes = new Events<SourceResource>()
  private readonly watched = new Map<string, Watched>()
  private viewers = 0
  private running = false
  private closed = false
  private grace?: ReturnType<typeof setTimeout>
  constructor(
    private readonly options: {
      sources(): Source[]
      follow(source: Source, listener: FollowListener<RuntimeListing>): Following
      /** Adds what Canvas itself knows of the source's windows. */
      project(source: Source, resource: SourceResource): SourceResource
      graceMs?: number
    },
  ) {}

  /** A browser listens until disposed. It is sent every source as it is read now. */
  view(): Disposable {
    this.viewers++
    clearTimeout(this.grace)
    for (const entry of this.watched.values()) {
      entry.sent = undefined
      entry.following?.refresh()
    }
    if (!this.closed) {
      this.running = true
      this.sync()
    }
    let left = false
    return {
      [Symbol.dispose]: () => {
        if (left) return
        left = true
        if (--this.viewers || this.closed) return
        this.grace = setTimeout(() => this.stop(), this.options.graceMs ?? GRACE_MS)
        this.grace.unref()
      },
    }
  }
  /** The connections were edited. */
  sync() {
    if (!this.running) return
    const sources = this.options.sources()
    const present = new Set(sources.map((source) => source.id))
    for (const [id, entry] of this.watched)
      if (!present.has(id)) {
        this.watched.delete(id)
        entry.following?.[Symbol.dispose]()
      }
    for (const source of sources) {
      const key = sourceConnectionKey(source)
      const known = this.watched.get(source.id)
      if (known?.key === key) {
        const renamed = known.source.name !== source.name
        known.source = source
        if (renamed) known.following?.refresh()
        continue
      }
      known?.following?.[Symbol.dispose]()
      const entry: Watched = { source, key }
      this.watched.set(source.id, entry)
      entry.following = this.options.follow(source, {
        snapshot: (listing, readAt) =>
          this.publish(entry, { status: 'online', readAt, ...listing }),
        failed: (error) =>
          this.publish(entry, {
            status: 'offline',
            error: error.message,
            readAt: serverTime(),
            spaces: [],
          }),
      })
    }
  }
  /** Something Canvas adds to the source's listing changed. */
  refresh(sourceId: string) {
    this.watched.get(sourceId)?.following?.refresh()
  }
  private publish(entry: Watched, listed: Omit<SourceResource, 'id' | 'name'>) {
    if (this.watched.get(entry.source.id) !== entry) return
    const { source } = entry
    const resource = this.options.project(source, { id: source.id, name: source.name, ...listed })
    // When it was read is no news by itself.
    const digest = createHash('sha256')
      .update(JSON.stringify({ ...resource, readAt: 0 }))
      .digest('base64')
    if (digest === entry.sent) return
    entry.sent = digest
    this.changes.emit(resource)
  }
  private stop() {
    this.running = false
    const ending = [...this.watched.values()]
    this.watched.clear()
    for (const entry of ending) entry.following?.[Symbol.dispose]()
  }
  [Symbol.dispose]() {
    this.closed = true
    clearTimeout(this.grace)
    this.stop()
    this.changes[Symbol.dispose]()
  }
}
