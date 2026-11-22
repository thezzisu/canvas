import { aggregateStatus } from '../shared/status.ts'
import { isCompletionToken, sameCompletion, type CompletionToken } from '../shared/completion.ts'
import type { WindowMetadata } from '../shared/window-metadata.ts'
import { Events } from './channels.ts'
import { sourceConnectionKey, type Source, type Store } from './state.ts'
import type { SourceResource } from './runtimes.ts'

interface ReadRecord {
  id: string
  connection: string
  bootId: string
  read: Record<string, number>
  completed: Record<string, number>
}
const kind = 'completion-read'
/** What is known of one source's windows, over the connection it was learnt on. */
interface Known {
  connection: string
  windows: Map<string, WindowMetadata>
  /** The last full snapshot taken in, and the server generations seen to end before it. */
  snapshot?: { owner: object; bootId: string; revision: number; retired: Set<string> }
}

/** One single-user Canvas owns these read watermarks; browser views only acknowledge them. */
export class CompletionReads {
  private known = new Map<string, Known>()
  /** The sources whose reads changed. */
  readonly changes = new Events<string>()
  constructor(private readonly store: Store) {
    store.on('change', this.pruneSources)
    store.once('close', () => {
      store.off('change', this.pruneSources)
      this.changes[Symbol.dispose]()
      this.known.clear()
    })
  }
  /** What is known of the source over its connection, which a new connection starts afresh. */
  private knownOf(source: Source): Known {
    const connection = sourceConnectionKey(source)
    let known = this.known.get(source.id)
    if (known?.connection !== connection)
      this.known.set(source.id, (known = { connection, windows: new Map() }))
    return known
  }
  private windowsOf(source: Source) {
    const known = this.known.get(source.id)
    return known?.connection === sourceConnectionKey(source) ? known.windows : undefined
  }
  private current(source: Source) {
    const value = this.store.get<Source>('source', source.id)
    return value && sourceConnectionKey(value) === sourceConnectionKey(source)
  }
  private record(source: Source, bootId: string) {
    const record = this.store.get<ReadRecord>(kind, source.id)
    return record?.connection === sourceConnectionKey(source) && record.bootId === bootId
      ? record
      : undefined
  }
  private pruneSources = () => {
    const connected = (id: string, connection: string) => {
      const source = this.store.get<Source>('source', id)
      return !!source && sourceConnectionKey(source) === connection
    }
    for (const [id, known] of this.known)
      if (!connected(id, known.connection)) this.known.delete(id)
    for (const record of this.store.list<ReadRecord>(kind))
      if (!connected(record.id, record.connection)) {
        this.known.get(record.id)?.windows.clear()
        this.store.remove(kind, record.id)
      }
  }
  observeSnapshot(
    source: Source,
    windows: WindowMetadata[],
    state: { bootId: string; revision: number },
    owner: object,
  ) {
    if (!this.current(source)) return
    const known = this.knownOf(source),
      previous = known.snapshot
    if (
      previous?.retired.has(state.bootId) ||
      (previous?.owner === owner &&
        previous.bootId === state.bootId &&
        previous.revision > state.revision)
    )
      return
    const retired = previous?.retired || new Set<string>()
    if (previous && previous.bootId !== state.bootId) retired.add(previous.bootId)
    if (retired.size > 8) retired.delete(retired.values().next().value!)
    known.snapshot = { ...state, owner, retired }
    for (const window of windows) this.observe(source, window)
    const present = new Set(windows.map((window) => window.id))
    for (const id of known.windows.keys()) if (!present.has(id)) known.windows.delete(id)
    const record = this.record(source, state.bootId)
    if (record) {
      // Panes can move between windows; only a full source snapshot proves removal.
      const panes = new Set(windows.flatMap((window) => window.panes.map((pane) => pane.id)))
      const removed = Object.keys(record.completed).filter((id) => !panes.has(id))
      if (removed.length) {
        for (const id of removed) {
          delete record.completed[id]
          delete record.read[id]
        }
        this.store.put(kind, record)
      }
    }
  }
  observe(source: Source, metadata: WindowMetadata): WindowMetadata {
    if (!this.current(source) || !metadata.bootId) return metadata
    const { windows } = this.knownOf(source)
    if (metadata.readAuthority === 'native') {
      windows.set(metadata.id, metadata)
      return metadata
    }
    // A server that started again knows none of the windows before.
    const boot = windows.values().next().value?.bootId
    if (boot && boot !== metadata.bootId) windows.clear()
    let record = this.record(source, metadata.bootId)
    if (!record && this.store.get(kind, source.id)) this.store.remove(kind, source.id)
    const old = windows.get(metadata.id)
    if (old?.bootId === metadata.bootId)
      metadata = {
        ...metadata,
        panes: metadata.panes.map((pane) => {
          const prior = old.panes.find((value) => value.id === pane.id)
          return prior?.stateSequence !== undefined &&
            pane.stateSequence !== undefined &&
            prior.stateSequence > pane.stateSequence
            ? prior
            : pane
        }),
      }
    let changed = false
    for (const pane of metadata.panes)
      if (pane.completion && record?.completed[pane.id] !== pane.completion.sequence) {
        record ||= {
          id: source.id,
          connection: sourceConnectionKey(source),
          bootId: metadata.bootId!,
          read: {},
          completed: {},
        }
        record.completed[pane.id] = pane.completion.sequence
        changed = true
      }
    if (changed) this.store.put(kind, record!)
    metadata = this.project(source, metadata)
    windows.set(metadata.id, metadata)
    return metadata
  }
  project(source: Source, metadata: WindowMetadata): WindowMetadata {
    if (metadata.readAuthority === 'native') return metadata
    const record = metadata.bootId && this.record(source, metadata.bootId)
    const panes = metadata.panes.map((pane) => {
      if (pane.status !== 'done' && pane.status !== 'idle') return pane
      const completion =
        pane.completion ||
        (record &&
        pane.stateSequence !== undefined &&
        record.completed[pane.id] === pane.stateSequence
          ? { bootId: record.bootId, sequence: pane.stateSequence }
          : undefined)
      return completion
        ? {
            ...pane,
            completion,
            status:
              record && (record.read[pane.id] ?? -1) >= completion.sequence
                ? ('idle' as const)
                : ('done' as const),
          }
        : pane
    })
    return {
      ...metadata,
      panes,
      status: panes.length ? aggregateStatus(panes.map((pane) => pane.status)) : metadata.status,
    }
  }
  completion(
    source: Source,
    paneId: string,
  ): { windowId: string; completion: CompletionToken } | undefined {
    if (!this.current(source)) return
    for (const window of this.windowsOf(source)?.values() || []) {
      const pane = window.panes.find((pane) => pane.id === paneId)
      if (pane?.completion) return { windowId: window.id, completion: pane.completion }
    }
  }
  acknowledge(source: Source, windowId: string, paneId: string, token: unknown): boolean {
    if (!this.current(source) || !isCompletionToken(token)) return false
    const window = this.windowsOf(source)?.get(windowId)
    if (window?.readAuthority === 'native') return false
    const pane = window?.panes.find((pane) => pane.id === paneId)
    if (!pane?.completion || !sameCompletion(pane.completion, token)) return false
    const existing = this.record(source, token.bootId)
    if ((existing?.read[paneId] ?? -1) >= token.sequence) return false
    const record: ReadRecord = existing || {
      id: source.id,
      connection: sourceConnectionKey(source),
      bootId: token.bootId,
      read: {},
      completed: { [paneId]: token.sequence },
    }
    record.read[paneId] = token.sequence
    this.store.put(kind, record)
    this.changes.emit(source.id)
    return true
  }
  removeWindow(source: Source, windowId: string) {
    this.windowsOf(source)?.delete(windowId)
  }
  disconnected(sourceId: string) {
    this.known.delete(sourceId)
  }
  projectResources(source: Source, resource: SourceResource): SourceResource {
    if (source.runtime === 'hc') return resource
    const windows = this.windowsOf(source)
    if (resource.status !== 'online' || resource.error || !this.current(source) || !windows)
      return resource
    return {
      ...resource,
      spaces: resource.spaces.map((space) => ({
        ...space,
        windows: space.windows.map((window) => {
          const known = windows.get(window.id)
          if (!known) return window
          const panes = window.panes.map((pane) => {
            const native = known.panes.find(
              (value) =>
                value.id === pane.id &&
                value.stateSequence !== undefined &&
                value.stateSequence === pane.stateSequence,
            )
            return native
              ? {
                  ...pane,
                  status: native.status,
                  ...(native.completion ? { completion: native.completion } : {}),
                }
              : pane
          })
          return this.project(source, { ...window, bootId: known.bootId, panes })
        }),
      })),
    }
  }
}
