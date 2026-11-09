import assert from 'node:assert/strict'
import test from 'node:test'
import headless from '@xterm/headless'
import { createCoreClient, coreHyperlink } from './client.ts'
import { CoreLayout, type CoreDocument } from './layout.ts'
import { CoreRpc, CoreRpcError, CoreStream, type CoreNotification } from './rpc.ts'
import type { WindowMetadata } from '../../shared/window-metadata.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const report = (state: string) => `\x1b]7501;state=${state}:app=fixture\x1b\\`

function fixture(split = false, subscriptionSeq = 0) {
  const terminal = { address: 't1', labels: {} as Record<string, string>, state: 'live', status: { state: 'working' }, turn: 0, cols: 80, rows: 10, cwd: '/tmp', pid: 123 }
  const terminals = split ? [terminal, { ...terminal, address: 't2', pid: 124 }] : [terminal]
  const document: CoreDocument = { spaces: [{ id: 'space', name: 'Space', folder: '/tmp', tabs: [{ id: 'tab', name: 'Tab', root: { id: 'tab', type: 'row', children: [{ id: 'pane', type: 'block', content: { terminal: 't1' } }] } }] }] }
  if (split) document.spaces[0]!.tabs[0]!.root.children!.push({ id: 'second', type: 'block', content: { terminal: 't2' } })
  let onEvent: ((event: CoreNotification) => void | Promise<void>) | undefined
  const failures: Error[] = [], sent: Array<{ channel: number; kind: number; data: Buffer }> = [], attached: string[] = [], streams: CoreStream[] = []
  const controls: { attachGate?: Promise<void>; failAttach?: boolean; labelGate?: Promise<void>; labelStarted?(): void; documentVersion: number; listCalls: number; documentWrites: number; missingReadFails?: boolean } = { documentVersion: 1, listCalls: 0, documentWrites: 0 }
  const rpc = {
    connected: true,
    hello: { core: { id: 'core', name: 'Fixture' }, version: '0.1.17' },
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'server.status') return { core: { id: 'core' }, version: '0.1.17' }
      if (method === 'terminal.list') { controls.listCalls++; return { terminals: structuredClone(terminals) } }
      if (method === 'doc.get') return { value: structuredClone(document), version: controls.documentVersion }
      if (method === 'doc.set') {
        assert.equal(params.version, controls.documentVersion)
        Object.assign(document, structuredClone(params.value)); controls.documentWrites++
        return { version: ++controls.documentVersion }
      }
      if (method === 'terminal.get') {
        if (controls.missingReadFails) throw new Error('Read unavailable')
        const found = terminals.find(item => item.address === params.terminal)
        if (!found) throw new CoreRpcError({ message: 'No terminal', data: { kind: 'not_found' } })
        return structuredClone(found)
      }
      if (method === 'terminal.label') { controls.labelStarted?.(); await controls.labelGate; Object.assign(terminal.labels, params.labels); return structuredClone(terminal) }
      throw new Error('Unexpected fixture method: ' + method)
    },
    async attach(params: { terminal: string }) {
      const pane = terminals.find(terminal => terminal.address === params.terminal)!
      const next = attached.length ? new CoreStream(attached.length + 1, rpc) : stream
      attached.push(params.terminal); streams.push(next)
      await controls.attachGate
      if (controls.failAttach) throw new Error('Attach unavailable')
      return { terminal: structuredClone(pane), channel: next.channel, stream: next }
    },
    async subscribe(_params: unknown, callback: typeof onEvent) { onEvent = callback; return { snapshot: { seq: subscriptionSeq, terminals: structuredClone(terminals) }, start() {}, close() {} } },
    onClose() { return { dispose() {} } },
    send(channel: number, kind: number, data: Buffer) { sent.push({ channel, kind, data }) },
    retire() {},
    fail(error: Error) { failures.push(error) },
  } as unknown as CoreRpc
  const stream = new CoreStream(1, rpc), layout = new CoreLayout(rpc)
  let eventSequence = subscriptionSeq
  const notification = async (method: CoreNotification['method'], params: Record<string, unknown>, seq = ++eventSequence) => {
    eventSequence = Math.max(eventSequence, seq); await onEvent?.({ method, params: { ...params, seq } }); await tick()
  }
  const event = (type: string, data: Record<string, unknown>, seq?: number) => notification('event', { terminal: 't1', type, data }, seq)
  return { rpc, stream, streams, attached, controls, layout, terminal, terminals, document, sent, failures, event, notification }
}

test('subscription sequence waterline rejects stale Core events after the initial snapshot', async () => {
  const f = fixture(false, 103)
  f.terminal.turn = 0; f.terminal.status = { state: 'working' }
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('\x1b[?9001l') })
  const client = await opening
  try {
    const notifications: unknown[] = []
    client.onNotification(value => notifications.push(value))
    await f.event('status', { status: { state: 'idle' } }, 101)
    await f.event('turn', { turn: 1 }, 102)
    assert.equal(notifications.length, 0, 'the older idle/turn backlog after the subscription snapshot cannot synthesize Done')
    const frame = await client.completionSnapshot()
    assert.equal(frame?.windows[0]?.status, 'working')
    assert.equal(f.terminal.turn, 0)
    assert.equal(f.controls.listCalls, 0, 'the sequence and terminal data come from the same subscription snapshot')
    await f.event('status', { status: { state: 'idle' } }, 104)
    await f.event('turn', { turn: 1 }, 105)
    assert.equal(notifications.length, 1, 'a live completion after the snapshot is still delivered')
    await f.event('turn', { turn: 1 }, 105)
    await f.event('status', { status: { state: 'working' } }, 104)
    assert.equal(notifications.length, 1, 'duplicate sequence numbers cannot repeat a completion')
    assert.equal(client.completionSnapshot()?.windows[0]?.status, 'done')
  } finally { client.kill() }
})

test('an initial completed snapshot is state, not a new completion notification', async () => {
  const f = fixture(false, 20)
  f.terminal.turn = 3; f.terminal.status.state = 'idle'
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from(report('idle') + '\x1b[?9001l') })
  const client = await opening
  try {
    const notifications: unknown[] = []
    client.onNotification(value => notifications.push(value))
    await f.event('turn', { turn: 3 }, 20)
    assert.equal(client.completionSnapshot()?.windows[0]?.status, 'done')
    assert.equal(notifications.length, 0)
  } finally { client.kill() }
})

