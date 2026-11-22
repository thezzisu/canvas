import test, { afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { RETIRE_MS, TerminalChannels, type ConnectionEvents } from './terminal-channels.ts'
import { TerminalView } from './terminal-view.ts'
import { setLogSink } from '../diagnostics/log.ts'

// The fixture's clock stands still, so no test here may run on real timers.
beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())

const leb128 = (values: number[]) =>
  values.flatMap((value) => {
    const bytes: number[] = []
    for (; value > 0x7f; value = Math.floor(value / 0x80)) bytes.push((value % 0x80) | 0x80)
    return [...bytes, value]
  })
/**
 * The browser's socket, and a server behind it that receives at once what is sent, unless the
 * way up is stuck, and stamps what it sends as the real one does.
 */
class FakeSocket {
  readonly OPEN = 1
  readyState = 0
  binaryType = ''
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  /** What the server has received, and whether the way up carries anything. */
  got = 0
  up = true
  /** Sent bytes wait in the browser's buffer until drained by hand. */
  holding = false
  /** Sent bytes leave the browser's buffer a moment after `send`, as a real socket's do. */
  lagging = false
  onopen?: () => void
  onmessage?: (event: { data: unknown }) => void
  onerror?: () => void
  onclose?: () => void
  send(data: string) {
    this.sent.push(JSON.parse(data))
    const length = new TextEncoder().encode(data).length
    if (this.holding || this.lagging) this.bufferedAmount += length
    if (this.lagging) setTimeout(() => (this.bufferedAmount -= length), 0)
    this.total++
    if (this.up) this.got = this.total
  }
  /** The way up carries again what it held. */
  thaw() {
    this.up = true
    this.got = this.total
  }
  private total = 0
  stamp() {
    return { got: this.got, since: 0, quiet: 0 }
  }
  close() {
    this.readyState = 3
  }
  accept() {
    this.readyState = 1
    this.onopen!()
  }
  json(message: object) {
    this.onmessage!({ data: JSON.stringify({ ...this.stamp(), ...message }) })
  }
  /** A cell message on `channel`, with the view's ack, the stamp and the cells. */
  cells(channel: number, ack: number, ...cells: number[]) {
    const { got, since, quiet } = this.stamp()
    this.raw(...leb128([channel, ack, got, since, quiet]), ...cells)
  }
  raw(...bytes: number[]) {
    this.onmessage!({ data: Uint8Array.from(bytes).buffer })
  }
}
const window = (windowId: string) => ({ sourceId: 'source', spaceId: 'space', windowId })
// A session's window is a canvas node, which has a `type` of its own.
const node = (windowId: string) => ({ ...window(windowId), type: 'terminal', x: 0 })
const view = (id = 'view-0001') => new TerminalView(id)
function listener() {
  const log: unknown[] = []
  const events: ConnectionEvents = {
    message: (message) => log.push(message.type),
    cells: (bytes) => log.push([...bytes]),
    closed: (end) => log.push(end),
    doubted: (on) => log.push(on ? 'doubt' : 'clear'),
  }
  return { log, events }
}
function fixture() {
  const socket = new FakeSocket()
  let idle = 0,
    network: (() => void) | undefined
  const page = { time: 0, shown: true }
  const channels = new TerminalChannels(socket as unknown as WebSocket, 'token', () => idle++, {
    now: () => page.time,
    visible: () => page.shown,
    onNetwork(changed) {
      network = changed
      return () => (network = undefined)
    },
  })
  return { socket, channels, page, idle: () => idle, network: () => network?.() }
}

test('the socket authenticates once, then opens the channels asked for before and after', () => {
  const f = fixture(),
    a = f.channels.open(node('a'), view('view-000a'), listener().events)
  assert.equal(a.open, false)
  assert.equal(a.send({ type: 'focus' }), false, 'nothing is sent before the socket opens')
  f.socket.accept()
  const b = f.channels.open(node('b'), view('view-000b'), listener().events)
  assert.deepEqual(f.socket.sent, [
    { type: 'auth', token: 'token' },
    { type: 'open', channel: 0, view: 'view-000a', attempt: 1, maximized: false, ...window('a') },
    { type: 'open', channel: 1, view: 'view-000b', attempt: 1, maximized: false, ...window('b') },
  ])
  f.socket.json({ type: 'resume', channel: 0, taken: null })
  assert.equal(a.send({ type: 'focus' }) && b.open, true)
  assert.deepEqual(f.socket.sent.at(-1), { type: 'focus', channel: 0, seq: 1 })
  assert.equal(f.socket.binaryType, 'arraybuffer')
})

