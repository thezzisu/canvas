import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreRpc, CoreRpcError, CORE_MAX_PAYLOAD } from './rpc.ts'

const hello = { generation: 1, version: '0.1.17', core: { id: 'core-fixture-1', name: 'fixture' }, framed: true,
  methods: ['terminal.list', 'terminal.attach', 'events.subscribe', 'doc.get'], features: ['framed', 'attach', 'events', 'resize_notifications'] }
const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
function encoded(channel: number, kind: number, payload: Buffer | string | Record<string, unknown>): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))
  const head = Buffer.alloc(9); head.writeUInt32LE(channel); head[4] = kind; head.writeUInt32LE(data.length, 5)
  return Buffer.concat([head, data])
}
type Request = { jsonrpc: string; id: number; method: string; params: Record<string, unknown> }
type Wire = { channel: number; kind: number; data: Buffer }
async function fixture(t: TestContext, request: (request: Request, socket: Socket) => void, options: { hello?: unknown; fragmented?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cv-core-rpc-')), socketPath = join(root, 'core.sock')
  const sockets = new Set<Socket>(), received: Wire[] = []
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    let bytes: Buffer = Buffer.alloc(0), framed = false
    socket.on('data', data => {
      bytes = Buffer.concat([bytes, Buffer.isBuffer(data) ? data : Buffer.from(data)])
      if (!framed) {
        const end = bytes.indexOf(10); if (end < 0) return
        const value: Request = JSON.parse(bytes.subarray(0, end).toString()); bytes = bytes.subarray(end + 1)
        assert.equal(value.method, 'hello'); assert.equal(value.params.generation, 1); assert.equal(value.params.framed, true)
        const response = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: options.hello ?? hello }) + '\n')
        if (options.fragmented) { socket.write(response.subarray(0, 7)); setTimeout(() => { if (!socket.destroyed) socket.write(response.subarray(7)) }, 1) }
        else socket.write(response)
        framed = true
      }
      while (bytes.length >= 9) {
        const channel = bytes.readUInt32LE(0), kind = bytes[4]!, length = bytes.readUInt32LE(5)
        if (bytes.length < 9 + length) return
        const data = Buffer.from(bytes.subarray(9, 9 + length)); bytes = bytes.subarray(9 + length)
        received.push({ channel, kind, data })
        if (channel === 0 && kind === 0) request(JSON.parse(data.toString()), socket)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  return { socketPath, received, sockets }
}
function reply(socket: Socket, request: Request, result: unknown) { socket.write(encoded(0, 0, { jsonrpc: '2.0', id: request.id, result })) }

test('core multiplex installs attach routing before same-chunk frames and credits only after parsing', async t => {
  const f = await fixture(t, (request, socket) => {
    if (request.method === 'terminal.attach') {
      const size = Buffer.alloc(4); size.writeUInt16LE(81); size.writeUInt16LE(23, 2)
      socket.write(Buffer.concat([
        encoded(0, 0, { jsonrpc: '2.0', id: request.id, result: { channel: 1, terminal: { address: 't7' }, resize_notifications: true } }),
        encoded(1, 3, size), encoded(1, 0, '\x18\x1b[2J中文 frame'),
      ]))
    } else reply(socket, request, { marker: request.params.marker })
  }, { fragmented: true })
  const rpc = await CoreRpc.connect(f.socketPath); t.after(() => rpc.close())
  assert.equal(rpc.hello.core.id, 'core-fixture-1')
  const attached = await rpc.attach({ terminal: 't7', cols: 1, rows: 1, observe: true, resize_notifications: true })
  assert.equal(attached.resize_notifications, true)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), seen: string[] = []
  attached.stream.onResize(async size => { seen.push(`resize:${size.cols}:${size.rows}`) })
  attached.stream.onData(async data => { seen.push(data.toString()); await gate })
  await delay()
  assert.deepEqual(seen, ['resize:81:23', '\x18\x1b[2J中文 frame'])
  assert.equal(f.received.some(frame => frame.kind === 1), false, 'receipt alone must not release credit')
  assert.deepEqual(await rpc.call('doc.get', { marker: 'responsive' }), { marker: 'responsive' }, 'a slow stream does not block RPC')
  release(); await delay()
  assert.equal(f.received.find(frame => frame.channel === 1 && frame.kind === 1)?.data.readUInt32LE(), Buffer.byteLength('\x18\x1b[2J中文 frame'))
  attached.stream.write(Buffer.from([0, 128, 255])); attached.stream.resize(100, 30); attached.stream.focus(true); attached.stream.facts({ fg: '#ffffff', cell: [8, 16] })
  await delay()
  assert.deepEqual(f.received.find(frame => frame.channel === 1 && frame.kind === 0)?.data, Buffer.from([0, 128, 255]))
  assert.equal(f.received.find(frame => frame.channel === 1 && frame.kind === 3)?.data.readUInt16LE(2), 30)
  assert.deepEqual([...f.received.find(frame => frame.channel === 1 && frame.kind === 4)!.data], [1])
  assert.equal(JSON.parse(f.received.find(frame => frame.channel === 1 && frame.kind === 5)!.data.toString()).fg, '#ffffff')
  attached.stream.close(); await delay()
  assert(f.received.some(frame => frame.channel === 1 && frame.kind === 2), 'detach is CLOSE, never terminal.kill')
})