test('heartbeat sequence rejects earlier events without changing native state', async () => {
  const f = fixture(false, 20)
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('\x1b[?9001l') })
  const client = await opening
  try {
    const notifications: unknown[] = []
    client.onNotification(value => notifications.push(value))
    await f.notification('heartbeat', {}, 30)
    await f.event('status', { status: { state: 'idle' } }, 29)
    await f.event('turn', { turn: 1 }, 30)
    assert.equal(client.completionSnapshot()?.windows[0]?.status, 'working')
    assert.equal(notifications.length, 0)
    await f.event('status', { status: { state: 'idle' } }, 31)
    await f.event('turn', { turn: 1 }, 32)
    assert.equal(notifications.length, 1)
  } finally { client.kill() }
})

test('missed-event recovery uses its own snapshot and does not replay old completion events', async () => {
  const f = fixture(false, 20)
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('\x1b[?9001l') })
  const client = await opening
  try {
    const notifications: unknown[] = []
    client.onNotification(value => notifications.push(value))
    const snapshot = { ...structuredClone(f.terminal), turn: 5 }
    f.terminal.status.state = 'idle'; f.terminal.turn = 8
    await f.notification('missed', { terminals: [snapshot] }, 50)
    assert.equal(f.controls.listCalls, 0, 'a separately sampled list cannot replace the sequenced snapshot')
    assert.equal(client.completionSnapshot()?.windows[0]?.status, 'working')
    await f.event('status', { status: { state: 'idle' } }, 49)
    await f.event('turn', { turn: 6 }, 50)
    assert.equal(notifications.length, 0)
    assert.equal(client.completionSnapshot()?.windows[0]?.status, 'working')
    await f.event('status', { status: { state: 'idle' } }, 51)
    await f.event('turn', { turn: 6 }, 52)
    assert.equal(notifications.length, 1)
    await f.notification('missed', { terminals: [{ ...snapshot, turn: 1 }] }, 50)
    assert.equal(client.completionSnapshot()?.windows[0]?.panes[0]?.completion?.sequence, 6)
    await assert.rejects(f.notification('missed', { terminals: null }, 53), /Invalid core recovery snapshot/u)
    assert.equal(f.controls.listCalls, 0, 'invalid protocol recovery cannot silently fall back to an unsequenced snapshot')
  } finally { client.kill() }
})

test('document refresh and pane-action results cannot replace the ordered terminal mirror with a future list', async () => {
  const f = fixture(false, 20)
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('\x1b[?9001l') })
  const client = await opening
  try {
    f.terminal.turn = 5
    await f.event('doc', {}, 21)
    assert.equal(f.controls.listCalls, 0, 'document events read documents, not unsequenced terminal lists')
    assert.equal(client.completionSnapshot()?.windows[0]?.panes[0]?.stateSequence, 0)
    f.layout.paneAction = async () => f.layout.snapshot()
    await client.paneAction({ bootId: 'core', paneId: 'pane', name: '' }, { action: 'rename', name: 'Renamed' })
    assert.equal(f.controls.listCalls, 1, 'the independent action can consult current native facts')
    assert.equal(client.completionSnapshot()?.windows[0]?.panes[0]?.stateSequence, 0, 'its unsequenced terminal list cannot overwrite the event mirror')
    await f.event('status', { status: { state: 'idle' } }, 22)
    await f.event('turn', { turn: 1 }, 23)
    assert.equal(client.completionSnapshot()?.windows[0]?.panes[0]?.stateSequence, 1)
    await f.event('status', { status: { state: 'working' } }, 24)
    await f.event('doc', {}, 25)
    assert.equal(client.completionSnapshot()?.windows[0]?.status, 'working')
    assert.equal(client.completionSnapshot()?.windows[0]?.panes[0]?.stateSequence, 1)
  } finally { client.kill() }
})

test('native lifecycle events preserve unrelated terminals, replace restarted streams and remove synthetic tabs', async () => {
  const f = fixture(false, 20)
  f.document.spaces = []
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'core:unplaced', tabId: 't1', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('BEFORE\x1b[?9001l') })
  const client = await opening
  try {
    const exits: unknown[] = []; client.onExit(value => exits.push(value))
    f.terminal.turn = 5
    const other = { ...structuredClone(f.terminal), address: 't2', turn: 7 }
    await f.notification('event', { terminal: 't2', type: 'created', data: other }, 21)
    const windows = client.completionSnapshot()!.windows
    assert.equal(windows.find(window => window.id === 't1')?.panes[0]?.stateSequence, 0)
    assert.equal(windows.find(window => window.id === 't2')?.panes[0]?.stateSequence, 7)
    assert.equal(f.controls.listCalls, 0, 'lifecycle records do not sample unrelated future state')
    await f.event('status', { status: null }, 22)
    await f.event('lost', { reason: 'signaled', exit_code: null, signal: 9, finished_ms: null }, 23)
    assert.equal(client.completionSnapshot()?.windows.find(window => window.id === 't1')?.status, 'unknown')
    await f.notification('event', { terminal: 't2', type: 'finished', data: { reason: 'exited', exit_code: 0, signal: null, finished_ms: 100 } }, 24)
    assert(!client.completionSnapshot()?.windows.some(window => window.id === 't2'), 'finished records leave the synthetic live-terminal layout')
    Object.assign(f.terminal, { turn: 2, status: { state: 'working' }, pid: 999 })
    await f.event('restarted', structuredClone(f.terminal), 25)
    assert.deepEqual(f.attached, ['t1', 't1'])
    assert(f.sent.some(frame => frame.channel === 1 && frame.kind === 2), 'the old attach stream is closed')
    f.streams[1]!.receive({ kind: 'data', data: Buffer.from('AFTER\x1b[?9001l') })
    await tick(); await tick()
    assert.equal((await client.content())?.[0]?.lines[0]?.trim(), 'AFTER')
    await f.event('removed', {}, 26)
    assert.deepEqual(exits, [{ exitCode: 0, reason: 'removed' }], 'removing the last synthetic native tab closes its view')
  } finally { client.kill() }
})

