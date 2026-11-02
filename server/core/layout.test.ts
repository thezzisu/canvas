import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreLayout, coreStatus, coreWindowMetadata, panes, parseDocument, projectTab, type CoreApi, type CoreDocument, type CoreNode, type CoreTab, type CoreTerminal } from './layout.ts'

const copy = <T>(value: T): T => structuredClone(value)
const pane = (id: string, terminal: string, extra: Partial<CoreNode> = {}): CoreNode => ({ id, type: 'block', content: { terminal }, ...extra })
const tab = (root: CoreNode = { id: 'tab', type: 'row', children: [pane('p1', 't1')] }): CoreTab => ({ id: 'tab', name: '', root })
const document = (tabs = [tab()]): CoreDocument => ({ spaces: [{ id: 'space', name: '', folder: '/tmp/fixture', tabs }] })
const terminal = (address = 't1', extra: Partial<CoreTerminal> = {}): CoreTerminal => ({ address, state: 'live', labels: {}, turn: 0, cols: 80, rows: 24, cwd: '/tmp/fixture', ...extra })

class FixtureApi implements CoreApi {
  doc: CoreDocument | null = document()
  version = 1
  terminals: CoreTerminal[] = [terminal()]
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  beforeWrite?: (params: Record<string, unknown>) => void
  failLabels = false
  failKill = false
  failWrite = false
  loseWriteReply = false
  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.calls.push({ method, params: copy(params) })
    if (method === 'server.status') return { core: { id: 'fixture-core', name: 'fixture' }, version: '0.1.17' }
    if (method === 'terminal.list') return { terminals: copy(this.terminals), machines: [{ name: 'other', state: 'connected' }] }
    if (method === 'doc.get') { assert(!params.on, 'selected source never reads federated machine documents'); return { value: copy(this.doc), version: this.version } }
    if (method === 'doc.set') {
      this.beforeWrite?.(params)
      if (this.failWrite) throw new Error('disk unavailable')
      if (params.version !== this.version) throw Object.assign(new Error('stale document'), { kind: 'conflict' })
      this.doc = copy(params.value as CoreDocument); this.version++
      if (this.loseWriteReply) { this.loseWriteReply = false; throw new Error('write reply lost') }
      return { version: this.version }
    }
    if (method === 'terminal.run') {
      const created = terminal(`t${this.terminals.length + 1}`, { labels: copy(params.labels as Record<string, string>) })
      this.terminals.push(created); return copy(created)
    }
    if (method === 'terminal.label') {
      if (this.failLabels) throw new Error('label unavailable')
      const target = this.terminals.find(item => item.address === params.terminal)!
      Object.assign(target.labels, params.labels); return copy(target)
    }
    if (method === 'terminal.get') return copy(this.terminals.find(item => item.address === params.terminal)!)
    if (method === 'terminal.kill') {
      if (this.failKill) throw new Error('kill unavailable')
      this.terminals.find(item => item.address === params.terminal)!.state = 'finished'; return {}
    }
    throw new Error(`Unhandled fixture method ${method}`)
  }
}

test('core snapshots preserve opaque app documents and stable synthetic identities without writes or federated access', async () => {
  const api = new FixtureApi(), layout = new CoreLayout(api)
  api.doc = null; api.version = 0
  api.terminals.push(terminal('remote/t8'))
  const first = await layout.snapshot(), next = await layout.snapshot()
  assert.deepEqual(first.spaces, next.spaces)
  assert.equal(first.spaces.length, 1)
  assert.equal(first.spaces[0]!.id, 'core:unplaced')
  assert.equal(panes(first.spaces[0]!.tabs[0]!)[0]!.id, 'core-pane:t1')
  assert.equal(first.terminals.length, 1)
  assert(!api.calls.some(call => ['doc.set', 'terminal.label', 'terminal.run'].includes(call.method)))
  const opaque = { ...document(), client: { unknown: ['keep', 42] } }
  opaque.spaces[0]!.tabs[0]!.root.extra = { future: true }
  assert.deepEqual(parseDocument(opaque), opaque)
  assert.throws(() => parseDocument(document([tab(), { ...tab(), root: pane('different-root', 't1') }])), /Invalid.*tab/u)
})

