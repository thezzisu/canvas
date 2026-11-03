import assert from 'node:assert/strict'
import test from 'node:test'
import headless from '@xterm/headless'
import { createCoreClient, coreHyperlink } from './client.ts'
import { CoreLayout, type CoreDocument } from './layout.ts'
import { CoreRpc, CoreStream, type CoreNotification } from './rpc.ts'
import type { WindowMetadata } from '../../shared/window-metadata.ts'
import type { TerminalFrame } from '../herdr/client.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const report = (state: string) => `\x1b]7501;state=${state}:app=fixture\x1b\\`

function fixture(split = false) {
  const terminal = { address: 't1', labels: {} as Record<string, string>, state: 'live', status: { state: 'working' }, turn: 0, cols: 80, rows: 10, cwd: '/tmp', pid: 123 }
  const terminals = split ? [terminal, { ...terminal, address: 't2', pid: 124 }] : [terminal]
  const document: CoreDocument = { spaces: [{ id: 'space', name: 'Space', folder: '/tmp', tabs: [{ id: 'tab', name: 'Tab', root: { id: 'tab', type: 'row', children: [{ id: 'pane', type: 'block', content: { terminal: 't1' } }] } }] }] }
  if (split) document.spaces[0]!.tabs[0]!.root.children!.push({ id: 'second', type: 'block', content: { terminal: 't2' } })
  let onEvent: ((event: CoreNotification) => void | Promise<void>) | undefined
  const failures: Error[] = [], sent: Array<{ channel: number; kind: number; data: Buffer }> = [], attached: string[] = [], streams: CoreStream[] = []
  const controls: { attachGate?: Promise<void>; failAttach?: boolean; documentVersion: number } = { documentVersion: 1 }
  const rpc = {
    connected: true,
    hello: { core: { id: 'core', name: 'Fixture' }, version: '0.1.17' },
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'server.status') return { core: { id: 'core' }, version: '0.1.17' }
      if (method === 'terminal.list') return { terminals: structuredClone(terminals) }
      if (method === 'doc.get') return { value: structuredClone(document), version: controls.documentVersion }
      if (method === 'terminal.get') return structuredClone(terminal)
      if (method === 'terminal.label') { Object.assign(terminal.labels, params.labels); return structuredClone(terminal) }
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
    async subscribe(_params: unknown, callback: typeof onEvent) { onEvent = callback; return { snapshot: { seq: 0, terminals: [structuredClone(terminal)] }, start() {}, close() {} } },
    onClose() { return { dispose() {} } },
    send(channel: number, kind: number, data: Buffer) { sent.push({ channel, kind, data }) },
    retire() {},
    fail(error: Error) { failures.push(error) },
  } as unknown as CoreRpc
  const stream = new CoreStream(1, rpc), layout = new CoreLayout(rpc)
  const event = async (type: string, data: Record<string, unknown>) => { await onEvent?.({ method: 'event', params: { seq: 1, terminal: 't1', type, data } }); await tick() }
  return { rpc, stream, streams, attached, controls, layout, terminal, terminals, document, sent, failures, event }
}

test('widening a narrow core view attaches newly exposed panes before publishing the expanded frame', async () => {
  const f = fixture(true)
  const opening = createCoreClient({ rpc: f.rpc, layout: f.layout, spaceId: 'space', tabId: 'tab', cols: 2, rows: 6 })
  await tick(); f.stream.receive({ kind: 'data', data: Buffer.from('LEFT\x1b[?9001l') })
  const client = await opening
  try {
    const frames: TerminalFrame[] = []; let output = ''
    client.onData(data => { output += data }); client.onFrame(frame => frames.push(frame)); await tick()
    assert.deepEqual(f.attached, ['t1'])
    assert.equal(frames.at(-1)?.cols, 2)
    const before = frames.length
    client.resize(40, 6)
    await tick(); await tick()
    assert.deepEqual(f.attached, ['t1', 't2'], 'newly exposed panes attach without an unrelated core event')
    assert.equal(frames.length, before, 'wait for the newly exposed pane\'s complete paint')
    f.streams[1]!.receive({ kind: 'data', data: Buffer.from('RIGHT\x1b[?9001l') })
    await tick(); await tick()
    assert(!output.includes('Terminal unavailable'))
    assert.deepEqual((await client.content())?.map(pane => pane.lines[0]?.trim()), ['LEFT', 'RIGHT'])
    assert.deepEqual({ cols: frames.at(-1)?.cols, rows: frames.at(-1)?.rows }, { cols: 40, rows: 6 })
    assert.equal(frames[0]?.cols, 2, 'later geometry cannot relabel an earlier queued frame')
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