test('confirmed Core EOF closes an explicit tab once and preserves the retained terminal record', async () => {
  const f = fixture()
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('FINAL\x1b[?9001l') })
  const client = await opening
  const exits: unknown[] = []; client.onExit(exit => exits.push(exit))
  try {
    await f.event('finished', { reason: 'exited', exit_code: 0, finished_ms: 100 })
    f.stream.receive({ kind: 'close', reason: { reason: 'exited', exit_code: 0 } })
    await tick(); await tick()
    assert.deepEqual(f.document.spaces, [])
    assert.deepEqual(exits, [{ exitCode: 0, reason: 'removed' }])
    assert.equal(f.controls.documentWrites, 1)
    assert.equal(f.controls.listCalls, 0, 'closure never replaces the ordered terminal mirror with a newer list')
    assert.equal(f.terminals.length, 1, 'layout cleanup does not destroy the retained Core record')
    assert.deepEqual(f.failures, [])
  } finally { client.kill() }
})

test('a split pane finishing leaves its live sibling connected and the last exit closes the tab', async () => {
  const f = fixture(true)
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 40, rows: 6 })
  await tick()
  for (const [index, stream] of f.streams.entries()) stream.receive({ kind: 'data', data: Buffer.from(`PANE${index}\x1b[?9001l`) })
  const client = await opening
  const exits: unknown[] = []; client.onExit(exit => exits.push(exit))
  try {
    client.onData(() => {})
    // The terminal channel can finish before the subscription channel catches up.
    f.streams[0]!.receive({ kind: 'close', reason: { reason: 'exited', exit_code: 0 } })
    await tick(); await tick(); await tick()
    assert.deepEqual(client.completionSnapshot()?.windows.find(window => window.id === 'tab')?.panes.map(pane => pane.id), ['second'])
    assert.deepEqual(exits, [])
    await f.event('finished', { reason: 'exited', exit_code: 0, finished_ms: 100 })
    assert.equal(f.controls.documentWrites, 1, 'later global event does not repeat the document edit')
    f.streams[1]!.receive({ kind: 'data', data: Buffer.from('\r\nSTILL LIVE') })
    await tick(); assert((await client.content())?.[0]?.lines.some(line => line.includes('STILL LIVE')))
    await f.notification('event', { terminal: 't2', type: 'finished', data: { reason: 'exited', exit_code: 0, finished_ms: 200 } })
    assert.deepEqual(f.document.spaces, [])
    assert.deepEqual(exits, [{ exitCode: 0, reason: 'removed' }])
  } finally { client.kill() }
})

test('recoverable lost terminals and transport-only stream endings do not remove their document panes', async () => {
  const f = fixture(), before = structuredClone(f.document)
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('READY\x1b[?9001l') })
  const client = await opening
  const exits: unknown[] = []; client.onExit(exit => exits.push(exit))
  try {
    f.stream.receive({ kind: 'close', reason: { reason: 'signaled', signal: 9 } })
    await f.event('lost', { reason: 'signaled', pid: null, signal: 9 })
    assert.deepEqual(f.document, before); assert.deepEqual(exits, [])
    await f.event('restarted', { ...f.terminal, pid: 999, reason: null })
    await tick(); f.streams[1]!.receive({ kind: 'data', data: Buffer.from('RECOVERED\x1b[?9001l') })
    await tick(); await tick()
    assert((await client.content())?.[0]?.lines.some(line => line.includes('RECOVERED')))
    f.streams[1]!.receive({ kind: 'close', reason: { reason: 'disconnected' } })
    await tick(); await tick()
    assert.deepEqual(f.document, before); assert.equal(f.controls.documentWrites, 0); assert.deepEqual(exits, [])
  } finally { client.kill() }
})

test('initial and missed snapshots reconcile already finished panes without attaching or emitting completion', async () => {
  const initial = fixture()
  Object.assign(initial.terminal, { state: 'finished', reason: 'exited' })
  await assert.rejects(createCoreClient({ rpc: initial.rpc, layout: initial.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 }), /closed|paint/u)
  assert.deepEqual(initial.document.spaces, []); assert.deepEqual(initial.attached, [])
  const f = fixture()
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('READY\x1b[?9001l') })
  const client = await opening, notices: unknown[] = [], exits: unknown[] = []
  client.onNotification(event => notices.push(event)); client.onExit(exit => exits.push(exit))
  try {
    await f.notification('missed', { terminals: [{ ...f.terminal, state: 'finished', reason: 'exited' }] }, 40)
    assert.deepEqual(f.document.spaces, []); assert.deepEqual(notices, [])
    assert.deepEqual(exits, [{ exitCode: 0, reason: 'removed' }])
  } finally { client.kill() }
})

test('missing snapshot records need confirmed absence, not failed discovery, before removing a pane', async () => {
  for (const unavailable of [false, true]) {
    const f = fixture(), before = structuredClone(f.document)
    f.terminals.length = 0; f.controls.missingReadFails = unavailable
    if (unavailable) {
      const client = await createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
      assert.deepEqual(f.document, before); assert.equal(f.controls.documentWrites, 0); client.kill()
    } else {
      await assert.rejects(createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 }), /closed|paint/u)
      assert.deepEqual(f.document.spaces, [])
    }
  }
})

