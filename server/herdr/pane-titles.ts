import { Events, type Subscribable } from '../channels.ts'

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
  /** The panes whose title changed. */
  readonly changes: Subscribable<ReadonlySet<string>>
}

export class PaneTitles implements PaneTitleSource {
  private readonly panes = new Map<string, { revision: number; title: string }>()
  readonly changes = new Events<ReadonlySet<string>>()

  title(paneId: string) {
    return this.panes.get(paneId)?.title
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
    if (changed.size) this.changes.emit(changed)
  }
}