test('messages and cells reach only their channel', () => {
  const f = fixture(),
    a = listener(),
    b = listener()
  f.channels.open(window('a'), view(), a.events)
  f.socket.accept()
  for (let i = 1; i < 200; i++)
    f.channels.open(window(`w${i}`), view(), i === 199 ? b.events : a.events)
  f.socket.json({ type: 'status', channel: 199 })
  f.socket.json({ type: 'metadata', channel: 0 })
  f.socket.json({ type: 'status', channel: 7000 })
  f.socket.json({ type: 'status' })
  f.socket.onmessage!({ data: '{' })
  f.socket.cells(0, 0, 1, 2)
  f.socket.cells(199, 0, 9, 9)
  f.socket.raw(0x80)
  f.socket.raw()
  assert.deepEqual(a.log, ['metadata', [1, 2]])
  assert.deepEqual(b.log, ['status', [9, 9]])
})

test('a channel ends alone and a new one opens beside the others; the last one closes the socket', () => {
  const f = fixture(),
    a = listener(),
    b = listener(),
    again = listener()
  const same = view()
  const first = f.channels.open(window('a'), same, a.events)
  f.channels.open(window('b'), view(), b.events)
  f.socket.accept()
  // What a session does with a cell message it cannot apply: close, then open again.
  first.close()
  first.close()
  const second = f.channels.open(window('a'), same, again.events)
  assert.deepEqual(f.socket.sent.slice(3), [
    { type: 'close', channel: 0 },
    { type: 'open', channel: 2, view: 'view-0001', attempt: 2, maximized: false, ...window('a') },
  ])
  f.socket.json({ type: 'status', channel: 0 })
  f.socket.cells(0, 0, 1)
  f.socket.cells(2, 0, 5)
  assert.deepEqual([a.log, again.log, b.log], [[], [[5]], []], 'the closed channel hears nothing')
  f.socket.json({ type: 'close', channel: 1 })
  f.socket.json({ type: 'close', channel: 1 })
  assert.deepEqual(b.log, ['closed'], 'the server ended this one')
  assert.deepEqual([f.idle(), f.socket.readyState], [0, 1])
  second.close()
  assert.deepEqual([f.idle(), f.socket.readyState], [1, 3])
  f.socket.onclose!()
  assert.deepEqual(again.log, [[5]])
})

test('losing the socket ends every channel once, and a channel may close itself on hearing it', () => {
  for (const failed of [false, true]) {
    const f = fixture(),
      logs: unknown[][] = []
    for (const id of ['a', 'b', 'c']) {
      const { log, events } = listener()
      const connection = f.channels.open(window(id), view(), {
        ...events,
        closed(value) {
          events.closed(value)
          connection.close()
        },
      })
      logs.push(log)
    }
    f.socket.accept()
    if (failed) f.socket.onerror!()
    f.socket.onclose!()
    assert.deepEqual(logs, Array(3).fill([failed ? 'failed' : 'closed']))
    assert.equal(f.idle(), 1)
  }
})