test('missed snapshots recover ended streams and initial waiting panes without a restarted event', async () => {
  for (const initiallyWaiting of [false, true]) {
    const f = fixture()
    if (initiallyWaiting) Object.assign(f.terminal, { reason: 'signaled', pid: null })
    const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
    await tick()
    if (!initiallyWaiting) f.stream.receive({ kind: 'data', data: Buffer.from('BEFORE\x1b[?9001l') })
    const client = await opening, notices: unknown[] = []
    client.onData(() => {}); client.onNotification(notice => notices.push(notice))
    try {
      if (!initiallyWaiting) {
        f.stream.receive({ kind: 'close', reason: { reason: 'signaled', signal: 9 } })
        await f.event('lost', { reason: 'signaled', pid: null })
      }
      Object.assign(f.terminal, { reason: null, pid: 999 })
      await f.notification('missed', { terminals: [structuredClone(f.terminal)] }, 50)
      assert.deepEqual(f.attached, initiallyWaiting ? ['t1'] : ['t1', 't1'])
      const recovered = f.streams.at(-1)!
      recovered.receive({ kind: 'data', data: Buffer.from('RECOVERED\x1b[?9001l') })
      await client.completionFence()
      assert.equal((await client.content())?.[0]?.lines[0]?.trim(), 'RECOVERED')
      client.write('x'); await client.completionFence()
      assert(f.sent.some(frame => frame.channel === recovered.channel && frame.kind === 0 && frame.data.toString() === 'x'))
      assert.equal(f.controls.documentWrites, 0)
      assert.deepEqual(notices, [], 'recovery restores state without replaying agent notifications')
      await f.notification('missed', { terminals: [structuredClone(f.terminal)] }, 51)
      assert.equal(f.streams.at(-1), recovered, 'a healthy stream survives a later snapshot')
    } finally { client.kill() }
  }
})

test('native snapshots and events clean up unopened tabs without attaching their streams', async () => {
  for (const missed of [false, true]) {
    const f = fixture()
    const hidden = { ...structuredClone(f.terminal), address: 't2', pid: 456 }
    f.terminals.push(hidden)
    for (const id of ['hidden-one', 'hidden-two']) f.document.spaces[0]!.tabs.push({ id, name: id,
      root: { id: `${id}-pane`, type: 'block', content: { terminal: 't2' } } })
    const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
    await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('VISIBLE\x1b[?9001l') })
    const client = await opening
    try {
      Object.assign(hidden, { state: 'finished', reason: 'exited' })
      if (missed) await f.notification('missed', { terminals: structuredClone(f.terminals) }, 50)
      else await f.notification('event', { terminal: 't2', type: 'finished', data: { reason: 'exited' } })
      assert.deepEqual(f.document.spaces[0]!.tabs.map(tab => tab.id), ['tab'])
      assert.deepEqual(client.completionSnapshot()?.windows.map(window => window.id), ['tab'])
      assert.deepEqual(f.attached, ['t1'])
      assert.equal(f.controls.documentWrites, 1, 'all confirmed references share one CAS update')
    } finally { client.kill() }
  }
})

test('non-exit finished records retain their layout while Core owns recovery', async () => {
  for (const reason of ['server_stop', 'host_shutdown', 'holder_lost', 'stopped_by_restart']) {
    const f = fixture(), before = structuredClone(f.document)
    Object.assign(f.terminal, { state: 'finished', reason, pid: null })
    const client = await createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
    try {
      assert.deepEqual(f.document, before)
      assert.equal(f.controls.documentWrites, 0)
      assert.deepEqual(f.attached, [])
      Object.assign(f.terminal, { state: 'live', reason: null, pid: 999 })
      await f.notification('missed', { terminals: structuredClone(f.terminals) }, 50)
      assert.deepEqual(f.attached, ['t1'])
    } finally { client.kill() }
  }
})

test('a missing-record lookup cannot commit an old layout after a newer pane action', async () => {
  const f = fixture()
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('READY\x1b[?9001l') })
  const client = await opening
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { started = resolve })
  const call = f.rpc.call.bind(f.rpc)
  f.rpc.call = async (method: string, params = {}) => {
    if (method === 'terminal.get' && params.terminal === 'missing') {
      started(); await gate
      return { ...structuredClone(f.terminal), address: 'missing' } as never
    }
    return call(method, params)
  }
  try {
    f.document.spaces[0]!.tabs[0]!.root.children!.push({ id: 'new-pane', type: 'block', content: { terminal: 'missing' } })
    f.controls.documentVersion = 2
    const delayed = f.event('doc', {})
    await entered
    f.document.spaces[0]!.tabs[0]!.root.children!.pop(); f.controls.documentVersion = 3
    await client.paneAction({ bootId: 'core', paneId: 'pane', name: '' }, { action: 'rename', name: 'New title' })
    release(); await delayed
    assert.deepEqual(client.completionSnapshot()?.windows.find(window => window.id === 'tab')?.panes.map(pane => ({ id: pane.id, name: pane.name })),
      [{ id: 'pane', name: 'New title' }])
    assert.deepEqual(f.attached, ['t1'], 'the obsolete missing pane never attaches')
  } finally { release(); client.kill() }
})

test('an unsequenced action result cannot close panes using different terminal facts', async () => {
  const f = fixture(), before = structuredClone(f.document)
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('READY\x1b[?9001l') })
  const client = await opening
  try {
    f.layout.paneAction = async () => f.layout.snapshot()
    Object.assign(f.terminal, { state: 'finished', reason: 'exited' })
    await client.paneAction({ bootId: 'core', paneId: 'pane', name: '' }, { action: 'rename', name: 'Ignored' })
    assert.deepEqual(f.document, before)
    assert.equal(f.controls.documentWrites, 0)
    assert.equal(client.completionSnapshot()?.windows[0]?.status, 'working')
    await f.event('finished', { reason: 'exited' })
    assert.deepEqual(f.document.spaces, [], 'the sequenced terminal fact still closes the pane')
  } finally { client.kill() }
})

test('a delayed seen-label write cannot replace newer event state with its response-time snapshot', async () => {
  const f = fixture(false, 20)
  f.terminal.turn = 1; f.terminal.status.state = 'idle'
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from(report('idle') + '\x1b[?9001l') })
  const client = await opening
  try {
    client.onData(() => {}); await tick(); await client.completionFence()
    let release!: () => void
    const started = new Promise<void>(resolve => { f.controls.labelStarted = resolve })
    f.controls.labelGate = new Promise<void>(resolve => { release = resolve })
    const acknowledgement = client.acknowledgeCompletion!('pane', { bootId: 'core', sequence: 1 })
    await started
    await f.event('status', { status: { state: 'working' } }, 21)
    await f.event('turn', { turn: 2 }, 22)
    f.terminal.status.state = 'idle'; f.terminal.turn = 3
    release(); await acknowledgement
    assert.equal(f.terminal.labels['herdr.seen'], '1')
    assert.equal(f.controls.listCalls, 0)
    assert.equal(client.completionSnapshot()?.windows[0]?.status, 'working')
    assert.equal(client.completionSnapshot()?.windows[0]?.panes[0]?.stateSequence, 2)
    await f.event('labels', { labels: { 'herdr.seen': '1' } }, 23)
    assert.equal(client.completionSnapshot()?.windows[0]?.status, 'working', 'the actual ordered label event does not read a later task')
  } finally { client.kill() }
})

