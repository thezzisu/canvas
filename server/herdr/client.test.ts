import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHerdrClient, type HerdrClientExit } from './client.ts'
import { Writer } from './wire.ts'
import type { WindowMetadata } from '../../shared/window-metadata.ts'
import type { NativeNotification } from '../../shared/notification.ts'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await delay(5) } assert.fail('fixture state did not settle') }
function framed(payload: Buffer) { const prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length); return Buffer.concat([prefix, payload]) }
function readHeader(payload: Buffer) {
  let offset = 1
  const uint = () => { const marker = payload[offset++]!; if (marker < 251) return marker; const count = marker === 251 ? 2 : marker === 252 ? 4 : 8; const value = count === 2 ? payload.readUInt16LE(offset) : count === 4 ? payload.readUInt32LE(offset) : Number(payload.readBigUInt64LE(offset)); offset += count; return value }
  const string = () => { const count = uint(), value = payload.subarray(offset, offset + count).toString(); offset += count; return value }
  return { tag: payload[0]!, string }
}

async function fixture(t: TestContext, options: { holdFocus?: boolean; badWelcome?: boolean; closeEarly?: boolean; missingTarget?: boolean; readSelection?: (params: Record<string, unknown>) => Promise<unknown>; readContent?: (params: Record<string, unknown>) => Promise<unknown> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cv-native-')), path = join(directory, 'client.sock')
  const sockets = new Set<Socket>(), requests: { id: string; method: string; params: Record<string, unknown> }[] = [], tags: number[] = [], focuses: boolean[] = []
  let peer: Socket, pending = Buffer.alloc(0), hello: Record<string, unknown> | undefined
  const send = (writer: Writer) => peer.write(framed(writer.finish()))
  const control = (kind: string, value: unknown) => send(new Writer().uint(20).string(kind).string(JSON.stringify(value)))
  const snapshot = (revision = 1, focused = 'target', boot = 'boot', pane = 'pane') => control('shell.snapshot.v1', {
    boot_id: boot, revision, focused_workspace_id: 'space', focused_tab_id: focused, focused_pane_id: pane,
    tabs: [{ tab_id: 'target', workspace_id: 'space', focused: focused === 'target' }, { tab_id: 'other', workspace_id: 'space', focused: focused === 'other' }],
    panes: [{ pane_id: pane, tab_id: 'target', workspace_id: 'space', focused: true, right_click_passthrough: false }],
  })
  const removeTarget = (revision = 2, boot = 'boot') => control('shell.snapshot.v1', {
    boot_id: boot, revision, focused_workspace_id: 'space', focused_tab_id: 'other', focused_pane_id: null,
    tabs: [{ tab_id: 'other', workspace_id: 'space', focused: true }], panes: [],
  })
  const surface = (revision = 1, surfaceRevision = 1, text = 'READY', boot = 'boot', pane = 'pane') => {
    const writer = new Writer().uint(13).string(boot).uint(revision).uint(surfaceRevision)
    writer.uint(8)
    for (let i = 0; i < 8; i++) writer.string(text[i] || ' ').uint(0).uint(0).uint(0).bool(false).byte(0)
    writer.uint(8).uint(1).byte(0).uint(0).uint(0) // frame dimensions, cursor, links, graphics
    writer.uint(1).string(pane).uint(surfaceRevision)
    for (let i = 0; i < 2; i++) writer.uint(0).uint(0).uint(8).uint(1)
    writer.byte(0).byte(0).bool(true).bool(false).bool(false).bool(false).uint(0).uint(0)
    writer.uint(0).byte(0).uint(0).uint(0).uint(0) // splits, popup, graphics scene
    send(writer)
  }
  const response = (request = requests.at(-1)!, error?: string) => {
    const body = Buffer.from(JSON.stringify({ id: request.id, ...(error ? { error: { message: error } } : { result: { tab_id: 'target' } }) }))
    send(new Writer().uint(18).string('boot').string(request.id).bool(true).bytes(body))
  }
  const server = createServer(socket => {
    peer = socket; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    if (options.closeEarly) { socket.end(); return }
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE()) {
        const length = pending.readUInt32LE(), payload = pending.subarray(4, 4 + length); pending = pending.subarray(4 + length)
        const header = readHeader(payload); tags.push(header.tag)
        if (header.tag === 20) {
          assert.equal(header.string(), 'endpoint.hello.v1'); hello = JSON.parse(header.string())
          control('endpoint.welcome.v1', { generation: options.badWelcome ? 2 : 1, snapshot_codec: 'shell.snapshot.v1', surface_codec: 'shell.surface.v1',
            input_codec: 'shell.input.semantic.v1', blob_codec: 'shell.blob.v1', methods: ['tab.focus', 'pane.focus', 'pane.scroll'] })
          if (options.missingTarget) removeTarget(1)
          else { snapshot(); surface() }
        } else if (header.tag === 15) {
          assert.equal(header.string(), 'boot')
          requests.push(JSON.parse(header.string()))
          if (!options.holdFocus) response()
        } else if (header.tag === 18) focuses.push(payload[1] === 1)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
  return { path, requests, tags, focuses, snapshot, removeTarget, surface, response, control, send, peer: () => peer, hello: () => hello,
    connect: (handshakeTimeoutMs = 300) => createHerdrClient({ socketPath: path, tabId: 'target', cols: 8, rows: 1, handshakeTimeoutMs, readSelection: options.readSelection, readContent: options.readContent }) }
}

test('native notifications remain source-wide ephemeral events, separate from terminal text', async t => {
  const f = await fixture(t), client = await f.connect()
  t.after(() => client.kill())
  const events: NativeNotification[] = [], late: NativeNotification[] = []
  let output = ''
  client.onData(data => { output += data })
  await until(() => output.includes('R') && output.includes('\x1b[?2004h'))
  const subscription = client.onNotification(value => events.push(value))
  const before = output
  f.send(new Writer().uint(14).uint(0).string('Input needed').byte(1).string('A different pane')
    .byte(1).uint(1).byte(1).string('codex').byte(1).string('space').byte(1).string('other').byte(1).string('other-pane').byte(1).uint(0))
  await until(() => events.length === 1)
  assert.deepEqual(events[0], { kind: 'attention', title: 'Input needed', body: 'A different pane', agent: 'codex',
    spaceId: 'space', windowId: 'other', paneId: 'other-pane' })
  assert.equal(output, before)
  client.onNotification(value => late.push(value))
  await delay(10)
  assert.deepEqual(late, [], 'new listeners never replay past notifications')
  subscription.dispose()
  f.send(new Writer().uint(14).uint(3).string('Next').byte(0).byte(0).byte(0).byte(0).byte(0).byte(0).byte(0))
  await until(() => late.length === 1)
  assert.equal(events.length, 1)
})

test('native client waits for focus and buffers its initial frame until asynchronous listener installation', async t => {
  const f = await fixture(t, { holdFocus: true })
  let resolved = false
  const pending = f.connect().then(client => { resolved = true; return client })
  await until(() => f.requests.length === 1)
  assert.equal(resolved, false)
  assert.equal(f.hello()?.surface_reuse, false)
  assert.equal(f.requests[0]?.method, 'tab.focus')
  f.response()
  const client = await pending
  t.after(() => client.kill())
  let output = '', registering = true
  client.onData(data => { assert.equal(registering, false); output += data })
  registering = false
  await until(() => output.includes('R') && output.includes('\x1b[?2004h'))
})

test('snapshot and full-surface revisions must pair before presenting, while old frames cannot replace current output', async t => {
  const f = await fixture(t), client = await f.connect()
  t.after(() => client.kill())
  let output = ''; client.onData(data => output += data); await delay(10); output = ''
  f.surface(2, 2, 'FUTURE'); await delay(10)
  assert.equal(output, '')
  f.snapshot(2); await until(() => output.includes('F'))
  output = ''; f.surface(1, 1, 'OLD'); await delay(10); assert.equal(output, '')
  f.snapshot(1); await delay(10); assert.equal(output, '')
  let exit: number | undefined; client.onExit(value => exit = value.exitCode)
  f.snapshot(1, 'target', 'another-boot'); await until(() => exit !== undefined); assert.equal(exit, 1)
})

test('content scan reads current visible text once even while rendered revisions change', async t => {
  let currentText = 'READY'
  const reads: Record<string, unknown>[] = []
  const f = await fixture(t, { readContent: async params => {
    reads.push(params)
    return { pane_id: 'pane', text: currentText }
  } }), client = await f.connect()
  t.after(() => client.kill())
  await delay(10)
  const before = [...f.tags]
  assert.deepEqual((await client.content())?.map(pane => pane.lines), [['READY']])
  assert.deepEqual(reads[0], { pane_id: 'pane', source: 'visible', format: 'text', strip_ansi: true })
  currentText = 'NEW'; f.snapshot(2); await delay(10)
  assert.deepEqual((await client.content())?.map(pane => pane.lines), [['NEW']])
  currentText = 'NEXT'; f.surface(3, 3, 'NEXT'); await delay(10)
  assert.deepEqual((await client.content())?.map(pane => pane.lines), [['NEXT']])
  assert.equal(reads.length, 3)
  assert.deepEqual(f.tags, before)
  client.kill()
  assert.equal(await client.content(), undefined)
})

test('failed native content reads return a partial scan without stale screen text', async t => {
  const f = await fixture(t, { readContent: async () => { throw new Error('connection failed') } }), client = await f.connect()
  t.after(() => client.kill())
  const panes = await client.content()
  assert.equal(panes?.[0]?.incomplete, true)
  assert.deepEqual(panes?.[0]?.lines, [])
})

test('native client pause/resume preserves queued display and cleanup reports one exit', async t => {
  const f = await fixture(t), client = await f.connect()
  let output = '', exits = 0; client.onData(data => output += data); client.onExit(() => exits++)
  await delay(10); output = ''; client.pause()
  f.snapshot(2); f.surface(2, 2, 'PAUSED'); await delay(20); assert.equal(output, '')
  client.resume(); await until(() => output.includes('P'))
  client.kill(); client.kill(); await delay(10); assert.equal(exits, 1)
  client.write('ignored'); client.resume()
})

test('pane focus follows coherent endpoint surfaces, replays to late listeners and ignores the outer herdr title', async t => {
  const f = await fixture(t), client = await f.connect()
  t.after(() => client.kill())
  const focused: (string | undefined)[] = []
  let output = ''
  client.onData(data => output += data)
  const subscription = client.onPaneFocus(pane => focused.push(pane))
  await until(() => focused.length === 1)
  assert.deepEqual(focused, ['pane'])
  f.surface(1, 2); await delay(10)
  assert.equal(focused.length, 1, 'unchanged focus does not emit metadata')
  f.snapshot(2, 'target', 'boot', 'second'); await delay(10)
  assert.equal(focused.length, 1, 'snapshot does not overtake its matching surface')
  f.surface(2, 3, 'SECOND', 'boot', 'second')
  await until(() => focused.length === 2)
  assert.deepEqual(focused, ['pane', 'second'])
  const late: (string | undefined)[] = []
  client.onPaneFocus(pane => late.push(pane))
  await until(() => late.length === 1)
  assert.deepEqual(late, ['second'])
  subscription.dispose()
  f.send(new Writer().uint(6).byte(1).string('hostname: outer workspace'))
  await delay(10)
  assert(!output.includes('\x1b]0;'), 'outer title must not masquerade as a pane title')
})

test('input waits behind a serialized tab-focus barrier and cannot escape before its acknowledgement', async t => {
  const f = await fixture(t, { holdFocus: true }), pending = f.connect()
  await until(() => f.requests.length === 1); f.response(); const client = await pending
  t.after(() => client.kill()); client.onData(() => {})
  client.write('one'); client.write('two')
  await until(() => f.requests.length === 2)
  assert.equal(f.tags.includes(13), false)
  f.response(); await until(() => f.tags.includes(13))
  assert.equal(f.requests.length, 2, 'the pending input burst shares one focus request')
})

test('passive focus loss never focuses a tab and remains ordered behind already queued user input', async t => {
  const f = await fixture(t, { holdFocus: true }), pending = f.connect()
  await until(() => f.requests.length === 1); f.response(); const client = await pending
  t.after(() => client.kill()); client.onData(() => {})
  client.write('\x1b[O')
  await until(() => f.focuses.length === 1)
  client.write(Buffer.from('\x1b[O'))
  await until(() => f.focuses.length === 2)
  assert.deepEqual(f.focuses, [false, false])
  assert.equal(f.requests.length, 1, 'passive focus loss must not send tab.focus')
  assert.equal(f.tags.includes(13), false, 'focus reports are not pane input')

  client.write('q')
  await until(() => f.requests.length === 2)
  const mark = f.tags.length
  client.write('\x1b[O')
  await delay(10)
  assert.equal(f.focuses.length, 2, 'blur must not overtake an already queued key or mouse press')
  f.response()
  await until(() => f.focuses.length === 3)
  assert.deepEqual(f.tags.slice(mark), [13, 18], 'queued user input precedes its focus loss')
  assert.equal(f.requests.length, 2, 'only explicit user input claims tab focus')
  assert.deepEqual(f.focuses, [false, false, false])
})

test('native client rejects incomplete handshakes and closes malformed established streams', async t => {
  for (const options of [{ badWelcome: true }, { closeEarly: true }, { holdFocus: true }]) {
    const f = await fixture(t, options)
    await assert.rejects(f.connect(50), /protocol|generation|closed|timed out/i)
  }
  const f = await fixture(t), client = await f.connect(); client.onData(() => {})
  let code: number | undefined; client.onExit(exit => code = exit.exitCode)
  f.peer().end(Buffer.from([20, 0, 0, 0, 20]))
  await until(() => code !== undefined); assert.equal(code, 1)
})

test('only an authoritative missing-tab snapshot confirms removal, with one exit and accurate late replay', async t => {
  const f = await fixture(t), client = await f.connect(), exits: HerdrClientExit[] = []
  client.onExit(exit => exits.push(exit))
  client.write('\x04')
  await until(() => f.tags.includes(13))
  assert.deepEqual(exits, [], 'Ctrl+D alone is not proof that a native tab closed')
  f.removeTarget()
  await until(() => exits.length === 1)
  assert.deepEqual(exits, [{ exitCode: 0, reason: 'removed' }])
  client.kill(); client.write('ignored')
  const late: HerdrClientExit[] = []
  client.onExit(exit => late.push(exit))
  await until(() => late.length === 1)
  assert.deepEqual(late, exits)
  await delay(10)
  assert.equal(exits.length, 1, 'socket cleanup or kill emitted a second exit')
})

test('stale missing-tab snapshots and pane-only changes never remove a surviving tab', async t => {
  const f = await fixture(t), client = await f.connect(), exits: HerdrClientExit[] = [], panes: (string | undefined)[] = []
  t.after(() => client.kill())
  client.onExit(exit => exits.push(exit)); client.onPaneFocus(pane => panes.push(pane))
  f.snapshot(2, 'target', 'boot', 'remaining-pane'); f.surface(2, 2, 'REMAIN', 'boot', 'remaining-pane')
  await until(() => panes.at(-1) === 'remaining-pane')
  f.removeTarget(1)
  client.write('q')
  await until(() => f.tags.includes(13))
  assert.deepEqual(exits, [])
  f.control('shell.snapshot.v1', { boot_id: 'boot', revision: 3, focused_workspace_id: 'space', focused_tab_id: 'target', focused_pane_id: null,
    tabs: [{ tab_id: 'target', workspace_id: 'space', focused: true }], panes: [] })
  await delay(15)
  assert.deepEqual(exits, [], 'empty pane geometry is not proof that the tab was removed')
})

test('a missing target in the initial snapshot rejects creation with the native tab error', async t => {
  const f = await fixture(t, { missingTarget: true })
  await assert.rejects(f.connect(), { message: 'Herdr tab no longer exists' })
  assert.equal(f.requests.length, 0, 'a missing initial tab must not be focused')
})

test('restarts, shutdown, EOF, local detach and protocol errors do not claim native tab removal', async t => {
  for (const mode of ['restart', 'shutdown', 'eof', 'kill', 'error'] as const) await t.test(mode, async t => {
    const f = await fixture(t), client = await f.connect(), exits: HerdrClientExit[] = []
    client.onExit(exit => exits.push(exit))
    if (mode === 'restart') f.removeTarget(2, 'new-boot')
    else if (mode === 'shutdown') f.send(new Writer().uint(3).byte(0))
    else if (mode === 'eof') f.peer().end()
    else if (mode === 'kill') client.kill()
    else f.peer().end(Buffer.from([20, 0, 0, 0, 20]))
    await until(() => exits.length === 1)
    assert.equal(exits[0]!.reason, undefined)
    assert.equal(exits[0]!.exitCode, mode === 'restart' || mode === 'error' ? 1 : 0)
  })
})

test('clipboard messages reach the hosting terminal only and late focus responses cannot resurrect a killed client', async t => {
  const f = await fixture(t, { holdFocus: true }), pending = f.connect()
  await until(() => f.requests.length === 1); f.response(); const client = await pending
  let output = ''; client.onData(data => output += data)
  f.send(new Writer().uint(5).string(Buffer.from('copy 中文').toString('base64')))
  await until(() => output.includes('\x1b]52;c;'))
  client.write('pending'); await until(() => f.requests.length === 2)
  client.kill(); const before = output; f.response(); await delay(20)
  assert.equal(output, before)
})

test('a delayed independent selection read never holds the endpoint keyboard lane', async t => {
  let started = false, complete!: (value: unknown) => void
  const f = await fixture(t, { readSelection: () => { started = true; return new Promise(resolve => complete = resolve) } })
  const client = await f.connect(); t.after(() => client.kill())
  let output = ''; client.onData(data => output += data)
  client.write('\x1b[<0;1;1M\x1b[<32;4;1M\x1b[<0;4;1m')
  await until(() => started)
  assert(!f.requests.some(request => request.method === 'pane.selection.read'))
  client.write('q')
  await until(() => f.tags.includes(13))
  complete({ pane_id: 'pane', text: 'READ' })
  await delay(10)
  // Typing retires the old selection; a delayed read cannot clobber clipboard.
  assert(!output.includes('\x1b]52;c;'))
})

test('native metadata changes arrive independently of frames, deduplicate and replay to late listeners', async t => {
  const f = await fixture(t), client = await f.connect()
  t.after(() => client.kill())
  const updates: WindowMetadata[] = []
  const subscription = client.onMetadata(metadata => updates.push(metadata))
  await until(() => updates.length === 1)
  const snapshot = (revision: number, status: string, title = 'Task') => f.control('shell.snapshot.v1', {
    boot_id: 'boot', revision, focused_workspace_id: 'space', focused_tab_id: 'target', focused_pane_id: 'pane',
    tabs: [{ tab_id: 'target', workspace_id: 'space', focused: true, label: 'Tab' }],
    panes: [{ pane_id: 'pane', tab_id: 'target', workspace_id: 'space', focused: true, right_click_passthrough: false }],
    agents: [{ pane_id: 'pane', agent_status: status, agent: 'codex', terminal_title_stripped: title }],
  })
  snapshot(2, 'done')
  await until(() => updates.at(-1)?.status === 'done')
  const count = updates.length
  snapshot(3, 'done'); snapshot(1, 'working')
  await delay(20)
  assert.equal(updates.length, count, 'duplicate and stale snapshots changed metadata')
  snapshot(4, 'idle', 'Ready')
  await until(() => updates.at(-1)?.status === 'idle')
  assert.equal(updates.at(-1)?.panes[0]?.terminalTitle, 'Ready')
  const late: WindowMetadata[] = []
  client.onMetadata(metadata => late.push(metadata))
  await until(() => late.length === 1)
  assert.deepEqual(late[0], updates.at(-1))
  subscription.dispose(); snapshot(5, 'blocked')
  await until(() => late.at(-1)?.status === 'attention')
  assert.equal(updates.at(-1)?.status, 'idle')
})