test("a view's numbers go on over its channels, and every kind of message acknowledges them", () => {
  const f = fixture(),
    a = listener(),
    same = view()
  f.channels.open(window('keep'), view(), listener().events)
  f.socket.accept()
  const first = f.channels.open(window('a'), same, a.events)
  f.socket.json({ type: 'resume', channel: 1, taken: null })
  first.send({ type: 'focus' })
  first.send({ type: 'input', data: 'x' })
  first.close()
  const second = f.channels.open(window('a'), same, a.events)
  f.socket.json({ type: 'resume', channel: 2, taken: null })
  second.send({ type: 'input', data: 'y' })
  assert.equal(f.socket.sent.at(-1)!.seq, 3)
  f.socket.cells(2, 1, 7)
  assert.equal(same.taken, 1)
  f.socket.json({ type: 'status', channel: 2, ack: 3 })
  assert.equal(same.taken, 3)
  f.socket.json({ type: 'status', channel: 2, ack: 1 })
  f.socket.json({ type: 'status', channel: 2, ack: 9 })
  assert.equal(same.taken, 3, 'an ack is cumulative and never of what was not sent')
  // What the socket received rides alone when nothing else went.
  f.socket.json({ type: 'ack' })
  assert.deepEqual(
    a.log,
    [[7], 'status', 'status', 'status'],
    "an ack is not the session's to hear",
  )
})

/** A window's channel that the server has joined, and a clock that moves the timers with it. */
function linked(options: { watching?: boolean; busy?: boolean } = {}) {
  const f = fixture(),
    a = listener(),
    same = view()
  const connection = f.channels.open(window('a'), same, {
    ...a.events,
    watching: () => !!options.watching,
    busy: () => !!options.busy,
  })
  f.socket.accept()
  f.socket.json({ type: 'resume', channel: 0, taken: null, ack: 0 })
  f.socket.sent = []
  const pass = (ms: number) => {
    for (let passed = 0; passed < ms; passed += 10) {
      f.page.time += 10
      mock.timers.tick(10)
    }
  }
  return { ...f, a, view: same, connection, pass }
}
/** Before any round trip is measured: a second, and the server's ack delay. */
const TIMEOUT = 1100

test('a way up that holds what was sent is probed, then in doubt, then given up, each timeout twice the last', () => {
  const f = linked()
  f.socket.up = false
  f.connection.send({ type: 'input', data: 'x' })
  f.pass(TIMEOUT - 10)
  assert.deepEqual(f.socket.sent.length, 1)
  f.pass(20)
  assert.deepEqual(f.socket.sent.at(-1), { type: 'ping' }, 'first, a probe')
  f.pass(2 * TIMEOUT)
  assert.deepEqual(f.a.log, ['doubt'], 'the probe went unanswered too')
  f.pass(4 * TIMEOUT - 30)
  assert.deepEqual(f.a.log, ['doubt'])
  f.pass(40)
  assert.deepEqual(f.a.log, ['doubt', 'stalled'])
  assert.equal(f.idle(), 1, 'the next connection gets a socket of its own')
  assert.equal(f.connection.send({ type: 'input', data: 'y' }), false, 'nothing more goes into it')
  f.socket.cells(0, 1, 8)
  assert.equal(f.a.log.length, 2, 'what arrives on it late is dropped')
  assert.equal(f.socket.readyState, 1, 'closing it now would release the maximized window')
  f.pass(RETIRE_MS)
  assert.equal(f.socket.readyState, 3)
})

test("bytes leaving the buffer after they were sent, the probe's among them, are no answer", () => {
  const f = linked()
  f.socket.lagging = true
  f.socket.up = false
  f.connection.send({ type: 'input', data: 'x' })
  f.pass(7 * TIMEOUT + 100)
  assert.deepEqual(f.a.log, ['doubt', 'stalled'])
})

test('an answer clears the doubt and starts the count again', () => {
  const f = linked()
  f.socket.up = false
  f.connection.send({ type: 'input', data: 'x' })
  f.pass(3 * TIMEOUT + 20)
  assert.deepEqual(f.a.log, ['doubt'])
  f.socket.thaw()
  f.socket.json({ type: 'status', channel: 0, ack: 1 })
  assert.deepEqual(f.a.log, ['doubt', 'clear', 'status'])
  f.pass(30_000)
  assert.deepEqual(f.a.log, ['doubt', 'clear', 'status'], 'nothing is owed, so nothing is judged')
})