test('widening a narrow core view attaches newly exposed panes before publishing the expanded frame', async () => {
  const f = fixture(true)
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 2, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('LEFT\x1b[?9001l') })
  const client = await opening
  try {
    const frames: WindowMetadata[] = []; let output = ''
    client.onData(data => { output += data }); client.onFrame(frame => frames.push(frame)); await tick()
    assert.deepEqual(f.attached, ['t1'])
    const before = frames.length
    client.resize(40, 6)
    await tick(); await tick()
    assert.deepEqual(f.attached, ['t1', 't2'], 'newly exposed panes attach without an unrelated core event')
    assert.equal(frames.length, before, 'wait for the newly exposed pane\'s complete paint')
    f.streams[1]!.receive({ kind: 'data', data: Buffer.from('RIGHT\x1b[?9001l') })
    await tick(); await tick()
    assert(!output.includes('Terminal unavailable'))
    assert.deepEqual((await client.content())?.map(pane => pane.lines[0]?.trim()), ['LEFT', 'RIGHT'])
    assert.equal(f.failures.length, 0)
  } finally { client.kill() }
})

test('clearing a native core title emits an explicit empty title instead of missing metadata', async () => {
  const f = fixture()
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('\x1b[?9001l') })
  const client = await opening
  try {
    const metadata: WindowMetadata[] = []; client.onData(() => {}); client.onMetadata(value => metadata.push(value))
    await f.event('title', { title: 'Task title' }); assert.equal(metadata.at(-1)?.panes[0]?.terminalTitle, 'Task title')
    await f.event('title', { title: '' }); assert.equal(metadata.at(-1)?.panes[0]?.terminalTitle, '')
  } finally { client.kill() }
})

test('rapid core resize retires a late pane attachment and can reveal it again', async () => {
  const f = fixture(true)
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 2, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('LEFT\x1b[?9001l') })
  const client = await opening
  try {
    client.onData(() => {})
    let release!: () => void
    f.controls.attachGate = new Promise<void>(resolve => { release = resolve })
    client.resize(40, 6); await tick()
    assert.deepEqual(f.attached, ['t1', 't2'])
    client.resize(2, 6); release(); await tick(); await tick()
    assert(f.sent.some(frame => frame.channel === 2 && frame.kind === 2), 'a pane hidden again detaches its late stream')
    client.resize(40, 6); await tick(); await tick()
    assert.deepEqual(f.attached, ['t1', 't2', 't2'])
    f.streams[2]!.receive({ kind: 'data', data: Buffer.from('RIGHT AGAIN\x1b[?9001l') })
    await tick(); await tick()
    assert.equal((await client.content())?.[1]?.lines[0]?.trim(), 'RIGHT AGAIN')
    assert.equal(f.failures.length, 0)
  } finally { client.kill() }
})

test('failed resize attachments close the view without an unhandled asynchronous rejection', async () => {
  const f = fixture(true)
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 2, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('LEFT\x1b[?9001l') })
  const client = await opening
  const closed = new Promise<number>(resolve => client.onExit(exit => resolve(exit.exitCode)))
  f.controls.failAttach = true
  client.resize(40, 6)
  assert.equal(await closed, 1)
  await tick()
  assert(f.sent.some(frame => frame.channel === 1 && frame.kind === 2))
})

test('unrecognized OSC status words cannot shift native turn accounting', async () => {
  const f = fixture()
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('Working\x1b[?9001l' + report('working')) })
  const client = await opening
  try {
    client.onData(() => {})
    f.terminal.status.state = 'idle'; f.terminal.turn = 1
    await f.event('status', { status: { state: 'idle' }, records: {}, reported: true })
    await f.event('turn', { turn: 1, state: 'idle' })
    f.stream.receive({ kind: 'data', data: Buffer.from(report('unknown-state') + report('working') + 'RESULT' + report('idle')) })
    await tick(); await tick()
    const frame = await client.completionFence()
    assert.equal(frame?.panes[0]?.completion?.sequence, 1)
    await client.acknowledgeCompletion?.('pane', { bootId: 'core', sequence: 1 })
    assert.equal(f.terminal.labels['herdr.seen'], '1')
  } finally { client.kill() }
})

