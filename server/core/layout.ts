import { randomUUID } from 'node:crypto'
import type { PaneAction } from '../../shared/pane-context.ts'
import { aggregateStatus, type ProgramStatus } from '../../shared/status.ts'
import type { WindowMetadata } from '../../shared/window-metadata.ts'
import type { PaneSurfaceSplit, SurfaceRect } from '../herdr/wire.ts'

export interface CoreApi {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
}
export interface CoreTerminal {
  address: string
  name?: string | null
  labels: Record<string, string>
  status?: { state: string; app?: string; title?: string; msg?: string } | null
  turn: number
  state: string
  cols: number
  rows: number
  cwd: string
  foreground?: { cwd?: string; name?: string; argv?: string[] } | null
  title?: string
  reason?: string | null
  [key: string]: unknown
}
export interface CoreNode {
  id: string
  type: string
  content?: { terminal?: string; mod?: string; [key: string]: unknown }
  children?: CoreNode[]
  floating?: Array<{ id: string; content: CoreNode['content']; edge?: string; hidden?: boolean; [key: string]: unknown }>
  active?: string
  title?: string
  hidden?: boolean
  size?: { px?: number; weight?: number }
  [key: string]: unknown
}
export interface CoreTab { id: string; name: string; root: CoreNode; machine?: string; synthetic?: boolean; [key: string]: unknown }
export interface CoreSpace { id: string; name: string; folder: string; tabs: CoreTab[]; machine?: string; synthetic?: boolean; [key: string]: unknown }
export interface CoreDocument { spaces: CoreSpace[]; [key: string]: unknown }
export interface CoreDocumentState { on?: string; value: CoreDocument; version: number }
export interface CoreSnapshot {
  coreId: string
  version: string
  document: CoreDocument
  documentVersion: number
  documents: CoreDocumentState[]
  terminals: CoreTerminal[]
  spaces: CoreSpace[]
}
export interface CorePane { id: string; terminal?: string; title?: string; node: CoreNode }
export interface ProjectedCorePane { id: string; terminal?: string; title?: string; unsupported?: string; rect: SurfaceRect }
export interface CoreProjection { panes: ProjectedCorePane[]; splits: PaneSurfaceSplit[] }

const UNPLACED = 'core:unplaced'
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const clone = <T>(value: T): T => structuredClone(value)
const qualify = (id: string, machine?: string) => machine ? `${machine}/${id}` : id
const local = (id: string, machine?: string) => machine && id.startsWith(machine + '/') ? id.slice(machine.length + 1) : id
const pathIndex = (index: number): boolean[] => [...Array<boolean>(index).fill(true), false]
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\x00-\x1f\x7f]/u.test(value) }
function label(value: string): string {
  const result = value.trim()
  if (result.length > 100 || /[\x00-\x1f\x7f]/u.test(result)) throw new Error('Name must contain at most 100 characters without control characters')
  return result
}
function validateNode(value: unknown, ids: Set<string>, depth = 0): asserts value is CoreNode {
  if (!object(value) || !validId(value.id) || typeof value.type !== 'string' || depth > 64 || ids.size >= 4096 || ids.has(value.id)) throw new Error('Unsupported herdr-app layout node')
  ids.add(value.id)
  if (value.type === 'block' && !object(value.content)) throw new Error('Invalid herdr-app block')
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) throw new Error('Invalid herdr-app layout children')
    for (const child of value.children) validateNode(child, ids, depth + 1)
  }
  if (value.floating !== undefined) {
    if (!Array.isArray(value.floating)) throw new Error('Invalid herdr-app floating blocks')
    for (const item of value.floating) {
      if (!object(item) || !validId(item.id) || !object(item.content) || ids.has(item.id)) throw new Error('Invalid herdr-app floating block')
      ids.add(item.id)
    }
  }
}