test('bytes the server sent before the input could reach it are waited through', () => {
  const f = linked()
  f.pass(500)
  f.socket.up = false
  f.connection.send({ type: 'input', data: 'x' })
  // A burst the server sent long before: it had last heard from the browser well before this.
  for (let i = 0; i < 6; i++) {
    f.pass(900)
    f.socket.json({ type: 'status', channel: 0, ack: 0, got: f.socket.got, since: 0, quiet: 0 })
  }
  assert.deepEqual(
    f.a.log.filter((entry) => entry !== 'status'),
    [],
    'no doubt, no stall',
  )
})

test('bytes the server sent well after the input should have reached it, without it, put the link in doubt at once', () => {
  const f = linked()
  f.socket.up = false
  f.connection.send({ type: 'input', data: 'x' })
  f.pass(200)
  // The server last received a message 2 s ago; the input left 200 ms ago.
  f.socket.json({ type: 'status', channel: 0, ack: 0, got: f.socket.got, since: 2000, quiet: 2000 })
  assert.deepEqual(f.a.log, ['doubt', 'status'])
})

test('each answer is a round trip, and a slow link waits longer before it probes', () => {
  const f = linked()
  // Twenty answers a second after each input: the estimate is near a second, still uneven.
  for (let i = 0; i < 20; i++) {
    f.socket.up = false
    f.connection.send({ type: 'input', data: String(i) })
    f.pass(1000)
    f.socket.thaw()
    f.socket.json({ type: 'status', channel: 0, ack: i + 1 })
  }
  f.socket.up = false
  f.connection.send({ type: 'input', data: 'x' })
  f.pass(TIMEOUT + 300)
  assert.equal(
    f.socket.sent.at(-1)!.type,
    'input',
    'what is late for a fast link is not for this one',
  )
  f.pass(200)
  assert.deepEqual(f.socket.sent.at(-1), { type: 'ping' })
})

test('nothing is judged during an upload, nor while a long message still leaves the buffer', () => {
  const f = linked({ busy: true })
  f.socket.up = false
  f.connection.send({ type: 'input', data: 'x' })
  f.pass(20 * TIMEOUT)
  assert.deepEqual(f.a.log, [])
  const g = linked()
  g.socket.up = false
  g.socket.holding = true
  g.connection.send({ type: 'input', data: '中'.repeat(400_000) })
  assert.equal(g.socket.bufferedAmount > 1_200_000, true)
  for (let i = 0; i < 20; i++) {
    g.socket.bufferedAmount -= 40_000
    g.pass(TIMEOUT)
  }
  assert.deepEqual(g.a.log, [], 'a paste still draining is no stall')
  g.pass(8 * TIMEOUT)
  assert.deepEqual(g.a.log, ['doubt', 'stalled'], 'one that stopped is')
})

test('a hidden page judges nothing; shown again, it asks afresh', () => {
  const f = linked()
  f.socket.up = false
  f.connection.send({ type: 'view-visible', visible: false })
  f.page.shown = false
  f.pass(30_000)
  assert.deepEqual(f.a.log, [])
  f.page.shown = true
  f.channels.shown()
  assert.deepEqual(f.socket.sent.at(-1), { type: 'ping' })
  f.pass(TIMEOUT - 20)
  assert.deepEqual(f.a.log, [], 'the wait starts on return')
})

test('another network gives the socket up at once', () => {
  const f = linked()
  f.network()
  assert.deepEqual(f.a.log, ['stalled'])
})

test('silence is questioned only under a working agent', () => {
  const quiet = linked()
  quiet.pass(30_000)
  assert.deepEqual(quiet.socket.sent, [])
  const f = linked({ watching: true })
  f.pass(TIMEOUT + 20)
  assert.deepEqual(f.socket.sent, [{ type: 'ping' }])
  f.socket.json({ type: 'ack' })
  f.pass(TIMEOUT + 20)
  assert.equal(f.socket.sent.length, 2, 'asked again after another silence')
  assert.deepEqual(f.a.log, [])
})