test('floating panes share paint order with mouse, context targets and source-local visible scans', async () => {
  const f = fixture(true), root = f.document.spaces[0]!.tabs[0]!.root
  f.terminal.cwd = '/tmp/base'
  f.terminals.push({ ...f.terminal, address: 't3', pid: 125, cwd: '/tmp/floating' })
  root.floating = [{ id: 'floating', edge: 'bottom', content: { terminal: 't3' } }]
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick()
  const modes = '\x1b[?1000h\x1b[?1006h'
  f.streams[0]!.receive({ kind: 'data', data: Buffer.from(modes + 'BASE0\r\nBASE1\r\nBASE2\r\nBASE3\r\nBASE4\r\nBASE5\x1b[?9001l') })
  f.streams[1]!.receive({ kind: 'data', data: Buffer.from(modes + 'OTHER\x1b[?9001l') })
  f.streams[2]!.receive({ kind: 'data', data: Buffer.from(modes + '\x1b]8;;file:///tmp/floating/report.pdf\x1b\\FLOAT.pdf\x1b]8;;\x1b\\\r\nFLOAT1\r\nFLOAT2\x1b[?9001l') })
  const client = await opening, screen = new headless.Terminal({ cols: 20, rows: 6, allowProposedApi: true })
  try {
    let output = ''; client.onData(data => { output += data; screen.write(data) })
    const frame = await client.completionFence(); await new Promise<void>(resolve => screen.write('', resolve))
    assert(frame?.layout)
    assert.equal(screen.buffer.active.getLine(1)?.getCell(10)?.getChars(), '│', 'exposed divider stays visible')
    assert.equal(screen.buffer.active.getLine(4)?.getCell(10)?.getChars().trim(), '', 'floating paint occludes the divider')
    assert.equal(output.match(/\x1b\[\?25[hl]/gu)?.at(-1), '\x1b[?25l', 'an underlying cursor cannot appear through a floating terminal')
    const target = client.paneContext({ column: 10, row: 4, cols: 20, rows: 6, layout: frame.layout })
    assert.equal(target?.paneId, 'floating')
    const content = await client.content(), base = content!.find(pane => pane.id === 'pane')!, floating = content!.find(pane => pane.id === 'floating')!
    assert.equal(base.cwd, '/tmp/base'); assert.equal(floating.cwd, '/tmp/floating')
    assert.deepEqual(base.lines, ['BASE0', 'BASE1', 'BASE2', '', '', ''])
    assert.equal(base.links.length, 0, 'floating links are never attributed to the underlying working directory')
    assert.equal(floating.links[0]?.url, 'file:///tmp/floating/report.pdf')
    const before = f.sent.length
    client.write('\x1b[<0;11;5M\x1b[<0;11;5m')
    await tick(); await client.completionFence()
    const input = f.sent.slice(before).filter(frame => frame.kind === 0)
    assert(input.length > 0)
    assert(input.every(frame => frame.channel === 3), 'clicking a covered divider sends input only to the visible floating pane')
    f.streams[0]!.receive({ kind: 'data', data: Buffer.from('\x1b[?1000l') })
    await tick(); await client.completionFence()
    client.write('\x1b[<0;3;2M'); await tick(); await client.completionFence()
    client.write('\x1b[<32;6;5M'); await tick(); await client.completionFence()
    await new Promise<void>(resolve => screen.write('', resolve))
    assert.equal(screen.buffer.active.getLine(3)?.getCell(2)?.isInverse(), 0, 'selection in a lower pane cannot highlight the floating pane')
    const copyBefore = output.length
    client.write('\x1b[<0;6;5m'); await tick(); await client.completionFence()
    const copied = output.slice(copyBefore).match(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/u)?.[1]
    assert(copied, 'visible selection still produces a clipboard response')
    const selectedText = Buffer.from(copied, 'base64').toString()
    assert(selectedText.includes('BASE2'))
    assert(!selectedText.includes('BASE3') && !selectedText.includes('BASE4') && !selectedText.includes('FLOAT'), 'copy only includes this pane\'s exposed selected cells')
    assert.equal(f.failures.length, 0)
  } finally { client.kill(); screen.dispose() }
})

test('a fully covered pane cannot be read and unsupported floating blocks absorb input', async () => {
  const f = fixture(true), root = f.document.spaces[0]!.tabs[0]!.root
  root.children!.splice(1)
  root.floating = [{ id: 'floating', edge: 'left', content: { terminal: 't2' } }, { id: 'mod', edge: 'right', content: { mod: 'files' } }]
  f.terminal.status.state = 'idle'; f.terminal.turn = 1
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick()
  f.streams[0]!.receive({ kind: 'data', data: Buffer.from('UNSEEN RESULT\x1b[?9001l' + report('idle')) })
  f.streams[1]!.receive({ kind: 'data', data: Buffer.from('FLOAT\x1b[?9001l') })
  const client = await opening
  try {
    client.onData(() => {})
    const frame = await client.completionFence()
    assert.equal(frame?.panes.find(pane => pane.id === 'pane')?.completion, undefined)
    await client.acknowledgeCompletion?.('pane', { bootId: 'core', sequence: 1 })
    assert.equal(f.terminal.labels['herdr.seen'], undefined, 'a covered completed pane remains unread')
    assert.deepEqual((await client.content())?.map(pane => pane.id), ['floating'])
    assert(frame?.layout)
    assert.equal(client.paneContext({ column: 15, row: 2, cols: 20, rows: 6, layout: frame.layout })?.paneId, 'mod')
    const before = f.sent.length
    client.write('\x1b[<0;16;3M\x1b[<0;16;3m')
    await tick(); await tick()
    assert.equal(f.sent.slice(before).filter(frame => frame.kind === 0).length, 0, 'placeholder clicks cannot reach the covered native terminal')
  } finally { client.kill() }
})

test('wide characters crossing an overlay edge never cover or copy through the top pane', async () => {
  for (const wide of ['中', '🦊']) {
    const f = fixture(true), root = f.document.spaces[0]!.tabs[0]!.root
    root.children!.splice(1)
    root.floating = [{ id: 'floating', edge: 'right', content: { terminal: 't2' } }]
    const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
    await tick()
    f.streams[0]!.receive({ kind: 'data', data: Buffer.from(`123456789${wide}\x1b[?9001l`) })
    f.streams[1]!.receive({ kind: 'data', data: Buffer.from('FLOAT\x1b[?9001l') })
    const client = await opening, screen = new headless.Terminal({ cols: 20, rows: 6, allowProposedApi: true })
    try {
      let output = ''; client.onData(data => { output += data; screen.write(data) })
      await client.completionFence(); await new Promise<void>(resolve => screen.write('', resolve))
      assert.equal(screen.buffer.active.getLine(0)?.getCell(10)?.getChars(), 'F', 'the lower wide character must not consume the top pane\'s first cell')
      assert.equal((await client.content())?.find(pane => pane.id === 'pane')?.lines[0], '123456789', 'scan omits a partially covered wide character')
      client.write('\x1b[<0;1;1M'); await tick(); await client.completionFence()
      client.write('\x1b[<32;10;1M'); await tick(); await client.completionFence()
      const before = output.length
      client.write('\x1b[<0;10;1m'); await tick(); await client.completionFence()
      const copied = output.slice(before).match(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/u)?.[1]
      assert(copied)
      assert.equal(Buffer.from(copied, 'base64').toString(), '123456789', 'selection never copies a partially covered wide character')
    } finally { client.kill(); screen.dispose() }
  }
})

test('a delayed older document cannot remove a window already restored by a newer pane action', async () => {
  const f = fixture(), spaces = structuredClone(f.document.spaces)
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('READY\x1b[?9001l') })
  const client = await opening
  try {
    client.onData(() => {})
    const exits: unknown[] = []; client.onExit(value => exits.push(value))
    const snapshot = f.layout.snapshot.bind(f.layout)
    let release!: () => void, observed!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), captured = new Promise<void>(resolve => { observed = resolve })
    f.layout.snapshot = async () => {
      const state = await snapshot()
      if (state.documentVersion === 2) { observed(); await gate }
      return state
    }
    f.document.spaces = []; f.controls.documentVersion = 2
    const delayed = f.event('doc', {})
    await captured
    f.document.spaces = spaces; f.controls.documentVersion = 3
    await client.paneAction({ bootId: 'core', paneId: 'pane', name: '' }, { action: 'zoom' })
    release(); await delayed
    assert.deepEqual(exits, [], 'the obsolete missing-window snapshot must not close the restored view')
    assert.equal(client.completionSnapshot()?.windows[0]?.id, 'tab')
    await f.event('title', { title: 'Current title' })
    assert.equal(client.completionSnapshot()?.windows[0]?.panes[0]?.terminalTitle, 'Current title', 'same-document live metadata keeps updating')
  } finally { client.kill() }
})