/** Keep the opaque document intact. Validating understood fields never drops unknown ones. */
export function parseDocument(value: unknown): CoreDocument {
  if (value === null || value === undefined) return { spaces: [] }
  if (!object(value) || value.spaces !== undefined && !Array.isArray(value.spaces)) throw new Error('Invalid herdr-app document')
  const doc = clone(value) as unknown as CoreDocument
  doc.spaces ??= []
  const ids = new Set<string>()
  const resources = new Set<string>()
  for (const space of doc.spaces) {
    if (!object(space) || !validId(space.id) || resources.has(space.id) || !Array.isArray(space.tabs)) throw new Error('Invalid herdr-app space')
    resources.add(space.id)
    space.name = text(space.name)
    space.folder = text(space.folder)
    for (const tab of space.tabs) {
      if (!object(tab) || !validId(tab.id) || resources.has(tab.id)) throw new Error('Invalid herdr-app tab')
      resources.add(tab.id)
      tab.name = text(tab.name)
      validateNode(tab.root, ids)
    }
  }
  return doc
}

export function panes(tab: CoreTab): CorePane[] {
  const result: CorePane[] = []
  const walk = (node: CoreNode) => {
    if (node.type === 'block' || !['row', 'column', 'stack'].includes(node.type)) result.push({ id: node.id, terminal: localTerminal(node.content?.terminal), title: node.title, node })
    for (const child of node.children || []) walk(child)
    for (const item of node.floating || []) result.push({ id: item.id, terminal: localTerminal(item.content?.terminal), node: { ...item, type: 'block' } })
  }
  walk(tab.root)
  return result
}

function localTerminal(value: unknown): string | undefined {
  return validId(value) && !value.includes('/') ? value : undefined
}

function qualifiedDocument(doc: CoreDocument, machine?: string): CoreSpace[] {
  const result = clone(doc.spaces)
  const walk = (node: CoreNode) => {
    node.id = qualify(node.id, machine)
    if (typeof node.content?.terminal === 'string') node.content.terminal = qualify(node.content.terminal, machine)
    if (node.active) node.active = qualify(node.active, machine)
    for (const item of node.floating || []) { item.id = qualify(item.id, machine); if (typeof item.content?.terminal === 'string') item.content.terminal = qualify(item.content.terminal, machine) }
    for (const child of node.children || []) walk(child)
  }
  for (const space of result) {
    space.id = qualify(space.id, machine); space.machine = machine
    for (const tab of space.tabs) { tab.id = qualify(tab.id, machine); tab.machine = machine; walk(tab.root) }
  }
  return result
}

/** Layout projection is separate from the ordered native terminal mirror. */
export function projectCoreSnapshot(snapshot: Omit<CoreSnapshot, 'spaces'>): CoreSnapshot {
  const spaces = snapshot.documents.flatMap(item => qualifiedDocument(item.value, item.on))
  const placed = new Set(spaces.flatMap(space => space.tabs.flatMap(tab => panes(tab).flatMap(pane => pane.terminal ? [pane.terminal] : []))))
  const unplaced = snapshot.terminals.filter(item => item.state === 'live' && !placed.has(item.address))
  if (unplaced.length) {
    const tabs = unplaced.map(item => ({ id: item.address, name: item.name || item.title || item.address,
      root: { id: item.address, type: 'row', children: [terminalNode(item.address, `core-pane:${item.address}`)] }, synthetic: true }))
    const existing = spaces.find(space => space.id === UNPLACED)
    if (existing) existing.tabs.push(...tabs)
    else spaces.push({ id: UNPLACED, name: 'Terminals', folder: '', synthetic: true, tabs })
  }
  return { ...snapshot, spaces }
}

export function coreStatus(terminal?: CoreTerminal): ProgramStatus {
  const word = terminal?.status?.state
  if (!word) return 'unknown'
  if (word === 'blocked') return 'attention'
  if (word === 'error') return 'error'
  if (word === 'working') return 'working'
  const seen = terminal?.labels['herdr.seen']
  if (seen !== undefined && /^\d+$/u.test(seen)) return terminal!.turn > Number(seen) ? 'done' : 'idle'
  return word === 'done' || terminal!.turn > 0 ? 'done' : 'idle'
}