test('projection preserves n-ary order, selected stack, unknown blocks and bounded cell rectangles', () => {
  const root: CoreNode = { id: 'root', type: 'row', children: [
    pane('one', 't1'), { id: 'stack', type: 'stack', active: 'third', children: [pane('hidden-tab', 't2'), { id: 'third', type: 'column', children: [pane('three', 't3'), { id: 'mod', type: 'block', content: { mod: 'files' } }] }] },
    pane('four', 't4'), pane('invisible', 't5', { hidden: true }),
  ] }
  const projected = projectTab(tab(root), 80, 24)
  assert.deepEqual(projected.panes.map(item => item.id), ['one', 'three', 'mod', 'four'])
  assert.match(projected.panes.find(item => item.id === 'mod')!.unsupported!, /Herdr mod: files/u)
  assert.equal(new Set(projected.splits.map(item => JSON.stringify(item.path))).size, projected.splits.length)
  assert.equal(projected.splits.find(item => item.area.width === 80)!.direction, 'Horizontal', 'legacy split direction describes the resize axis')
  assert(projected.splits.some(item => item.direction === 'Vertical'))
  for (const { rect } of projected.panes) assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 80 && rect.y + rect.height <= 24)
  assert.deepEqual(projectTab(tab(root), 80, 24, 'three').panes.map(item => [item.id, item.rect]), [['three', { x: 0, y: 0, width: 80, height: 24 }]])
  for (const { rect } of projectTab(tab(root), 2, 1).panes) assert(rect.x + rect.width <= 2 && rect.y + rect.height <= 1)
  const remote = projectTab(tab(pane('remote', 'other/t9')), 80, 24).panes[0]!
  assert.equal(remote.terminal, undefined)
  assert.match(remote.unsupported!, /separate Canvas SSH source/u)
})

test('native status uses report and shared seen turns, preserving error and unknown without screen guessing', async () => {
  assert.equal(coreStatus(terminal()), 'unknown')
  for (const [state, expected] of [['blocked', 'attention'], ['error', 'error'], ['working', 'working']] as const) assert.equal(coreStatus(terminal('t1', { status: { state }, turn: 4, labels: { 'herdr.seen': '4' } })), expected)
  assert.equal(coreStatus(terminal('t1', { status: { state: 'idle' }, turn: 4, labels: { 'herdr.seen': '3' } })), 'done')
  assert.equal(coreStatus(terminal('t1', { status: { state: 'done' }, turn: 4, labels: { 'herdr.seen': '4' } })), 'idle')
  const api = new FixtureApi(), layout = new CoreLayout(api)
  api.terminals[0] = terminal('t1', { status: { state: 'done', app: 'fixture-agent' }, turn: 2, labels: { 'herdr.seen': '1' } })
  const snapshot = await layout.snapshot(), metadata = coreWindowMetadata(snapshot, 'tab')!
  assert.equal(metadata.bootId, 'fixture-core')
  assert.equal(metadata.readAuthority, 'native')
  assert.equal(metadata.name, '1')
  assert.deepEqual(metadata.panes[0]!.completion, { bootId: 'fixture-core', sequence: 2 })
  assert.equal(layout.resources(snapshot)[0]!.name, 'fixture')
  await layout.markSeen('t1', 1)
  assert(!api.calls.some(call => call.method === 'terminal.label'))
  await layout.markSeen('t1', 2)
  assert.equal(api.terminals[0]!.labels['herdr.seen'], '2')
  await layout.markSeen('t1', 2)
  assert.equal(api.calls.filter(call => call.method === 'terminal.label').length, 1)
})

test('CAS retries preserve concurrent unrelated edits and reject destructive changes to the targeted tab', async () => {
  const api = new FixtureApi(), layout = new CoreLayout(api)
  api.doc!.unknown = { preserve: true }
  api.beforeWrite = () => { api.beforeWrite = undefined; api.doc!.spaces.push({ id: 'other', name: 'Concurrent', folder: '', tabs: [] }); api.version++ }
  await layout.renameWindow('space', 'tab', 'Renamed')
  assert.equal(api.doc!.spaces[0]!.tabs[0]!.name, 'Renamed')
  assert.equal(api.doc!.spaces[1]!.name, 'Concurrent')
  assert.deepEqual(api.doc!.unknown, { preserve: true })
  api.beforeWrite = () => { api.beforeWrite = undefined; api.doc!.spaces[0]!.tabs[0]!.root.children!.push(pane('concurrent-pane', 't2')); api.version++ }
  await assert.rejects(layout.closeWindow('space', 'tab'), /layout changed/u)
  assert.equal(api.doc!.spaces[0]!.tabs[0]!.root.children!.length, 2)
  assert(!api.calls.some(call => call.method === 'terminal.kill'))
})

