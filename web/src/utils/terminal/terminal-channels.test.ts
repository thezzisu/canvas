import test from 'node:test'
import assert from 'node:assert/strict'
import { TerminalChannels, type ConnectionEvents } from './terminal-channels.ts'

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
function listener() {
  const log: unknown[] = []
  const events: ConnectionEvents = {
    message: (message) => log.push(message.type),
    cells: (bytes) => log.push([...bytes]),
    closed: (failed) => log.push(failed ? 'failed' : 'closed'),
  }
  return { log, events }
}
function fixture() {
  const socket = new FakeSocket()
  let idle = 0
  const channels = new TerminalChannels(socket as unknown as WebSocket, 'token', () => idle++)
  return { socket, channels, idle: () => idle }
}

test('the socket authenticates once, then opens the channels asked for before and after', () => {
  const f = fixture(),
    a = f.channels.open(node('a'), listener().events)
  assert.equal(a.open, false)
  assert.equal(a.send({ type: 'focus' }), false, 'nothing is sent before the socket opens')
  f.socket.accept()
  const b = f.channels.open(node('b'), listener().events)
  assert.deepEqual(f.socket.sent, [
    { type: 'auth', token: 'token' },
    { type: 'open', channel: 0, ...window('a') },
    { type: 'open', channel: 1, ...window('b') },
  ])
  assert.equal(a.send({ type: 'focus' }) && b.open, true)
  assert.deepEqual(f.socket.sent.at(-1), { type: 'focus', channel: 0 })
  assert.equal(f.socket.binaryType, 'arraybuffer')
})

test('messages and cells reach only their channel', () => {
  const f = fixture(),
    a = listener(),
    b = listener()
  f.channels.open(window('a'), a.events)
  f.socket.accept()
  for (let i = 1; i < 200; i++) f.channels.open(window(`w${i}`), i === 199 ? b.events : a.events)
  f.socket.json({ type: 'status', channel: 199 })
  f.socket.json({ type: 'metadata', channel: 0 })
  f.socket.json({ type: 'status', channel: 7000 })
  f.socket.json({ type: 'status' })
  f.socket.onmessage!({ data: '{' })
  f.socket.cells(0, 1, 2)
  f.socket.cells(0xc7, 0x01, 9, 9)
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
  const first = f.channels.open(window('a'), a.events)
  f.channels.open(window('b'), b.events)
  f.socket.accept()
  // What a session does with a cell message it cannot apply: close, then open again.
  first.close()
  first.close()
  const second = f.channels.open(window('a'), again.events)
  assert.deepEqual(f.socket.sent.slice(3), [
    { type: 'close', channel: 0 },
    { type: 'open', channel: 2, ...window('a') },
  ])
  f.socket.json({ type: 'status', channel: 0 })
  f.socket.cells(0, 1)
  f.socket.cells(2, 5)
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
      const connection = f.channels.open(window(id), {
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