export function coreWindowMetadata(snapshot: CoreSnapshot, tabId: string, focusedPane?: string): WindowMetadata | undefined {
  const space = snapshot.spaces.find(space => space.tabs.some(tab => tab.id === tabId))
  const tab = space?.tabs.find(tab => tab.id === tabId)
  if (!tab) return
  const all = panes(tab)
  const metadata = all.map((pane, index) => {
    const terminal = snapshot.terminals.find(item => item.address === pane.terminal)
    const status = coreStatus(terminal)
    const turn = terminal?.turn ?? 0
    return { id: pane.id, name: pane.title || terminal?.name || pane.terminal || `Pane ${index + 1}`,
      active: pane.id === (focusedPane || all[0]?.id), status,
      ...(pane.terminal ? { terminalId: pane.terminal } : {}),
      ...(terminal?.status?.app ? { agent: terminal.status.app } : {}),
      terminalTitle: terminal?.title || '', stateSequence: turn,
      ...((status === 'done' || status === 'idle') && turn > 0 ? { completion: { bootId: snapshot.coreId, sequence: turn } } : {}) }
  })
  return { id: tab.id, name: tab.name || String(space!.tabs.indexOf(tab) + 1), bootId: snapshot.coreId, readAuthority: 'native', panes: metadata, status: aggregateStatus(metadata.map(pane => pane.status)) }
}

/** Project shared structure into cells; app pixel decoration stays presentation-local. */
export function projectTab(tab: CoreTab, cols: number, rows: number, zoomedPane?: string): CoreProjection {
  const result: CoreProjection = { panes: [], splits: [] }
  const bounds = { x: 0, y: 0, width: cols, height: rows }
  const found = zoomedPane && panes(tab).find(pane => pane.id === zoomedPane)
  const walk = (node: CoreNode, rect: SurfaceRect, path: boolean[] = []) => {
    if (node.hidden || rect.width < 1 || rect.height < 1) return
    const entries = (node.children || []).flatMap((child, index) => child.hidden ? [] : [{ child, index }])
    const children = entries.map(item => item.child)
    if (node.type === 'row' || node.type === 'column') {
      const horizontal = node.type === 'row', total = horizontal ? rect.width : rect.height
      const count = Math.min(children.length, Math.floor((total + 1) / 2))
      const shown = children.slice(0, count)
      const available = Math.max(count, total - Math.max(0, count - 1))
      const weights = shown.map(child => Math.max(0.01, Number(child.size?.weight) || 1))
      const sum = weights.reduce((a, b) => a + b, 0)
      let offset = 0, used = 0
      for (const [index, child] of shown.entries()) {
        const next = index === count - 1 ? available : Math.max(used + 1, Math.min(available - (count - index - 1), Math.round(available * weights.slice(0, index + 1).reduce((a, b) => a + b, 0) / sum)))
        const extent = next - used
        const childRect = horizontal ? { ...rect, x: rect.x + offset, width: extent } : { ...rect, y: rect.y + offset, height: extent }
        const childPath = [...path, ...pathIndex(entries[index]!.index)]
        walk(child, childRect, childPath)
        offset += extent; used = next
        if (index < count - 1) {
          const hit = horizontal ? { x: rect.x + offset, y: rect.y, width: 1, height: rect.height } : { x: rect.x, y: rect.y + offset, width: rect.width, height: 1 }
          result.splits.push({ direction: horizontal ? 'Horizontal' : 'Vertical', pos: horizontal ? hit.x : hit.y, area: rect, hit_rect: hit, path: childPath })
          offset++
        }
      }
    } else if (node.type === 'stack') {
      const active = children.find(child => child.id === node.active) || children[0]
      if (active) walk(active, rect, [...path, ...pathIndex((node.children || []).indexOf(active))])
    } else {
      const terminal = localTerminal(node.content?.terminal)
      result.panes.push({ id: node.id, ...(terminal ? { terminal } : {}), title: node.title,
        ...(!terminal ? { unsupported: typeof node.content?.terminal === 'string' ? 'Connect this machine as a separate Canvas SSH source' : typeof node.content?.mod === 'string' ? `Herdr mod: ${node.content.mod}` : `Unsupported Herdr block: ${node.type}` } : {}), rect })
    }
    for (const item of node.floating || []) {
      if (item.hidden) continue
      const side = item.edge === 'left' || item.edge === 'right' || !item.edge
      const width = side ? Math.max(1, Math.floor(rect.width / 2)) : rect.width
      const height = side ? rect.height : Math.max(1, Math.floor(rect.height / 2))
      const floating = { x: rect.x + (item.edge === 'right' || !item.edge ? rect.width - width : 0), y: rect.y + (item.edge === 'bottom' ? rect.height - height : 0), width, height }
      walk({ ...item, type: 'block' }, floating, path)
    }
  }
  if (found) walk({ ...found.node, hidden: false, floating: [] }, bounds)
  else walk(tab.root, bounds)
  return result
}