test('a new channel first sends again the input that was not taken, and nothing else', () => {
  const f = linked()
  f.connection.send({ type: 'input', data: 'a' })
  f.connection.send({ type: 'focus' })
  f.connection.send({ type: 'input', data: 'b' })
  f.connection.send({ type: 'input', data: 'c' })
  const next = fixture(),
    b = listener()
  next.channels.open(window('a'), f.view, b.events)
  next.socket.accept()
  next.socket.sent = []
  next.socket.json({ type: 'resume', channel: 0, taken: 1, ack: 1 })
  assert.deepEqual(next.socket.sent, [
    { type: 'input', data: 'b', channel: 0, seq: 3 },
    { type: 'input', data: 'c', channel: 0, seq: 4 },
  ])
  assert.deepEqual(b.log, [], "the handshake is not the session's to hear")
})

test('pointer input is not sent again: it names cells of a screen that may have changed', () => {
  const f = linked()
  f.connection.send({ type: 'input', data: '\x1b[<0;10;5M' })
  f.connection.send({ type: 'input', data: '\x1b[<64;10;5M' })
  f.connection.send({ type: 'input', data: '\x1b[200~pasted\x1b[201~' })
  f.connection.send({ type: 'input', data: '\x1b[I' })
  f.connection.send({ type: 'input', data: 'k' })
  const next = fixture()
  next.channels.open(window('a'), f.view, listener().events)
  next.socket.accept()
  next.socket.sent = []
  next.socket.json({ type: 'resume', channel: 0, taken: 0, ack: 0 })
  assert.deepEqual(next.socket.sent, [
    { type: 'input', data: '\x1b[200~pasted\x1b[201~', channel: 0, seq: 3 },
    { type: 'input', data: 'k', channel: 0, seq: 5 },
  ])
})

test('input is not sent again to a window that forgot the view, or after the user left', () => {
  for (const forget of [false, true]) {
    const f = fixture(),
      same = view()
    same.number({ type: 'input', data: 'synthetic' })
    if (forget) same.forgetInput()
    f.channels.open(window('a'), same, listener().events)
    f.socket.accept()
    f.socket.sent = []
    f.socket.json({ type: 'resume', channel: 0, taken: forget ? 0 : null, ack: 0 })
    assert.deepEqual(f.socket.sent, [])
  }
})

test('nothing new is numbered on a channel before the input to send again', () => {
  const f = fixture(),
    same = view()
  same.number({ type: 'input', data: 'typed' })
  const connection = f.channels.open(window('a'), same, listener().events)
  f.socket.accept()
  f.socket.sent = []
  assert.equal(connection.send({ type: 'upload-cancel', id: 'batch' }), false)
  f.socket.json({ type: 'resume', channel: 0, taken: 0, ack: 0 })
  assert.deepEqual(f.socket.sent, [{ type: 'input', data: 'typed', channel: 0, seq: 1 }])
  assert.equal(connection.send({ type: 'focus' }), true)
})

test('the log names every message and ack, with times, and never what was typed', (t) => {
  const lines: Record<string, unknown>[] = []
  setLogSink((event, fields) => lines.push({ event, ...fields }))
  t.after(() => setLogSink(undefined))
  const f = fixture(),
    a = listener()
  const connection = f.channels.open(window('a'), view(), a.events)
  f.socket.accept()
  assert.equal(f.socket.sent.at(-1)!.timed, true)
  f.socket.json({ type: 'hello', socket: 'ab12', version: '0.5.0' })
  f.socket.json({ type: 'resume', channel: 0, taken: null, ack: 0 })
  f.socket.up = false
  connection.send({ type: 'input', data: 'secret' })
  f.page.time += 80
  f.socket.thaw()
  f.socket.json({ type: 'status', channel: 0, ack: 1, sentAt: Date.now(), since: 10, quiet: 10 })
  const events = lines.map((line) => line.event)
  for (const event of ['socket', 'resumed', 'send', 'receive', 'ack'])
    assert(events.includes(event), event)
  const ack = lines.findLast((line) => line.event === 'ack')!
  assert.deepEqual([ack.socket, ack.got, ack.rtt], ['ab12', 3, 70])
  assert.equal(typeof ack.offset, 'number')
  // A timed channel's cells carry the server's clock after the stamp.
  f.socket.raw(0, 1, 4, 0, 0, 5, 42)
  assert.deepEqual(a.log.at(-1), [42], 'the times are not the cells')
  assert(!JSON.stringify(lines).includes('secret'))
})
