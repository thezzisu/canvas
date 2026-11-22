import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribeHerdrEvents } from './events.ts'
import type { PaneRecord } from './pane-titles.ts'

async function fakeHerdr(
  t: import('node:test').TestContext,
  reply: (socket: Socket, request: { id: string; method: string; params: unknown }) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), 'cv-titles-')),
    path = join(directory, 'herdr.sock'),
    sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const end = buffer.indexOf('\n')
      if (end >= 0) reply(socket, JSON.parse(buffer.slice(0, end)))
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  return path
}

test('events follow the started subscription; lost events end it', async (t) => {
  let request: { id: string; method: string; params: unknown } | undefined, peer: Socket | undefined
  const path = await fakeHerdr(t, (socket, value) => {
    request = value
    peer = socket
    socket.write(JSON.stringify({ id: value.id, result: { type: 'subscription_started' } }) + '\n')
  })
  const panes: PaneRecord[] = []
  let started = false,
    ended: Error | undefined | null = null
  subscribeHerdrEvents(path, [{ type: 'pane.updated' }], {
    started: () => (started = true),
    event: (_name, data) => panes.push(data.pane as PaneRecord),
    ended: (error) => (ended = error),
  })
  for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(request?.method, 'events.subscribe')
  assert.deepEqual(request?.params, { subscriptions: [{ type: 'pane.updated' }] })
  const event = (title: string) =>
    JSON.stringify({
      event: 'pane_updated',
      data: {
        type: 'pane_updated',
        pane: { pane_id: 'w1:p1', revision: 1, terminal_title_stripped: title },
      },
    }) + '\n'
  // Split across writes, two in one write.
  const both = event('one') + event('two')
  peer!.write(both.slice(0, 10))
  peer!.write(both.slice(10))
  for (let i = 0; i < 100 && panes.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(
    panes.map((pane) => pane.terminal_title_stripped),
    ['one', 'two'],
  )
  peer!.write(
    JSON.stringify({ id: request!.id, error: { code: 'events_lost', message: 'behind' } }) + '\n',
  )
  for (let i = 0; i < 100 && ended === null; i++) await new Promise((r) => setTimeout(r, 5))
  assert.match(String(ended), /events_lost/)
})

test('a subscription herdr does not start ends, and close ends it once', async (t) => {
  const path = await fakeHerdr(t, () => {})
  const endings: (Error | undefined)[] = []
  const subscription = subscribeHerdrEvents(
    path,
    [{ type: 'pane.updated' }],
    {
      started: () => assert.fail('not started'),
      event: () => {},
      ended: (error) => endings.push(error),
    },
    { timeoutMs: 30 },
  )
  for (let i = 0; i < 100 && !endings.length; i++) await new Promise((r) => setTimeout(r, 5))
  subscription.close()
  assert.equal(endings.length, 1)
  assert.match(String(endings[0]), /did not start/)
})