function rpcKind(error: unknown): string | undefined {
  if (!object(error)) return
  if (typeof error.kind === 'string') return error.kind
  if (object(error.data) && typeof error.data.kind === 'string') return error.data.kind
  if (object(error.error)) return rpcKind(error.error)
}
function conflict(error: unknown): boolean { return rpcKind(error) === 'conflict' }
const changed = () => new Error('Herdr layout changed; refresh and try again')
function nodeAt(root: CoreNode, id: string): CoreNode | undefined {
  if (root.id === id) return root
  for (const child of root.children || []) { const found = nodeAt(child, id); if (found) return found }
  for (const item of root.floating || []) if (item.id === id) return item as unknown as CoreNode
}
function removeNode(root: CoreNode, id: string): boolean {
  const before = root.children?.length
  if (root.children) root.children = root.children.filter(child => child.id !== id)
  if (root.children?.length !== before) return true
  const floats = root.floating?.length
  if (root.floating) root.floating = root.floating.filter(child => child.id !== id)
  if (root.floating?.length !== floats) return true
  const removed = (root.children || []).some(child => removeNode(child, id))
  if (removed && root.children) root.children = root.children.filter(child => !['row', 'column', 'stack'].includes(child.type) || (child.children?.length || 0) > 0 || (child.floating?.length || 0) > 0)
  return removed
}
function terminalNode(address: string, id = `p-${randomUUID()}`): CoreNode { return { id, type: 'block', content: { terminal: address } } }
function tabNode(id: string, name: string, address: string): CoreTab { return { id, name, root: { id, type: 'row', children: [terminalNode(address)] } } }

export class CoreLayout {
  constructor(readonly rpc: CoreApi) {}

  private async document(on?: string): Promise<CoreDocumentState> {
    const response = await this.rpc.call('doc.get', { name: 'herdr-app', ...(on ? { on } : {}) })
    if (!Number.isSafeInteger(response.version) || Number(response.version) < 0) throw new Error('Invalid core document version')
    return { on, value: parseDocument(response.value), version: Number(response.version) }
  }

  async snapshot(terminalSnapshot?: readonly Record<string, unknown>[]): Promise<CoreSnapshot> {
    const [status, list, document] = await Promise.all([this.rpc.call('server.status', {}),
      terminalSnapshot ? Promise.resolve({ terminals: terminalSnapshot }) : this.rpc.call('terminal.list', { all: true }), this.document()])
    if (!object(status.core) || !validId(status.core.id) || typeof status.version !== 'string' || !Array.isArray(list.terminals)) throw new Error('Invalid herdr-core snapshot')
    const terminals = list.terminals.filter(object).filter(value => typeof value.address === 'string' && !value.address.includes('/')).map(value => {
      if (!validId(value.address) || typeof value.state !== 'string' || !object(value.labels)) throw new Error('Invalid core terminal record')
      return { ...value, turn: Number.isSafeInteger(value.turn) && Number(value.turn) >= 0 ? Number(value.turn) : 0,
        labels: Object.fromEntries(Object.entries(value.labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } as CoreTerminal
    })
    return projectCoreSnapshot({ coreId: status.core.id, version: status.version,
      document: document.value, documentVersion: document.version, documents: [document], terminals })
  }

  resources(snapshot: CoreSnapshot) {
    return snapshot.spaces.map(space => ({ id: space.id, name: space.name || this.spaceName(snapshot, space),
      windows: space.tabs.map(tab => coreWindowMetadata(snapshot, tab.id)!).map(window => ({ id: window.id, name: window.name, status: window.status, panes: window.panes })) }))
  }

  private spaceName(snapshot: CoreSnapshot, space: CoreSpace): string {
    const address = space.tabs.flatMap(tab => panes(tab)).find(pane => pane.terminal)?.terminal
    const terminal = snapshot.terminals.find(item => item.address === address)
    const folder = terminal?.foreground?.cwd || terminal?.cwd || space.folder
    return folder.split(/[\\/]/u).filter(Boolean).at(-1) || space.id
  }

  findWindow(snapshot: CoreSnapshot, spaceId: string, tabId: string): CoreTab {
    const tab = snapshot.spaces.find(space => space.id === spaceId)?.tabs.find(tab => tab.id === tabId)
    if (!tab) throw new Error('Window no longer belongs to this space; refresh the overview')
    return tab
  }

  private async write(on: string | undefined, update: (doc: CoreDocument) => void | boolean, authorized = () => true): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.document(on)
      const changed = update(current.value)
      if (!authorized()) throw new Error('Core operation was cancelled')
      if (changed === false) return
      try { await this.rpc.call('doc.set', { name: 'herdr-app', value: current.value, version: current.version, ...(on ? { on } : {}) }); return }
      catch (error) { if (!conflict(error) || attempt === 2) throw error }
    }
  }

