import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PaneTitles, paneTitle, subscribePaneUpdates, type PaneRecord } from './pane-titles.ts'

test('titles are shown as published: only control characters go, at most 1024 characters', () => {
  assert.equal(paneTitle(' \x1b⠋ Working\x07 '), '⠋ Working')
  assert.equal(paneTitle('● ⠙ canvas'), '● ⠙ canvas')
  assert.equal(paneTitle('中'.repeat(2000)).length, 1024)
  assert.equal(paneTitle(undefined), '')
})

test('the newer pane revision wins, whichever source it came from', () => {
  const titles = new PaneTitles(),
    changes: string[][] = []
  titles.onChange((paneIds) => changes.push([...paneIds]))
  titles.update({ pane_id: 'a', revision: 5, terminal_title_stripped: 'event' })
  // A snapshot read before that event arrives after it.
  titles.replace([
    { pane_id: 'a', revision: 4, terminal_title_stripped: 'older' },
    { pane_id: 'b', revision: 1, terminal_title_stripped: 'shell' },
  ])
  assert.equal(titles.title('a'), 'event')
  assert.equal(titles.title('b'), 'shell')
  titles.update({ pane_id: 'a', revision: 6, terminal_title_stripped: 'event' })
  assert.deepEqual(changes, [['a'], ['b']], 'an unchanged title is not a change')
  titles.replace([{ pane_id: 'b', revision: 2, terminal_title_stripped: '' }])
  assert.equal(titles.title('a'), undefined, 'a pane the server no longer lists is gone')
  assert.equal(titles.title('b'), '')
  titles.update({ pane_id: 'c', terminal_title_stripped: 'no revision' } as PaneRecord)
  assert.equal(titles.title('c'), undefined)
  titles.clear()
  assert.equal(titles.title('b'), undefined)
  assert.deepEqual(changes.at(-1), ['b'])
})

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

test('pane.updated events follow the started subscription; lost events end it', async (t) => {
  let request: { id: string; method: string; params: unknown } | undefined, peer: Socket | undefined
  const path = await fakeHerdr(t, (socket, value) => {
    request = value
    peer = socket
    socket.write(JSON.stringify({ id: value.id, result: { type: 'subscription_started' } }) + '\n')
  })
  const panes: PaneRecord[] = []
  let started = false,
    ended: Error | undefined | null = null
  subscribePaneUpdates(path, {
    started: () => (started = true),
    pane: (record) => panes.push(record),
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
  const subscription = subscribePaneUpdates(
    path,
    {
      started: () => assert.fail('not started'),
      pane: () => {},
      ended: (error) => endings.push(error),
    },
    { timeoutMs: 30 },
  )
  for (let i = 0; i < 100 && !endings.length; i++) await new Promise((r) => setTimeout(r, 5))
  subscription.close()
  assert.equal(endings.length, 1)
  assert.match(String(endings[0]), /did not start/)
})
