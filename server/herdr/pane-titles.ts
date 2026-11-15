import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'

// The pane titles of one herdr server, as its API publishes them: `session.snapshot` and
// `pane.updated` events both carry a pane's `terminal_title_stripped` with its `revision`, and
// the newer revision wins. The endpoint snapshot of a window is not a source: herdr sends it
// only when it redraws a window fully, so its titles can be seconds old.

/** A title as shown: control characters removed, at most 1024 characters. */
export function paneTitle(value: unknown): string {
  return typeof value === 'string'
    ? Array.from(value.replace(/[\x00-\x1f\x7f-\x9f]/gu, '').trim())
        .slice(0, 1024)
        .join('')
    : ''
}

/** What `session.snapshot` and `pane.updated` say of one pane. */
export interface PaneRecord {
  pane_id?: unknown
  revision?: unknown
  terminal_title_stripped?: unknown
}

export interface PaneTitleSource {
  /** Undefined until the server has said anything of the pane. */
  title(paneId: string): string | undefined
  /** Runs with the panes whose title changed. */
  onChange(listener: (paneIds: ReadonlySet<string>) => void): { dispose(): void }
}

export class PaneTitles implements PaneTitleSource {
  private readonly panes = new Map<string, { revision: number; title: string }>()
  private readonly listeners = new Set<(paneIds: ReadonlySet<string>) => void>()

  title(paneId: string) {
    return this.panes.get(paneId)?.title
  }
  onChange(listener: (paneIds: ReadonlySet<string>) => void) {
    this.listeners.add(listener)
    return { dispose: () => void this.listeners.delete(listener) }
  }
  /** One pane's newer record. */
  update(record: PaneRecord) {
    const changed = new Set<string>()
    this.apply(record, changed)
    this.notify(changed)
  }
  /** Every pane of the server: the ones it no longer lists are gone. */
  replace(records: readonly PaneRecord[]) {
    const changed = new Set<string>(),
      present = new Set<string>()
    for (const record of records)
      if (this.apply(record, changed)) present.add(record.pane_id as string)
    for (const paneId of this.panes.keys())
      if (!present.has(paneId)) {
        this.panes.delete(paneId)
        changed.add(paneId)
      }
    this.notify(changed)
  }
  /** The server is no longer followed: what it said may be out of date. */
  clear() {
    const changed = new Set(this.panes.keys())
    this.panes.clear()
    this.notify(changed)
  }
  private apply(record: PaneRecord, changed: Set<string>): boolean {
    const { pane_id: paneId, revision } = record
    if (typeof paneId !== 'string' || !Number.isSafeInteger(revision) || (revision as number) < 0)
      return false
    const current = this.panes.get(paneId)
    if (current && current.revision > (revision as number)) return true
    const title = paneTitle(record.terminal_title_stripped)
    this.panes.set(paneId, { revision: revision as number, title })
    if (current?.title !== title) changed.add(paneId)
    return true
  }
  private notify(changed: ReadonlySet<string>) {
    if (changed.size) for (const listener of this.listeners) listener(changed)
  }
}

const MAX_LINE = 1024 * 1024

/**
 * Follows `pane.updated` on herdr's API socket. `started` runs once herdr has accepted the
 * subscription, so a snapshot read after it misses nothing; `ended` runs once, when the
 * subscription ends for any reason, including herdr reporting lost events.
 */
export function subscribePaneUpdates(
  socketPath: string,
  handlers: { started(): void; pane(record: PaneRecord): void; ended(error?: Error): void },
  options: { timeoutMs?: number } = {},
): { close(): void } {
  const id = randomUUID(),
    socket = createConnection(socketPath)
  let buffer = Buffer.alloc(0),
    started = false,
    ended = false
  const end = (error?: Error) => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    socket.destroy()
    handlers.ended(error)
  }
  const timer = setTimeout(
    () => end(new Error('Herdr did not start the pane subscription')),
    options.timeoutMs ?? 15_000,
  )
  timer.unref()
  socket.once('connect', () =>
    socket.write(
      JSON.stringify({
        id,
        method: 'events.subscribe',
        params: { subscriptions: [{ type: 'pane.updated' }] },
      }) + '\n',
    ),
  )
  socket.on('error', (error) => end(new Error(`Herdr API connection failed: ${error.message}`)))
  socket.once('end', () => end(new Error('Herdr ended the pane subscription')))
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (let index; !ended && (index = buffer.indexOf(10)) >= 0;) {
      const line = buffer.subarray(0, index).toString('utf8')
      buffer = buffer.subarray(index + 1)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        end(new Error('Invalid herdr event'))
        return
      }
      if (message?.id === id) {
        if (message.error || message.result?.type !== 'subscription_started') {
          end(new Error(`Herdr ended the pane subscription: ${message.error?.code || 'refused'}`))
          return
        }
        started = true
        clearTimeout(timer)
        handlers.started()
      } else if (started && message?.event === 'pane_updated' && message.data?.pane)
        handlers.pane(message.data.pane)
    }
    if (buffer.length > MAX_LINE) end(new Error('Herdr event is too large'))
  })
  return { close: () => end() }
}