  /** A final native exit removes its pane from the shared app document, not its
   * retained terminal record. Identity checks make delayed/duplicate events safe. */
  async reconcileClosedPanes(spaceId: string, tabId: string, expected: readonly { id: string; terminal: string }[], authorized = () => true): Promise<void> {
    if (!expected.length) return
    try {
      await this.write(undefined, doc => {
        const space = doc.spaces.find(space => space.id === spaceId), tab = space?.tabs.find(tab => tab.id === tabId)
        if (!space || !tab) return false
        let removed = false
        for (const target of expected) {
          const node = nodeAt(tab.root, target.id)
          if (!node || localTerminal(node.content?.terminal) !== target.terminal) continue
          if (tab.root.id === node.id) tab.root = { id: tab.id, type: 'row', children: [] }
          else if (!removeNode(tab.root, node.id)) continue
          removed = true
        }
        if (!removed) return false
        if (!panes(tab).length) space.tabs = space.tabs.filter(item => item !== tab)
        if (!space.tabs.length) doc.spaces = doc.spaces.filter(item => item !== space)
      }, authorized)
    } catch (error) {
      // A lost acknowledgement is not a failed write. Confirm only the target
      // identities, without retrying the mutation or touching native records.
      try {
        const current = await this.document()
        const tab = current.value.spaces.find(space => space.id === spaceId)?.tabs.find(tab => tab.id === tabId)
        if (!tab || expected.every(target => localTerminal(nodeAt(tab.root, target.id)?.content?.terminal) !== target.terminal)) return
      } catch { /* Preserve the original error if the outcome is still unknown. */ }
      throw error
    }
  }

  private target(snapshot: CoreSnapshot, spaceId: string, tabId?: string): { on?: string; space: CoreSpace; tab?: CoreTab } {
    const space = snapshot.spaces.find(space => space.id === spaceId)
    if (!space) throw changed()
    const tab = tabId === undefined ? undefined : this.findWindow(snapshot, spaceId, tabId)
    return { on: space.machine, space, tab }
  }

  private async start(cwd?: string, on?: string): Promise<string> {
    const result = await this.rpc.call('terminal.run', { argv: [], ...(cwd ? { cwd } : {}), ...(on ? { on } : {}),
      keep: true, no_parent: true, wait: false, labels: { 'herdr.seen': '0' } })
    const address = typeof result.address === 'string' ? result.address : object(result.terminal) ? result.terminal.address : undefined
    if (!validId(address)) throw new Error('Core did not return the created terminal address')
    return address
  }

  private async born(address: string, spaceId: string, tabId: string, on?: string): Promise<void> {
    // The committed document is authoritative. These discovery hints are redundant;
    // losing their acknowledgement must not make the UI repeat a successful create.
    try { await this.rpc.call('terminal.label', { terminal: address, labels: { 'herdr.space': local(spaceId, on), 'herdr.tab': local(tabId, on) } }) }
    catch { /* the next document snapshot still identifies the created terminal */ }
  }

  private async materialize(tab: CoreTab, authorized = () => true): Promise<void> {
    if (!tab.synthetic) return
    await this.write(undefined, doc => {
      let space = doc.spaces.find(item => item.id === UNPLACED)
      if (!space) { space = { id: UNPLACED, name: 'Terminals', folder: '', tabs: [] }; doc.spaces.push(space) }
      const existing = space.tabs.find(item => item.id === tab.id)
      if (existing) {
        if (JSON.stringify(panes(existing).map(item => item.terminal)) !== JSON.stringify(panes(tab).map(item => item.terminal))) throw changed()
        return
      }
      const value = clone(tab)
      delete value.synthetic; delete value.machine
      space.tabs.push(value)
    }, authorized)
  }