test('core first paint waits for its trailing native marker and preserves the native grid', async () => {
  const f = fixture()
  let ready = false
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 }).then(client => { ready = true; return client })
  await tick()
  f.stream.receive({ kind: 'data', data: Buffer.from('\x1b[2J\x1b[HABCDEFGHIJKLMNOPQRSTUVWXYZ\r\nsecond row') })
  await tick(); await tick()
  assert.equal(ready, false, 'a partial DATA chunk cannot expose an incomplete initial screen')
  f.stream.receive({ kind: 'data', data: Buffer.from('\x1b[?9001l' + report('working')) })
  const client = await opening
  try {
    let output = ''; client.onData(data => { output += data })
    await tick()
    const content = await client.content()
    assert.equal(content?.[0]?.lines[0], 'ABCDEFGHIJKLMNOPQRST')
    assert.equal(content?.[0]?.lines[1], 'second row', 'native 80-column paint is not parsed as the 20-column card')
    const screen = new headless.Terminal({ cols: 20, rows: 6, allowProposedApi: true })
    await new Promise<void>(resolve => screen.write(output, resolve))
    assert.equal(screen.buffer.active.getLine(1)?.translateToString(true).trimEnd(), 'second row')
    screen.dispose()
    assert.equal(f.failures.length, 0)
  } finally { client.kill() }
})

test('completion events cannot acknowledge result bytes which have not reached the pane parser', async () => {
  const f = fixture()
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick()
  f.stream.receive({ kind: 'data', data: Buffer.from('Working\x1b[?9001l' + report('working')) })
  const client = await opening
  try {
    const frames: WindowMetadata[] = []; client.onData(() => {}); client.onFrame(frame => frames.push(frame)); await tick()
    f.terminal.status.state = 'idle'; f.terminal.turn = 1
    await f.event('status', { status: { state: 'idle' }, records: {}, reported: true })
    await f.event('turn', { turn: 1, state: 'idle' })
    const pending = await client.completionFence()
    assert.equal(pending?.panes[0]?.completion, undefined)
    await client.acknowledgeCompletion?.('pane', { bootId: 'core', sequence: 1 })
    assert.equal(f.terminal.labels['herdr.seen'], undefined, 'an early event cannot mark invisible output read')
    f.stream.receive({ kind: 'data', data: Buffer.from('\r\nRESULT' + report('idle')) })
    await tick(); await client.content(); await client.completionFence()
    assert.equal(frames.at(-1)?.panes[0]?.completion?.sequence, 1)
    await client.acknowledgeCompletion?.('pane', { bootId: 'core', sequence: 1 })
    assert.equal(f.terminal.labels['herdr.seen'], '1')
    assert.equal(f.failures.length, 0)
  } finally { client.kill() }
})

test('core live OSC 8 retains Unicode file paths and concealed cells remain masked', async () => {
  const f = fixture()
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 40, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('\x1b[?9001l') })
  const client = await opening
  try {
    client.onData(() => {})
    f.stream.receive({ kind: 'data', data: Buffer.from('\x1b[H\x1b]8;;file:///tmp/扫描 文件.txt\x1b\\report\x1b]8;;\x1b\\\r\n\x1b[8mCONCEALED\x1b[0m') })
    await tick(); await tick()
    const content = await client.content()
    assert.equal(content?.[0]?.links[0]?.url, 'file:///tmp/%E6%89%AB%E6%8F%8F%20%E6%96%87%E4%BB%B6.txt')
    assert.equal(content?.[0]?.links[0]?.label, 'report')
    assert(!content?.[0]?.lines.some(line => line.includes('CONCEALED')))
    assert.equal(coreHyperlink('https://example.test/a b'), 'https://example.test/a%20b')
    assert.equal(coreHyperlink('file:///tmp/a\nb'), undefined)
  } finally { client.kill() }
})

test('coalesced native repaint never marks an unverified turn read and a fresh attach restores read continuity', async () => {
  const f = fixture()
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('Working\x1b[?9001l' + report('working')) })
  const client = await opening
  try {
    client.onData(() => {})
    // A slow native viewer can receive every semantic event while its byte
    // backlog is replaced by one latest paint, omitting intermediate reports.
    f.terminal.status.state = 'idle'; f.terminal.turn = 2
    await f.event('status', { status: { state: 'idle' }, records: {}, reported: true })
    await f.event('turn', { turn: 2, state: 'idle' })
    f.stream.receive({ kind: 'data', data: Buffer.from('\x18\x1b[2J\x1b[HLATEST RESULT\x1b[?9001l' + report('idle')) })
    await tick(); await client.content()
    const frame = await client.completionFence()
    assert.equal(frame?.panes[0]?.completion, undefined, 'an event sequence cannot stand in for missing program reports')
    await client.acknowledgeCompletion?.('pane', { bootId: 'core', sequence: 2 })
    assert.equal(f.terminal.labels['herdr.seen'], undefined)
  } finally { client.kill() }

  const reconnected = fixture()
  reconnected.terminal.turn = 2; reconnected.terminal.status.state = 'idle'
  const attaching = createCoreClient({ rpc: reconnected.rpc, layout: reconnected.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 6 })
  await tick(); reconnected.stream.receive({ kind: 'data', data: Buffer.from('LATEST RESULT\x1b[?9001l' + report('idle')) })
  const fresh = await attaching
  try {
    fresh.onData(() => {}); await tick()
    await fresh.acknowledgeCompletion?.('pane', { bootId: 'core', sequence: 2 })
    assert.equal(reconnected.terminal.labels['herdr.seen'], '2', 'fresh native attach and complete paint establish the new baseline')
  } finally { fresh.kill() }
})

