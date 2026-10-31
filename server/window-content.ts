import { randomUUID } from 'node:crypto'
import type { WindowContentItem, WindowContentOpen, WindowContentScan } from '../shared/window-content.ts'
import type { NativeContentPane } from './herdr/content.ts'
import type { AssetStore } from './assets.ts'
import { contentCandidates } from './content-candidates.ts'
import { readSourceFile, regularSourceFiles, type SourceFile } from './source-file.ts'
import { sourceConnectionKey, type Source, type Store } from './state.ts'
import type { DownloadContext } from './open-download.ts'

interface ScanRecord {
  sessionId: string
  sourceId: string
  sourceKey: string
  windowId: string
  scan: WindowContentScan
  expires: number
}

export interface WindowContentOptions {
  store: Store
  assets: AssetStore
  content(source: Source, spaceId: string, windowId: string): Promise<NativeContentPane[] | undefined>
  registerStaged(assetId: string, sessionId: string): string
  readFile?(source: Source, path: string, signal: AbortSignal): Promise<SourceFile>
  regularFiles?(source: Source, paths: string[], signal: AbortSignal): Promise<Map<string, string>>
}

export class WindowContentService {
  private scans = new Map<string, ScanRecord>()
  private transfers = new Map<AbortController, ScanRecord>()
  private scanning = new Map<AbortController, { sourceId: string; sourceKey: string; sessionId: string }>()
  constructor(private readonly options: WindowContentOptions) {
    options.store.on('sessions', this.invalidate)
    options.store.on('change', this.invalidate)
  }

  private invalidate = () => {
    const valid = (record: Pick<ScanRecord, 'sourceId' | 'sourceKey' | 'sessionId'>) => {
      const source = this.options.store.get<Source>('source', record.sourceId)
      return source && sourceConnectionKey(source) === record.sourceKey && this.options.store.hasSession(record.sessionId)
    }
    for (const [id, record] of this.scans) {
      if (!valid(record)) this.scans.delete(id)
    }
    for (const [controller, record] of this.transfers) if (!valid(record)) controller.abort()
    for (const [controller, record] of this.scanning) if (!valid(record)) controller.abort()
  }

  async scan(source: Source, spaceId: string, windowId: string, sessionId: string, signal = new AbortController().signal): Promise<WindowContentScan> {
    if (!this.options.store.hasSession(sessionId)) throw new Error('Please sign in')
    const sourceKey = sourceConnectionKey(source)
    const panes = await this.options.content(source, spaceId, windowId)
    const current = this.options.store.get<Source>('source', source.id)
    if (!current || sourceConnectionKey(current) !== sourceKey) throw new Error('Connection changed; scan again')
    if (!this.options.store.hasSession(sessionId)) throw new Error('Please sign in')
    if (!panes) throw new Error('Open this window before scanning its content')
    const scan = { id: randomUUID(), ...contentCandidates(panes) }
    const paths = [...new Set(scan.panes.flatMap(pane => pane.items.flatMap(item => item.kind === 'file' && item.path ? [item.path] : [])))]
    const controller = new AbortController(), abort = () => controller.abort()
    signal.throwIfAborted(); signal.addEventListener('abort', abort, { once: true })
    this.scanning.set(controller, { sourceId: source.id, sourceKey, sessionId })
    try {
      let files = new Map<string, string>()
      if (paths.length) {
        try { files = await (this.options.regularFiles || regularSourceFiles)(source, paths, controller.signal) }
        catch (error) { if (controller.signal.aborted) throw error; scan.incomplete = true }
      }
      controller.signal.throwIfAborted()
      scan.panes = scan.panes.flatMap(pane => {
        const seen = new Set<string>()
        const items = pane.items.flatMap<WindowContentItem>(item => {
          if (item.kind === 'link') return [item]
          const path = item.path && files.get(item.path)
          if (!path || seen.has(path)) return []
          seen.add(path)
          return [{ ...item, path }]
        })
        return items.length ? [{ ...pane, items }] : []
      })
    } finally {
      signal.removeEventListener('abort', abort); this.scanning.delete(controller)
    }
    for (const [id, record] of this.scans) if (record.expires <= Date.now()) this.scans.delete(id)
    if (this.scans.size >= 128) this.scans.delete(this.scans.keys().next().value!)
    this.scans.set(scan.id, { sessionId, sourceId: source.id, sourceKey, windowId, scan, expires: Date.now() + 10 * 60_000 })
    return scan
  }

  private source(record: ScanRecord): Source {
    if (!this.options.store.hasSession(record.sessionId)) throw new Error('Please sign in')
    const source = this.options.store.get<Source>('source', record.sourceId)
    if (!source || sourceConnectionKey(source) !== record.sourceKey) throw new Error('Connection changed; scan again')
    return source
  }

  async open(scanId: string, itemId: string, sessionId: string, context: DownloadContext & { position?: { x: number; y: number } }, signal: AbortSignal): Promise<WindowContentOpen | undefined> {
    const record = this.scans.get(scanId)
    if (!record || record.sessionId !== sessionId || record.expires <= Date.now()) return
    const item = record.scan.panes.flatMap(pane => pane.items).find(item => item.id === itemId)
    if (!item || item.kind !== 'file' || !item.path) return
    if ([...this.transfers.values()].filter(active => active.sourceId === record.sourceId).length >= 4)
      throw new Error('Too many file transfers; try again when one finishes')
    const source = this.source(record), controller = new AbortController()
    const abort = () => controller.abort()
    signal.throwIfAborted()
    signal.addEventListener('abort', abort, { once: true })
    this.transfers.set(controller, record)
    let file: SourceFile | undefined, upload: Awaited<ReturnType<AssetStore['begin']>> | undefined
    try {
      file = await (this.options.readFile || readSourceFile)(source, item.path, controller.signal)
      controller.signal.throwIfAborted(); this.source(record)
      upload = await this.options.assets.begin({ filename: file.filename, size: file.size })
      for await (const bytes of file.chunks) {
        controller.signal.throwIfAborted(); this.source(record)
        await upload.write(bytes)
      }
      controller.signal.throwIfAborted(); this.source(record)
      const destination = context.position ? { canvasId: context.canvasId, position: context.position }
        : { ...context, sourceId: record.sourceId, windowId: record.windowId }
      const asset = await upload.complete(destination, controller.signal)
      const id = asset.temporary ? this.options.registerStaged(asset.id, sessionId) : asset.id
      return { id, filename: asset.filename, size: asset.size, mime: asset.mime,
        temporary: asset.temporary, url: asset.temporary ? `/api/downloads/${id}` : `/api/files/${id}` }
    } catch (error) {
      await upload?.abort()
      throw error
    } finally {
      await file?.close()
      signal.removeEventListener('abort', abort)
      this.transfers.delete(controller)
    }
  }

  closeSource(sourceId: string) {
    for (const [id, record] of this.scans) if (record.sourceId === sourceId) this.scans.delete(id)
    for (const [controller, record] of this.transfers) if (record.sourceId === sourceId) controller.abort()
    for (const [controller, record] of this.scanning) if (record.sourceId === sourceId) controller.abort()
  }

  close() {
    this.options.store.off('sessions', this.invalidate)
    this.options.store.off('change', this.invalidate)
    this.scans.clear()
    for (const controller of this.transfers.keys()) controller.abort()
    for (const controller of this.scanning.keys()) controller.abort()
  }
}