  private async discard(address: string, error: unknown): Promise<never> {
    // A failed reply does not prove a failed write. Never stop a terminal whose
    // successful layout save (or another client's adoption) we can still observe.
    let document: CoreDocumentState
    try { document = await this.document() }
    catch { throw new Error(`Layout save outcome is unknown; terminal ${address} is preserved. Reconnect and inspect Terminals before retrying.`) }
    if (document.value.spaces.some(space => space.tabs.some(tab => panes(tab).some(pane => pane.terminal === address)))) throw new Error(`Layout save outcome is uncertain; terminal ${address} is preserved in the shared layout. Refresh before retrying.`)
    // Only the freshly created and confirmed unreferenced terminal is eligible.
    try { await this.rpc.call('terminal.kill', { terminal: address }) }
    catch { throw new Error(`Layout could not be saved; terminal ${address} remains running and is listed in Terminals. ${error instanceof Error ? error.message : 'Try again after refreshing.'}`) }
    throw error
  }

  private async committed(on: string | undefined, tabId: string, address: string): Promise<boolean> {
    try { return (await this.document(on)).value.spaces.some(space => space.tabs.some(tab => tab.id === local(tabId, on) && panes(tab).some(pane => pane.terminal === local(address, on)))) }
    catch { return false }
  }

  async createSpace(name = '', sourceSpaceId?: string): Promise<{ spaceId: string; windowId: string }> {
    name = label(name)
    const snapshot = await this.snapshot()
    const source = sourceSpaceId ? this.target(snapshot, sourceSpaceId).space : undefined
    const on = source?.machine, id = `s-${randomUUID()}`, tab = `t-${randomUUID()}`
    const address = await this.start(source?.folder || undefined, on)
    try { await this.write(on, doc => { doc.spaces.push({ id, name: label(name), folder: source?.folder || '', tabs: [tabNode(tab, '', local(address, on))] }) }) }
    catch (error) { if (!await this.committed(on, tab, address)) return this.discard(address, error) }
    await this.born(address, id, tab, on)
    return { spaceId: qualify(id, on), windowId: qualify(tab, on) }
  }

  async createWindow(spaceId: string, name = ''): Promise<{ spaceId: string; windowId: string }> {
    name = label(name)
    const snapshot = await this.snapshot(), { space, on } = this.target(snapshot, spaceId)
    const id = `t-${randomUUID()}`, address = await this.start(space.folder || undefined, on)
    try { await this.write(on, doc => { let target = doc.spaces.find(item => item.id === local(spaceId, on)); if (!target && space.synthetic) { target = { id: spaceId, name: space.name, folder: space.folder, tabs: [] }; doc.spaces.push(target) }; if (!target) throw changed(); target.tabs.push(tabNode(id, name, local(address, on))) }) }
    catch (error) { if (!await this.committed(on, id, address)) return this.discard(address, error) }
    await this.born(address, spaceId, id, on)
    return { spaceId, windowId: qualify(id, on) }
  }

  async renameSpace(spaceId: string, name: string): Promise<void> {
    const { space, on } = this.target(await this.snapshot(), spaceId)
    if (space.synthetic) for (const tab of space.tabs) await this.materialize(tab)
    await this.write(on, doc => { const target = doc.spaces.find(item => item.id === local(spaceId, on)); if (!target) throw changed(); target.name = label(name) })
  }

  async renameWindow(spaceId: string, tabId: string, name: string): Promise<void> {
    const { tab, on } = this.target(await this.snapshot(), spaceId, tabId)
    if (tab!.synthetic) await this.materialize(tab!)
    await this.write(on, doc => { const target = doc.spaces.find(item => item.id === local(spaceId, on))?.tabs.find(item => item.id === local(tabId, on)); if (!target) throw changed(); target.name = label(name) })
  }

