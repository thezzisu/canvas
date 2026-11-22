import test, { afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { RETIRE_MS, TerminalChannels, type ConnectionEvents } from './terminal-channels.ts'
import { STALL_MS } from './link-watch.ts'
import { TerminalView } from './terminal-view.ts'

// The fixture's clock stands still, so no test here may run on real timers.
beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())

class FakeSocket {
  readonly OPEN = 1
  readyState = 0
  binaryType = ''
  sent: Record<string, unknown>[] = []
  onopen?: () => void
  onmessage?: (event: { data: unknown }) => void
  onerror?: () => void
  onclose?: () => void
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
  }
  accept() {
    this.readyState = 1
    this.onopen!()
  }
  json(message: object) {
    this.onmessage!({ data: JSON.stringify(message) })
  }
  cells(...bytes: number[]) {
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
  }
  return { log, events }
}
function fixture() {
  const socket = new FakeSocket()
  let idle = 0
  const page = { time: 0, shown: true }
  const channels = new TerminalChannels(socket as unknown as WebSocket, 'token', () => idle++, {
    now: () => page.time,
    visible: () => page.shown,
  })
  return { socket, channels, page, idle: () => idle }
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
  f.socket.cells(0xc7, 0x01, 0, 9, 9)
  f.socket.cells(0x80)
  f.socket.cells()
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
  f.socket.json({ type: 'status', channel: 2, ack: 2 })
  assert.equal(same.taken, 2)
  f.socket.json({ type: 'ack', channel: 2, ack: 3 })
  assert.equal(same.taken, 3)
  f.socket.json({ type: 'ack', channel: 2, ack: 1 })
  f.socket.json({ type: 'ack', channel: 2, ack: 9 })
  assert.equal(same.taken, 3, 'an ack is cumulative and never of what was not sent')
  assert.deepEqual(a.log, [[7], 'status'], "an ack is not the session's to hear")
})

/** A window's channel that the server has joined, and a clock that moves the timers with it. */
function linked(watching = false) {
  const f = fixture(),
    a = listener(),
    same = view()
  const connection = f.channels.open(window('a'), same, { ...a.events, watching: () => watching })
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

test('input nobody acknowledged for two seconds gives the socket up, and only then', () => {
  const f = linked()
  f.connection.send({ type: 'input', data: 'x' })
  // The way down still works, which says nothing of the way up.
  f.pass(1000)
  f.socket.cells(0, 0, 9)
  f.pass(STALL_MS - 1010)
  assert.deepEqual(f.a.log, [[9]])
  f.pass(20)
  assert.deepEqual(f.a.log, [[9], 'stalled'])
  assert.equal(f.idle(), 1, 'the next connection gets a socket of its own')
  assert.equal(f.connection.send({ type: 'input', data: 'y' }), false, 'nothing more goes into it')
  f.socket.cells(0, 1, 8)
  assert.equal(f.a.log.length, 2, 'what arrives on it late is dropped')
  assert.equal(f.socket.readyState, 1, 'closing it now would release the maximized window')
  f.pass(RETIRE_MS)
  assert.equal(f.socket.readyState, 3)
})

test('an ack in time is no stall, and progress restarts the wait', () => {
  const f = linked()
  for (const data of ['1', '2', '3']) f.connection.send({ type: 'input', data })
  f.pass(1900)
  f.socket.cells(0, 1, 7)
  f.pass(1900)
  f.socket.json({ type: 'ack', channel: 0, ack: 2 })
  f.pass(1900)
  f.socket.json({ type: 'status', channel: 0, ack: 3 })
  f.pass(10_000)
  assert.deepEqual(f.a.log, [[7], 'status'])
})

test('a page that was busy reads what arrived before it calls a stall', () => {
  const f = linked()
  f.connection.send({ type: 'input', data: 'x' })
  f.page.time += 6000
  mock.timers.tick(STALL_MS)
  assert.deepEqual(f.a.log, [])
  f.socket.json({ type: 'ack', channel: 0, ack: 1 })
  f.pass(5000)
  assert.deepEqual(f.a.log, [])
})

test('a hidden page judges nothing until it shows', () => {
  const f = linked()
  f.connection.send({ type: 'view-visible', visible: false })
  f.page.shown = false
  f.pass(30_000)
  assert.deepEqual(f.a.log, [])
  f.page.shown = true
  f.channels.shown()
  f.pass(300)
  assert.deepEqual(f.a.log, ['stalled'])
})

test('silence is questioned only under a working agent', () => {
  const f = linked()
  f.pass(30_000)
  assert.deepEqual(f.socket.sent, [])
  assert.deepEqual(f.a.log, [])
})

test('a silent socket under a working agent is probed, and a probe without an answer is a stall', () => {
  const f = linked(true)
  f.pass(2010)
  assert.deepEqual(f.socket.sent, [{ type: 'ping', id: 'link', channel: 0, seq: 1 }])
  f.socket.json({ type: 'pong', id: 'link', channel: 0, ack: 1 })
  f.pass(2010)
  assert.equal(f.socket.sent.length, 2)
  f.pass(2010)
  assert.deepEqual(f.a.log, ['pong', 'stalled'])
})

test('a new channel first sends again the input that was not taken, and nothing else', () => {
  const f = linked()
  f.connection.send({ type: 'input', data: 'a' })
  f.connection.send({ type: 'focus' })
  f.connection.send({ type: 'input', data: 'b' })
  f.connection.send({ type: 'input', data: 'c' })
  f.pass(STALL_MS + 10)
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

test('input is not sent again to a window that forgot the view, or after the user left', () => {
  for (const forget of [false, true]) {
    const f = fixture(),
      same = view()
    same.number({ type: 'input', data: 'synthetic' }, 0)
    if (forget) same.forgetInput()
    f.channels.open(window('a'), same, listener().events)
    f.socket.accept()
    f.socket.sent = []
    f.socket.json({ type: 'resume', channel: 0, taken: forget ? 0 : null, ack: 0 })
    assert.deepEqual(f.socket.sent, [])
    assert.equal(same.waitingSince, undefined)
  }
})

test('nothing new is numbered on a channel before the input to send again', () => {
  const f = fixture(),
    same = view()
  same.number({ type: 'input', data: 'typed' }, 0)
  const connection = f.channels.open(window('a'), same, listener().events)
  f.socket.accept()
  f.socket.sent = []
  assert.equal(connection.send({ type: 'upload-cancel', id: 'batch' }), false)
  f.socket.json({ type: 'resume', channel: 0, taken: 0, ack: 0 })
  assert.deepEqual(f.socket.sent, [{ type: 'input', data: 'typed', channel: 0, seq: 1 }])
  assert.equal(connection.send({ type: 'focus' }), true)
})