test('shared window and pane operations retain unknown fields and compensate only a fresh unsaved terminal', async () => {
  const api = new FixtureApi(), layout = new CoreLayout(api)
  api.doc!.spaces[0]!.tabs[0]!.root.extra = 'keep'
  const created = await layout.createWindow('space', 'New tab')
  assert.equal(api.doc!.spaces[0]!.tabs.length, 2)
  assert.equal(api.terminals[1]!.labels['herdr.tab'], created.windowId)
  assert.equal(api.calls.find(call => call.method === 'terminal.run')!.params.no_parent, true)
  assert.equal(api.calls.find(call => call.method === 'terminal.run')!.params.keep, true)
  await layout.paneAction('space', 'tab', 'p1', { action: 'split-right' })
  let snapshot = await layout.snapshot(), current = layout.findWindow(snapshot, 'space', 'tab')
  assert.equal(panes(current).length, 2)
  const split = projectTab(current, 80, 24).splits[0]!
  await layout.setSplitRatio('space', 'tab', split.path, 0.7)
  snapshot = await layout.snapshot(); current = layout.findWindow(snapshot, 'space', 'tab')
  const widths = projectTab(current, 80, 24).panes.map(item => item.rect.width)
  assert(widths[0]! > widths[1]! * 2)
  assert.equal(current.root.extra, 'keep')
  await layout.paneAction('space', 'tab', 'p1', { action: 'rename', name: 'Old pane' })
  assert.equal(panes(layout.findWindow(await layout.snapshot(), 'space', 'tab'))[0]!.title, 'Old pane')
  const newPane = panes(current)[1]!
  await layout.paneAction('space', 'tab', newPane.id, { action: 'close' })
  assert.equal(api.terminals.find(item => item.address === newPane.terminal)!.state, 'finished')
  assert.equal(panes(layout.findWindow(await layout.snapshot(), 'space', 'tab')).length, 1)
  api.failWrite = true
  await assert.rejects(layout.createWindow('space', 'Unsaved'), /disk unavailable/u)
  assert.equal(api.terminals.at(-1)!.state, 'finished')
  assert.equal(api.terminals[0]!.state, 'live')
})

test('a committed create succeeds if redundant label hints fail, while failed compensation reports the surviving terminal', async () => {
  const api = new FixtureApi(), layout = new CoreLayout(api)
  api.failLabels = true
  const created = await layout.createSpace('Saved')
  assert(api.doc!.spaces.some(space => space.id === created.spaceId))
  assert.equal(api.terminals.at(-1)!.state, 'live')
  api.failWrite = true; api.failKill = true
  await assert.rejects(layout.createSpace('Failed'), /remains running and is listed in Terminals/u)
})

test('a lost successful document reply recovers the created IDs without killing or duplicating the terminal', async () => {
  const api = new FixtureApi(), layout = new CoreLayout(api)
  api.loseWriteReply = true
  const result = await layout.createWindow('space', 'Recovered')
  assert(api.doc!.spaces[0]!.tabs.some(tab => tab.id === result.windowId && tab.name === 'Recovered'))
  assert.equal(api.terminals.at(-1)!.state, 'live')
  assert.equal(api.calls.filter(call => call.method === 'terminal.run').length, 1)
  assert(!api.calls.some(call => call.method === 'terminal.kill'))
})

test('ungrouped core terminals support stable-name and pane operations through explicit document adoption', async () => {
  const api = new FixtureApi(), layout = new CoreLayout(api)
  api.doc = null; api.version = 0
  await layout.renameWindow('core:unplaced', 't1', 'Adopted')
  const snapshot = await layout.snapshot()
  assert.equal(snapshot.spaces.length, 1)
  assert.equal(snapshot.spaces[0]!.tabs[0]!.name, 'Adopted')
  assert.equal(panes(snapshot.spaces[0]!.tabs[0]!)[0]!.id, 'core-pane:t1')
  await layout.paneAction('core:unplaced', 't1', 'core-pane:t1', { action: 'split-down' })
  assert.equal(panes(layout.findWindow(await layout.snapshot(), 'core:unplaced', 't1')).length, 2)
  assert.equal(api.calls.filter(call => call.method === 'terminal.run').length, 1, 'adopting an existing terminal must not start another process')
})

test('close preserves a terminal referenced elsewhere and respects cancellation before writes', async () => {
  const api = new FixtureApi(), layout = new CoreLayout(api)
  api.doc!.spaces.push({ id: 'other', name: 'Other reference', folder: '', tabs: [{ id: 'other-tab', name: '', root: pane('other-pane', 't1') }] })
  await layout.closeWindow('space', 'tab')
  assert.equal(api.terminals[0]!.state, 'live')
  assert(!api.calls.some(call => call.method === 'terminal.kill'))
  const before = copy(api.doc)
  await assert.rejects(layout.paneAction('other', 'other-tab', 'other-pane', { action: 'rename', name: 'Denied' }, () => false), /cancelled/u)
  assert.deepEqual(api.doc, before)
})