  private async endRemoved(addresses: string[]): Promise<void> {
    const latest = await this.snapshot()
    const retained = new Set(latest.spaces.filter(space => !space.synthetic).flatMap(space => space.tabs.flatMap(tab => panes(tab).flatMap(pane => pane.terminal ? [pane.terminal] : []))))
    const failures: string[] = []
    for (const address of new Set(addresses)) {
      if (retained.has(address) || !latest.terminals.some(item => item.address === address && item.state === 'live')) continue
      try { await this.rpc.call('terminal.kill', { terminal: address }) }
      catch {
        // An exit racing our kill is still a confirmed close. A lost reply alone is not.
        try {
          const result = await this.rpc.call('terminal.get', { terminal: address })
          const record = object(result.terminal) ? result.terminal : result
          if (record.state === 'live') failures.push(address)
        } catch (error) { if (rpcKind(error) !== 'not_found') failures.push(address) }
      }
    }
    if (failures.length) throw new Error(`Layout was closed, but these terminals could not be stopped and remain in Terminals: ${failures.join(', ')}`)
  }

  async closeSpace(spaceId: string): Promise<string[]> {
    const snapshot = await this.snapshot(), { space, on } = this.target(snapshot, spaceId)
    const original = space.tabs.map(tab => tab.id), addresses = space.tabs.flatMap(tab => panes(tab).flatMap(pane => pane.terminal ? [pane.terminal] : []))
    if (space.synthetic) throw new Error('Close individual ungrouped terminals instead')
    const originalValue = snapshot.documents.find(item => item.on === on)!.value.spaces.find(item => item.id === local(spaceId, on))!
    await this.write(on, doc => {
      const index = doc.spaces.findIndex(item => item.id === local(spaceId, on)); if (index < 0) throw changed()
      const current = doc.spaces[index]!
      if (JSON.stringify(current.tabs) !== JSON.stringify(originalValue.tabs)) throw changed()
      doc.spaces.splice(index, 1)
    })
    await this.endRemoved(addresses)
    return original
  }

  async closeWindow(spaceId: string, tabId: string): Promise<void> {
    const snapshot = await this.snapshot(), { tab, on } = this.target(snapshot, spaceId, tabId)
    const addresses = panes(tab!).flatMap(pane => pane.terminal ? [pane.terminal] : [])
    const baseline = snapshot.documents.find(item => item.on === on)?.value.spaces.find(item => item.id === local(spaceId, on))?.tabs.find(item => item.id === local(tabId, on))
    if (!tab!.synthetic) await this.write(on, doc => {
      const space = doc.spaces.find(item => item.id === local(spaceId, on)), index = space?.tabs.findIndex(item => item.id === local(tabId, on)) ?? -1
      if (!space || index < 0) throw changed()
      if (JSON.stringify(space.tabs[index]) !== JSON.stringify(baseline)) throw changed()
      space.tabs.splice(index, 1)
      if (!space.tabs.length) doc.spaces = doc.spaces.filter(item => item !== space)
    })
    await this.endRemoved(addresses)
  }

  async paneAction(spaceId: string, tabId: string, paneId: string, action: PaneAction, authorized = () => true): Promise<CoreSnapshot> {
    const snapshot = await this.snapshot(), { tab, space, on } = this.target(snapshot, spaceId, tabId)
    const original = panes(tab!).find(pane => pane.id === paneId)
    if (!original) throw changed()
    if (!authorized()) throw new Error('Core operation was cancelled')
    if (action.action === 'zoom') return snapshot
    if (tab!.synthetic) {
      await this.materialize(tab!, authorized)
      return this.paneAction(spaceId, tabId, paneId, action, authorized)
    }
    const id = `p-${randomUUID()}`
    const address = action.action === 'split-right' || action.action === 'split-down' ? await this.start(snapshot.terminals.find(item => item.address === original.terminal)?.foreground?.cwd || space.folder || undefined, on) : undefined
    try {
      await this.write(on, doc => {
        const currentSpace = doc.spaces.find(item => item.id === local(spaceId, on)), currentTab = currentSpace?.tabs.find(item => item.id === local(tabId, on))
        const node = currentTab && nodeAt(currentTab.root, local(paneId, on))
        if (!currentTab || !node || qualify(text(node.content?.terminal), on) !== (original.terminal || qualify('', on))) throw changed()
        if (action.action === 'rename') node.title = label(action.name)
        else if (action.action === 'close') {
          if (currentTab.root.id === node.id) currentTab.root = { id: currentTab.id, type: 'row', children: [] }
          else if (!removeNode(currentTab.root, node.id)) throw changed()
          if (!panes(currentTab).length) currentSpace!.tabs = currentSpace!.tabs.filter(item => item !== currentTab)
          if (!currentSpace!.tabs.length) doc.spaces = doc.spaces.filter(item => item !== currentSpace)
        } else {
          if (node.type !== 'block') throw new Error('This Herdr layout cannot be split here')
          const old = clone(node)
          Object.keys(node).forEach(key => { delete node[key] })
          Object.assign(node, { id: `split-${randomUUID()}`, type: action.action === 'split-right' ? 'row' : 'column', children: [old, terminalNode(local(address!, on), id)] })
        }
      }, authorized)
    } catch (error) { if (!address) throw error; if (!await this.committed(on, tabId, address)) return this.discard(address, error) }
    if (address) await this.born(address, spaceId, tabId, on)
    if (action.action === 'close' && original.terminal) await this.endRemoved([original.terminal])
    return this.snapshot()
  }

