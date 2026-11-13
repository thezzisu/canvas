import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { authenticateWebSocket } from './websocket-auth.ts'
import { serveTerminalChannels, type TerminalChannel } from './terminal-channels.ts'
import type { TerminalTarget } from './terminals.ts'

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: (Record<string, unknown> | number[])[] = []
  send(data: string | Uint8Array) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : [...data])
  }
  say(message: object) {
    this.emit('message', Buffer.from(JSON.stringify(message)), false)
  }
}
function fixture() {
  const socket = new FakeSocket(),
    opened: { channel: TerminalChannel; target: TerminalTarget; log: unknown[] }[] = []
  serveTerminalChannels(socket as unknown as WebSocket, (channel, target) => {
    const log: unknown[] = []
    channel.on('message', (message) => log.push(message.type))
    channel.once('close', () => log.push('close'))
    opened.push({ channel, target, log })
  })
  return { socket, opened }
}
const target = (windowId: string) => ({ sourceId: 'source', spaceId: 'space', windowId })

test('a channel carries one window: its messages in, and its JSON and cells out under its number', () => {
  const f = fixture()
  f.socket.say({ type: 'open', channel: 0, ...target('a') })
  f.socket.say({ type: 'open', channel: 300, ...target('b') })
  assert.deepEqual(
    f.opened.map(({ target }) => target.windowId),
    ['a', 'b'],
  )
  f.socket.say({ type: 'input', channel: 300, data: 'x' })
  f.socket.say({ type: 'focus', channel: 0 })
  f.socket.say({ type: 'focus', channel: 1 })
  f.socket.say({ type: 'focus' })
  f.socket.emit('message', Buffer.from('{'), false)
  f.socket.emit('message', Buffer.from('null'), false)
  f.socket.emit('message', Buffer.from([0, 1]), true)
  assert.deepEqual(
    f.opened.map(({ log }) => log),
    [['focus'], ['input']],
  )
  const [a, b] = f.opened.map(({ channel }) => channel)
  a!.send({ type: 'status', status: 'connected', channel: 9 })
  a!.send(Uint8Array.of(1, 2))
  b!.send(Uint8Array.of(3))
  assert.deepEqual(f.socket.sent, [
    { type: 'status', status: 'connected', channel: 0 },
    [0, 1, 2],
    [0xac, 0x02, 3],
  ])
})

test('an open needs a whole target and a number not in use; no socket holds more than 128 channels', () => {
  const f = fixture()
  for (const open of [
    { channel: 0, sourceId: 'source', spaceId: 'space' },
    { channel: 1, ...target('') },
    { channel: 2, ...target('a'), sourceId: 7 },
  ])
    f.socket.say({ type: 'open', ...open })
  assert.deepEqual(
    f.socket.sent.splice(0),
    [0, 1, 2].map((channel) => ({ type: 'close', channel })),
  )
  for (const channel of [-1, 1.5, 2 ** 31, '3'])
    f.socket.say({ type: 'open', channel, ...target('a') })
  f.socket.say({ type: 'open', channel: 5, ...target('a') })
  f.socket.say({ type: 'open', channel: 5, ...target('b') })
  assert.deepEqual(
    f.opened.map(({ target }) => target.windowId),
    ['a'],
  )
  for (let channel = 6; channel < 200; channel++)
    f.socket.say({ type: 'open', channel, ...target('c') })
  assert.equal(f.opened.length, 128)
  assert.deepEqual(f.socket.sent, [])
})

test('either side ends a channel alone; the socket closing ends the rest', () => {
  const f = fixture()
  for (const channel of [0, 1, 2, 3]) f.socket.say({ type: 'open', channel, ...target('a') })
  const [a, b, c, d] = f.opened
  f.socket.say({ type: 'close', channel: 0 })
  f.socket.say({ type: 'close', channel: 0 })
  f.socket.say({ type: 'focus', channel: 0 })
  b!.channel.close()
  b!.channel.close()
  b!.channel.send({ type: 'status' })
  b!.channel.send(Uint8Array.of(1))
  f.socket.say({ type: 'focus', channel: 1 })
  assert.deepEqual(f.socket.sent, [{ type: 'close', channel: 1 }])
  assert.deepEqual([a!.channel.readyState, b!.channel.readyState, c!.channel.readyState], [3, 3, 1])
  // The number is free again, though a browser does not reuse one.
  f.socket.say({ type: 'open', channel: 0, ...target('again') })
  assert.equal(f.opened.length, 5)
  f.socket.readyState = 3
  f.socket.emit('close')
  d!.channel.send({ type: 'status' })
  assert.deepEqual(
    f.opened.map(({ log }) => log),
    [['close'], ['close'], ['close'], ['close'], ['close']],
  )
  assert.equal(f.socket.sent.length, 1)
})

test('one authentication serves every channel of the socket', async (t) => {
  const accepted: string[] = [],
    targets: string[] = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', (socket) =>
    authenticateWebSocket(
      socket,
      (token) => token === 'valid',
      (token) => {
        accepted.push(token)
        serveTerminalChannels(socket, (channel, { windowId }) => {
          targets.push(windowId)
          channel.send({ type: 'status', status: 'connecting' })
          channel.send(Uint8Array.of(7))
        })
      },
    ),
  )
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
  t.after(async () => {
    client.terminate()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  await once(client, 'open')
  const received: unknown[] = []
  client.on('message', (data, binary) =>
    received.push(binary ? [...(data as Buffer)] : JSON.parse(String(data))),
  )
  // Sent at once, as a browser does: the channels wait for nothing but the order of messages.
  client.send(JSON.stringify({ type: 'auth', token: 'valid' }))
  for (const channel of [0, 1, 2])
    client.send(JSON.stringify({ type: 'open', channel, ...target(`w${channel}`) }))
  while (received.length < 6) await once(client, 'message')
  assert.deepEqual(accepted, ['valid'])
  assert.deepEqual(targets, ['w0', 'w1', 'w2'])
  assert.deepEqual(
    received,
    [0, 1, 2].flatMap((channel) => [
      { type: 'status', status: 'connecting', channel },
      [channel, 7],
    ]),
  )
})

test('channels opened before authentication are never attached', async (t) => {
  const targets: string[] = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', (socket) =>
    authenticateWebSocket(
      socket,
      (token) => token === 'valid',
      () => serveTerminalChannels(socket, (_, { windowId }) => void targets.push(windowId)),
    ),
  )
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await once(client, 'open')
  client.send(JSON.stringify({ type: 'open', channel: 0, ...target('a') }))
  const [code] = await once(client, 'close')
  assert.deepEqual([code, targets], [1008, []])
})