test('core events wait for initial snapshot application and parse fragmented Unicode notifications', async t => {
  const notification = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { seq: 4, type: 'title', terminal: 't7', data: { title: '中文' } } }) + '\n'
  const f = await fixture(t, (request, socket) => {
    const data = Buffer.from(notification), split = data.indexOf(Buffer.from('中文')) + 1
    socket.write(Buffer.concat([
      encoded(0, 0, { jsonrpc: '2.0', id: request.id, result: { seq: 3, terminals: [{ address: 't7' }], channel: 2 } }),
      encoded(2, 0, data.subarray(0, split)), encoded(2, 0, data.subarray(split)),
      encoded(2, 0, JSON.stringify({ jsonrpc: '2.0', method: 'heartbeat', params: { seq: 4 } }) + '\n'),
    ]))
  })
  const rpc = await CoreRpc.connect(f.socketPath); t.after(() => rpc.close())
  const events: string[] = []
  const subscription = await rpc.subscribe({}, value => { events.push(`${value.method}:${value.params.seq}:${JSON.stringify(value.params.data)}`) })
  assert.equal(subscription.snapshot.seq, 3); assert.equal(subscription.snapshot.terminals[0]!.address, 't7')
  await delay(); assert.deepEqual(events, []); assert(!f.received.some(frame => frame.channel === 2 && frame.kind === 1))
  subscription.start(); subscription.start(); await delay()
  assert.deepEqual(events, ['event:4:{"title":"中文"}', 'heartbeat:4:undefined'])
  assert.equal(f.received.filter(frame => frame.channel === 2 && frame.kind === 1).reduce((n, frame) => n + frame.data.readUInt32LE(), 0), Buffer.byteLength(notification) + Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method: 'heartbeat', params: { seq: 4 } }) + '\n'))
})

test('core RPC retains error kinds, times out unanswered calls and cancels orphan attach requests', async t => {
  const f = await fixture(t, (request, socket) => {
    if (request.params.mode === 'error') socket.write(encoded(0, 0, { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'stale document', data: { kind: 'conflict', hint: 'read again' } } }))
  })
  const rpc = await CoreRpc.connect(f.socketPath); t.after(() => rpc.close())
  await assert.rejects(rpc.call('doc.get', { mode: 'error' }), error => error instanceof CoreRpcError && error.kind === 'conflict' && error.hint === 'read again')
  await assert.rejects(rpc.call('missing.method'), /unavailable/u)
  await assert.rejects(rpc.call('doc.get', {}, { timeoutMs: 10 }), /timed out/u)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(rpc.call('doc.get', {}, { signal: cancelled.signal }), { name: 'AbortError' })
  const abort = new AbortController(), pending = rpc.attach({ terminal: 't7' }, { signal: abort.signal })
  abort.abort(); await assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(rpc.call('doc.get'), /cancelled/u)
  await delay(); assert.equal(f.sockets.size, 0, 'aborted attach closes transport instead of leaking a late viewer')
})

test('core rejects incompatible handshakes and malformed stream frames', async t => {
  for (const invalid of [{ ...hello, generation: 2 }, { ...hello, features: [] }, { ...hello, core: { id: '', name: 'fixture' } }]) {
    const f = await fixture(t, () => {}, { hello: invalid })
    await assert.rejects(CoreRpc.connect(f.socketPath), /Incompatible/u)
  }
  const f = await fixture(t, (request, socket) => {
    reply(socket, request, { channel: 1, terminal: { address: 't1' } })
    const header = Buffer.alloc(9); header.writeUInt32LE(1); header.writeUInt32LE(CORE_MAX_PAYLOAD + 1, 5); socket.write(header)
  })
  const rpc = await CoreRpc.connect(f.socketPath); t.after(() => rpc.close())
  const closed = new Promise<Error>(resolve => rpc.onClose(resolve))
  await rpc.attach({ terminal: 't1' })
  assert.match((await closed).message, /too large/u)
})

test('core channels preserve output before exit and reject truncated final frames', async t => {
  const f = await fixture(t, (request, socket) => {
    socket.end(Buffer.concat([
      encoded(0, 0, { jsonrpc: '2.0', id: request.id, result: { channel: 1, terminal: { address: 't1' } } }),
      encoded(1, 0, 'last frame'), encoded(1, 2, { reason: 'exited', exit_code: 0 }),
    ]))
  })
  const rpc = await CoreRpc.connect(f.socketPath); t.after(() => rpc.close())
  const { stream } = await rpc.attach({ terminal: 't1' }), observed: string[] = []
  stream.onData(async data => { await delay(); observed.push(data.toString()) })
  const closed = new Promise<void>(resolve => stream.onClose(reason => { observed.push(String(reason?.reason)); resolve() }))
  await closed; assert.deepEqual(observed, ['last frame', 'exited'])
  const f2 = await fixture(t, (request, socket) => { reply(socket, request, { channel: 1, terminal: { address: 't1' } }); socket.end(encoded(1, 0, 'truncated').subarray(0, 10)) })
  const rpc2 = await CoreRpc.connect(f2.socketPath); t.after(() => rpc2.close())
  const ended = new Promise<Error>(resolve => rpc2.onClose(resolve)); await rpc2.attach({ terminal: 't1' })
  assert.match((await ended).message, /truncated/u)
})