  async markSeen(address: string, turn: number): Promise<void> {
    if (!Number.isSafeInteger(turn) || turn < 0) throw new Error('Invalid core turn')
    const result = await this.rpc.call('terminal.get', { terminal: address })
    const terminal = object(result.terminal) ? result.terminal : result
    if (terminal.turn !== turn) return
    const seen = object(terminal.labels) ? terminal.labels['herdr.seen'] : undefined
    if (typeof seen === 'string' && /^\d+$/u.test(seen) && Number(seen) >= turn) return
    await this.rpc.call('terminal.label', { terminal: address, labels: { 'herdr.seen': String(turn) } })
  }

  async setSplitRatio(spaceId: string, tabId: string, path: boolean[], ratio: number, authorized = () => true): Promise<CoreSnapshot> {
    if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9 || !Array.isArray(path) || !path.length || path.length > 512 || path.some(item => typeof item !== 'boolean')) throw new Error('Invalid Herdr split ratio')
    const { tab, on } = this.target(await this.snapshot(), spaceId, tabId)
    if (tab!.synthetic) throw new Error('This terminal has no shared split layout')
    const indices: number[] = []
    let index = 0
    for (const item of path) { if (item) index++; else { indices.push(index); index = 0 } }
    if (path.at(-1) !== false) throw new Error('Invalid Herdr split path')
    const locate = (root: CoreNode): { node: CoreNode; boundary: number } => {
      let node = root
      for (const at of indices.slice(0, -1)) { const child = node.children?.[at]; if (!child) throw changed(); node = child }
      const boundary = indices.at(-1)!
      if (!['row', 'column'].includes(node.type) || !node.children?.[boundary] || boundary >= node.children.length - 1) throw changed()
      return { node, boundary }
    }
    const original = locate(tab!.root)
    const signature = JSON.stringify([original.node.id, original.node.type, original.node.children!.map(child => [child.id, child.hidden || false])])
    await this.write(on, doc => {
      const currentTab = doc.spaces.find(space => space.id === local(spaceId, on))?.tabs.find(item => item.id === local(tabId, on))
      if (!currentTab) throw changed()
      const current = locate(currentTab.root)
      const currentSignature = JSON.stringify([qualify(current.node.id, on), current.node.type, current.node.children!.map(child => [qualify(child.id, on), child.hidden || false])])
      if (signature !== currentSignature) throw changed()
      const shown = current.node.children!.map((child, at) => ({ child, at, weight: Math.max(0.01, Number(child.size?.weight) || 1) })).filter(item => !item.child.hidden)
      const before = shown.filter(item => item.at <= current.boundary), after = shown.filter(item => item.at > current.boundary)
      if (!before.length || !after.length) throw changed()
      const left = before.reduce((sum, item) => sum + item.weight, 0), right = after.reduce((sum, item) => sum + item.weight, 0)
      for (const item of before) item.child.size = { weight: item.weight / left * ratio }
      for (const item of after) item.child.size = { weight: item.weight / right * (1 - ratio) }
    }, authorized)
    return this.snapshot()
  }
}
