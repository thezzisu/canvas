import { aggregateStatus } from '../shared/status.ts'
import { isCompletionToken, sameCompletion, type CompletionToken } from '../shared/completion.ts'
import type { WindowMetadata } from '../shared/window-metadata.ts'
import { sourceConnectionKey, type Source, type Store } from './state.ts'
import type { SourceResource } from './runtimes.ts'

interface ReadRecord { id: string; connection: string; bootId: string; read: Record<string, number>; completed: Record<string, number> }
const kind = 'completion-read'

/** One single-user Canvas owns these read watermarks; browser views only acknowledge them. */
export class CompletionReads {
  private snapshots = new Map<string, { owner: object; bootId: string; revision: number; retired: Set<string> }>()
  private connections = new Map<string, string>()
  private windows = new Map<string, Map<string, WindowMetadata>>()
  private listeners = new Set<(sourceId: string) => void>()
  constructor(private readonly store: Store) {
    store.on('change', this.pruneSources)
    store.once('close', () => { store.off('change', this.pruneSources); this.listeners.clear(); this.windows.clear(); this.connections.clear(); this.snapshots.clear() })
  }
  private current(source: Source) {
    const value = this.store.get<Source>('source', source.id)
    return value && sourceConnectionKey(value) === sourceConnectionKey(source)
  }
  private record(source: Source, bootId: string) {
    const record = this.store.get<ReadRecord>(kind, source.id)
    return record?.connection === sourceConnectionKey(source) && record.bootId === bootId ? record : undefined
  }
  private pruneSources = () => {
    for (const [id, connection] of this.connections) {
      const source = this.store.get<Source>('source', id)
      if (!source || sourceConnectionKey(source) !== connection) { this.windows.delete(id); this.connections.delete(id); this.snapshots.delete(id) }
    }
    for (const record of this.store.list<ReadRecord>(kind)) {
      const source = this.store.get<Source>('source', record.id)
      if (!source || sourceConnectionKey(source) !== record.connection) {
        this.windows.delete(record.id)
        this.store.remove(kind, record.id)
      }
    }
    for (const sourceId of this.windows.keys()) if (!this.store.get('source', sourceId)) this.windows.delete(sourceId)
  }
  onRead(listener: (sourceId: string) => void) { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) } }
  observeSnapshot(source: Source, windows: WindowMetadata[], state: { bootId: string; revision: number }, owner: object) {
    if (!this.current(source)) return
    const previous = this.snapshots.get(source.id)
    if (previous?.retired.has(state.bootId) || previous?.owner === owner && previous.bootId === state.bootId && previous.revision > state.revision) return
    const retired = previous?.retired || new Set<string>()
    if (previous && previous.bootId !== state.bootId) retired.add(previous.bootId)
    if (retired.size > 8) retired.delete(retired.values().next().value!)
    this.snapshots.set(source.id, { ...state, owner, retired })
    for (const window of windows) this.observe(source, window)
    const present = new Set(windows.map(window => window.id))
    for (const id of this.windows.get(source.id)?.keys() || []) if (!present.has(id)) this.removeWindow(source, id)
    const record = this.record(source, state.bootId)
    if (record) {
      // Panes can move between windows; only a full source snapshot proves removal.
      const panes = new Set(windows.flatMap(window => window.panes.map(pane => pane.id)))
      const removed = Object.keys(record.completed).filter(id => !panes.has(id))
      if (removed.length) {
        for (const id of removed) { delete record.completed[id]; delete record.read[id] }
        this.store.put(kind, record)
      }
    }
  }
  observe(source: Source, metadata: WindowMetadata): WindowMetadata {
    if (!this.current(source) || !metadata.bootId) return metadata
    if (metadata.readAuthority === 'native') {
      this.connections.set(source.id, sourceConnectionKey(source))
      const windows = this.windows.get(source.id) || new Map<string, WindowMetadata>()
      windows.set(metadata.id, metadata); this.windows.set(source.id, windows)
      return metadata
    }
    this.connections.set(source.id, sourceConnectionKey(source))
    const previous = this.windows.get(source.id)
    const boot = previous?.values().next().value?.bootId
    if (boot && boot !== metadata.bootId) this.windows.delete(source.id)
    let record = this.record(source, metadata.bootId)
    if (!record && this.store.get(kind, source.id)) this.store.remove(kind, source.id)
    const windows = this.windows.get(source.id) || new Map<string, WindowMetadata>()
    const old = windows.get(metadata.id)
    if (old?.bootId === metadata.bootId) metadata = { ...metadata, panes: metadata.panes.map(pane => {
      const prior = old.panes.find(value => value.id === pane.id)
      return prior?.stateSequence !== undefined && pane.stateSequence !== undefined && prior.stateSequence > pane.stateSequence ? prior : pane
    }) }
    let changed = false
    for (const pane of metadata.panes) if (pane.completion && record?.completed[pane.id] !== pane.completion.sequence) {
      record ||= { id: source.id, connection: sourceConnectionKey(source), bootId: metadata.bootId!, read: {}, completed: {} }
      record.completed[pane.id] = pane.completion.sequence; changed = true
    }
    if (changed) this.store.put(kind, record!)
    metadata = this.project(source, metadata)
    windows.set(metadata.id, metadata); this.windows.set(source.id, windows)
    return metadata
  }
  project(source: Source, metadata: WindowMetadata): WindowMetadata {
    if (metadata.readAuthority === 'native') return metadata
    const record = metadata.bootId && this.record(source, metadata.bootId)
    const panes = metadata.panes.map(pane => {
      if (pane.status !== 'done' && pane.status !== 'idle') return pane
      const completion = pane.completion || (record && pane.stateSequence !== undefined && record.completed[pane.id] === pane.stateSequence
        ? { bootId: record.bootId, sequence: pane.stateSequence } : undefined)
      return completion ? { ...pane, completion, status: record && (record.read[pane.id] ?? -1) >= completion.sequence ? 'idle' as const : 'done' as const } : pane
    })
    return { ...metadata, panes, status: panes.length ? aggregateStatus(panes.map(pane => pane.status)) : metadata.status }
  }
  completion(source: Source, paneId: string): { windowId: string; completion: CompletionToken } | undefined {
    if (!this.current(source)) return
    for (const window of this.windows.get(source.id)?.values() || []) {
      const pane = window.panes.find(pane => pane.id === paneId)
      if (pane?.completion) return { windowId: window.id, completion: pane.completion }
    }
  }
  acknowledge(source: Source, windowId: string, paneId: string, token: unknown): boolean {
    if (!this.current(source) || !isCompletionToken(token)) return false
    const window = this.windows.get(source.id)?.get(windowId)
    if (window?.readAuthority === 'native') return false
    const pane = window?.panes.find(pane => pane.id === paneId)
    if (!pane?.completion || !sameCompletion(pane.completion, token)) return false
    const existing = this.record(source, token.bootId)
    if ((existing?.read[paneId] ?? -1) >= token.sequence) return false
    const record: ReadRecord = existing || { id: source.id, connection: sourceConnectionKey(source), bootId: token.bootId, read: {}, completed: { [paneId]: token.sequence } }
    record.read[paneId] = token.sequence
    this.store.put(kind, record)
    for (const listener of this.listeners) listener(source.id)
    return true
  }
  removeWindow(source: Source, windowId: string) {
    this.windows.get(source.id)?.delete(windowId)
  }
  disconnected(sourceId: string) {
    this.windows.delete(sourceId); this.connections.delete(sourceId); this.snapshots.delete(sourceId)
  }
  projectResources(source: Source, resource: SourceResource): SourceResource {
    if (source.runtime === 'core') return resource
    if (resource.status !== 'online' || resource.error || !this.current(source) || this.connections.get(source.id) !== sourceConnectionKey(source)) return resource
    const windows = this.windows.get(source.id)
    return { ...resource, spaces: resource.spaces.map(space => ({ ...space, windows: space.windows.map(window => {
      const known = windows?.get(window.id)
      if (!known) return window
      const panes = window.panes.map(pane => {
        const native = known.panes.find(value => value.id === pane.id && value.stateSequence !== undefined && value.stateSequence === pane.stateSequence)
        return native ? { ...pane, status: native.status, ...(native.completion ? { completion: native.completion } : {}) } : pane
      })
      return this.project(source, { ...window, bootId: known.bootId, panes })
    }) })) }
  }
}