test('core scans recover native soft wraps without removing real filename spaces or hard newlines', async () => {
  const f = fixture(); f.terminal.cols = 20; f.terminal.rows = 8
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 8 })
  const path = '/tmp/' + 'a'.repeat(14) + ' file.png'
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('\x1b[32m' + path + '\x1b[0m\r\nHARD_ONE\r\nHARD_TWO\x1b[?9001l') })
  const client = await opening
  try {
    const content = await client.content()
    assert.equal(content?.[0]?.lines[0], path, 'space at the wrap boundary is part of the filename')
    assert(!content?.[0]?.coloredText?.includes(path.replace(' ', '')), 'color hints cannot silently delete filename spaces')
    assert.deepEqual(content?.[0]?.lines.slice(1, 3), ['HARD_ONE', 'HARD_TWO'])
  } finally { client.kill() }
})

test('Core drag selection preserves spaces across soft wraps and trims logical line endings', async () => {
  for (const sample of [
    { data: 'abc  def', end: [3, 2], expected: 'abc  def' },
    { data: 'ab   c   de', end: [1, 3], expected: 'ab   c   de' },
    { data: 'abc    ', end: [2, 2], expected: 'abc' },
    { data: 'abc\u00a0', end: [4, 1], expected: 'abc\u00a0' },
    { data: 'ab\u3000', end: [4, 1], expected: 'ab\u3000' },
    { data: 'abc  de  \r\nXYZ  ', end: [5, 3], expected: 'abc  de\nXYZ', reverse: true },
  ]) {
    const f = fixture(); f.terminal.cols = 5; f.terminal.rows = 4
    const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 5, rows: 4 })
    await tick(); f.stream.receive({ kind: 'data', data: Buffer.from(sample.data + '\x1b[?9001l') })
    const client = await opening
    try {
      let output = ''; client.onData(data => { output += data })
      await client.completionFence()
      const [start, end] = sample.reverse ? [sample.end, [1, 1]] : [[1, 1], sample.end]
      client.write(`\x1b[<0;${start!.join(';')}M`); await tick(); await client.completionFence()
      client.write(`\x1b[<32;${end!.join(';')}M`); await tick(); await client.completionFence()
      client.write(`\x1b[<0;${end!.join(';')}m`); await tick(); await client.completionFence()
      const copied = output.match(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/u)?.[1]
      assert(copied, 'the ordinary mouse selection produces clipboard text')
      assert.equal(Buffer.from(copied, 'base64').toString(), sample.expected)
      assert.deepEqual(f.failures, [])
    } finally { client.kill() }
  }
})

test('Core hover follows native tracking without clearing history, focusing or repainting', async () => {
  const f = fixture(); f.terminal.cols = 20; f.terminal.rows = 3
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 3 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('line1\r\nline2\r\nline3\r\nline4\r\nline5\r\nline6\x1b[?9001l') })
  const client = await opening
  try {
    let frames = 0, output = ''; client.onData(data => { frames++; output += data })
    await client.completionFence()
    assert(output.includes('\x1b[?1003h'), 'the outer surface requests passive moves')
    const bottom = (await client.content())?.[0]?.lines
    client.write('\x1b[<64;1;1M'); await tick(); await tick()
    const history = (await client.content())?.[0]?.lines
    assert.notDeepEqual(history, bottom)
    for (const mode of [1002, 1003]) {
      f.stream.receive({ kind: 'data', data: Buffer.from(`\x1b[?${mode}h\x1b[?1006h`) })
      await tick(); await client.content()
      const before = f.sent.length, painted = frames
      client.write('\x1b[<35;2;2M'); await tick(); await tick()
      assert.deepEqual((await client.content())?.[0]?.lines, history, `${mode}: hover never jumps to live output`)
      assert.equal(frames, painted, 'passive input does not force a render')
      assert.deepEqual(f.sent.slice(before).map(frame => ({ kind: frame.kind, data: frame.data.toString() })),
        mode === 1003 ? [{ kind: 0, data: '\x1b[<35;2;2M' }] : [], 'only a native ANY-motion application receives hover')
    }
    assert.deepEqual(f.failures, [])
  } finally { client.kill() }
})

test('Core typing and paste repaint the bottom immediately without waiting for program output', async () => {
  for (const input of ['x', '\x1b[200~hello\x1b[201~']) {
    const f = fixture(); f.terminal.cols = 20; f.terminal.rows = 3
    const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 20, rows: 3 })
    await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('line1\r\nline2\r\nline3\r\nline4\r\nline5\r\nline6\x1b[?9001l') })
    const client = await opening
    try {
      let frames = 0; client.onData(() => { frames++ })
      await client.completionFence()
      const bottom = (await client.content())?.[0]?.lines
      client.write('\x1b[<64;1;1M'); await tick(); await tick()
      assert.notDeepEqual((await client.content())?.[0]?.lines, bottom)
      const before = frames
      client.write(input); await tick(); await tick()
      assert(frames > before, 'input redraws a changed scroll position without any native output')
      assert.deepEqual((await client.content())?.[0]?.lines, bottom)
      assert.equal(f.sent.filter(frame => frame.kind === 0).at(-1)?.data.toString(), input === 'x' ? 'x' : 'hello')
      const settled = frames
      client.write('y'); await tick(); await tick()
      assert.equal(frames, settled, 'ordinary input at the bottom adds no forced repaint')
      assert.deepEqual(f.failures, [])
    } finally { client.kill() }
  }
})
