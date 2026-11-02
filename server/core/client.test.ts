import assert from 'node:assert/strict'
import test from 'node:test'
import headless from '@xterm/headless'
import { createCoreClient, coreHyperlink } from './client.ts'
import { CoreLayout } from './layout.ts'
import { CoreRpc, CoreStream, type CoreNotification } from './rpc.ts'
import type { WindowMetadata } from '../../shared/window-metadata.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const report = (state: string) => `\x1b]7501;state=${state}:app=fixture\x1b\\`

function fixture() {
  const terminal = { address: 't1', labels: {} as Record<string, string>, state: 'live', status: { state: 'working' }, turn: 0, cols: 80, rows: 10, cwd: '/tmp', pid: 123 }
  const document = { spaces: [{ id: 'space', name: 'Space', folder: '/tmp', tabs: [{ id: 'tab', name: 'Tab', root: { id: 'tab', type: 'row', children: [{ id: 'pane', type: 'block', content: { terminal: 't1' } }] } }] }] }
  let onEvent: ((event: CoreNotification) => void | Promise<void>) | undefined
  const failures: Error[] = [], sent: Array<{ channel: number; kind: number; data: Buffer }> = []
  const rpc = {
    hello: { core: { id: 'core', name: 'Fixture' }, version: '0.1.17' },
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'server.status') return { core: { id: 'core' }, version: '0.1.17' }
      if (method === 'terminal.list') return { terminals: [structuredClone(terminal)] }
      if (method === 'doc.get') return { value: structuredClone(document), version: 1 }
      if (method === 'terminal.get') return structuredClone(terminal)
      if (method === 'terminal.label') { Object.assign(terminal.labels, params.labels); return structuredClone(terminal) }
      throw new Error('Unexpected fixture method: ' + method)
    },
    async attach() { return { terminal: structuredClone(terminal), channel: 1, stream } },
    async subscribe(_params: unknown, callback: typeof onEvent) { onEvent = callback; return { snapshot: { seq: 0, terminals: [structuredClone(terminal)] }, start() {}, close() {} } },
    onClose() { return { dispose() {} } },
    send(channel: number, kind: number, data: Buffer) { sent.push({ channel, kind, data }) },
    retire() {},
    fail(error: Error) { failures.push(error) },
  } as unknown as CoreRpc
  const stream = new CoreStream(1, rpc), layout = new CoreLayout(rpc)
  const event = async (type: string, data: Record<string, unknown>) => { await onEvent?.({ method: 'event', params: { seq: 1, terminal: 't1', type, data } }); await tick() }
  return { rpc, stream, layout, terminal, sent, failures, event }
}

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
