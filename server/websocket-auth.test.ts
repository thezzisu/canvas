import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { authenticateWebSocket } from './websocket-auth.ts'

async function fixture(t: TestContext, timeoutMs = 5000) {
  const accepted: string[] = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', socket => authenticateWebSocket(socket, token => token === 'valid', token => {
    accepted.push(token)
    socket.send(JSON.stringify({ type: 'status', status: 'connecting' }))
  }, timeoutMs))
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
  await once(client, 'open')
  t.after(async () => { client.terminate(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { client, accepted }
}

test('WebSocket attaches only after one valid first-frame authentication', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.accepted, [])
  const ack = once(f.client, 'message')
  f.client.send(JSON.stringify({ type: 'auth', token: 'valid' }))
  assert.deepEqual(JSON.parse(String((await ack)[0])), { type: 'status', status: 'connecting' })
  f.client.send(JSON.stringify({ type: 'auth', token: 'valid' }))
  const closed = once(f.client, 'close'); f.client.close(); await closed
  assert.deepEqual(f.accepted, ['valid'])
})

test('WebSocket rejects invalid, binary and non-auth first frames without attaching', async t => {
  for (const message of ['{', '{}', '{"type":"input","data":"x"}', '{"type":"auth","token":"wrong"}',
    '{"type":"auth","token":"valid","extra":true}', Buffer.from('{"type":"auth","token":"valid"}')]) {
    const f = await fixture(t), closed = once(f.client, 'close')
    f.client.send(message)
    assert.equal((await closed)[0], 1008)
    assert.deepEqual(f.accepted, [])
  }
})

test('WebSocket expires pending authentication without creating a terminal', async t => {
  const f = await fixture(t, 25)
  assert.equal((await once(f.client, 'close'))[0], 1008)
  assert.deepEqual(f.accepted, [])
})
