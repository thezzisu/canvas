import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { watchHerdr } from './watch.ts'

interface Stream {
  id: string
  socket: Socket
  types: string[]
  panes: string[]
}

/** A herdr API of its own on a private socket. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-watch-')),
    path = join(root, 'herdr.sock'),
    sockets = new Set<Socket>(),
    live = new Set<Stream>(),
    log: string[] = []
  const state = {
    panes: [] as Record<string, unknown>[],
    refuse: new Set<string>(),
  }
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    let text = ''
    socket.on('data', (data) => {
      text += data
      const end = text.indexOf('\n')
      if (end < 0) return
      const { id, method, params } = JSON.parse(text.slice(0, end))
      text = ''
      if (method === 'session.snapshot') {
        log.push('read')
        socket.end(JSON.stringify({ id, result: { snapshot: { panes: state.panes } } }) + '\n')
        return
      }
      const types = params.subscriptions.map((item: { type: string }) => item.type),
        panes = params.subscriptions.flatMap((item: { pane_id?: string }) => item.pane_id ?? [])
      if (panes.some((pane: string) => state.refuse.has(pane))) {
        log.push(`refuse ${panes}`)
        socket.end(JSON.stringify({ id, error: { code: 'pane_not_found' } }) + '\n')
        return
      }
      const stream = { id, socket, types, panes }
      live.add(stream)
      log.push(panes.length ? `status ${panes}` : 'changes')
      socket.once('close', () => live.delete(stream))
      socket.write(JSON.stringify({ id, result: { type: 'subscription_started' } }) + '\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const changes = () => [...live].find((stream) => !stream.panes.length)!
  const statuses = () => [...live].filter((stream) => stream.panes.length)
  const emit = (stream: Stream, event: string, data: object = {}) =>
    stream.socket.write(JSON.stringify({ event, data }) + '\n')
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 400; i++) {
      if (check()) return
      await sleep(10)
    }
    assert.fail(`${what}: ${log}`)
  }
  const snapshots: Record<string, unknown>[] = [],
    records: unknown[] = [],
    endings: string[] = []
  const start = () => {
    const watch = watchHerdr(path, {
      snapshot: (result) => snapshots.push(result),
      pane: (record) => records.push(record),
      ended: (error) => endings.push(error.message),
    })
    t.after(() => watch.close())
    return watch
  }
  const reads = () => log.filter((entry) => entry === 'read').length
  return {
    state,
    log,
    live,
    changes,
    statuses,
    emit,
    until,
    start,
    reads,
    snapshots,
    records,
    endings,
  }
}

test('the watch subscribes before it reads, and a burst of events is one read', async (t) => {
  const f = await fixture(t)
  f.start()
  await f.until(() => f.snapshots.length === 1, 'first read')
  assert.deepEqual(f.log, ['changes', 'read'])
  assert(!f.changes().types.includes('tab.focused'), "Canvas's own focus moves cause no read")
  for (let i = 0; i < 20; i++) f.emit(f.changes(), 'tab_renamed')
  await f.until(() => f.reads() === 2, 'read after the burst')
  await sleep(250)
  assert.equal(f.reads(), 2)
})

test('a pane record is passed on ahead of the read it causes', async (t) => {
  const f = await fixture(t)
  f.start()
  await f.until(() => f.snapshots.length === 1, 'first read')
  f.emit(f.changes(), 'pane_updated', { pane: { pane_id: 'p1', revision: 2 } })
  await f.until(() => f.records.length === 1, 'record')
  assert.equal(f.reads(), 1)
  await f.until(() => f.reads() === 2, 'read')
})

test('only agent panes have their status followed, and a status change causes a read', async (t) => {
  const f = await fixture(t)
  f.state.panes = [{ pane_id: 'shell' }, { pane_id: 'a', agent: 'claude' }]
  f.start()
  // The read after the status subscription started covers what changed while it started.
  await f.until(() => f.reads() === 2, 'read after the status subscription')
  assert.deepEqual(f.log, ['changes', 'read', 'status a', 'read'])
  f.emit(f.statuses()[0]!, 'pane.agent_status_changed', { pane_id: 'a', agent_status: 'blocked' })
  await f.until(() => f.reads() === 3, 'read after a status change')

  f.state.panes.push({ pane_id: 'b', display_agent: 'Codex' })
  f.emit(f.changes(), 'pane_agent_detected')
  await f.until(
    () => f.statuses().length === 1 && String(f.statuses()[0]!.panes) === 'a,b',
    'grown',
  )
  f.state.panes = [{ pane_id: 'shell' }]
  f.emit(f.changes(), 'pane_agent_detected')
  await f.until(() => !f.statuses().length, 'no agent left')
  assert.deepEqual(f.endings, [])
})

test('a pane closing during its subscription does not end the watch', async (t) => {
  const f = await fixture(t)
  f.state.panes = [
    { pane_id: 'a', agent: 'claude' },
    { pane_id: 'gone', agent: 'claude' },
  ]
  f.state.refuse.add('gone')
  f.start()
  await f.until(() => f.log.includes('refuse a,gone'), 'refusal')
  f.state.panes.pop()
  await f.until(() => f.log.includes('status a'), 'the rest followed')
  assert.deepEqual(f.endings, [])
})

test('lost events are followed again and read anew; lost again at once, the watch ends', async (t) => {
  const f = await fixture(t)
  f.state.panes = [{ pane_id: 'a', agent: 'claude' }]
  f.start()
  await f.until(() => f.statuses().length === 1, 'both streams')
  const lose = () => {
    const stream = f.changes()
    stream.socket.write(JSON.stringify({ id: stream.id, error: { code: 'events_lost' } }) + '\n')
    return stream
  }
  const reads = f.reads(),
    lost = lose()
  await f.until(() => !!f.changes() && f.changes() !== lost && f.reads() > reads, 'followed again')
  assert.deepEqual(f.endings, [], 'a gap is no break: the source stays online')
  assert.equal(f.statuses().length, 1)
  lose()
  await f.until(() => !f.live.size, 'streams closed')
  assert.deepEqual(f.endings, ['Herdr ended the event subscription: events_lost'])
})

test('closing the watch is not its ending, and leaves nothing open', async (t) => {
  const f = await fixture(t)
  f.state.panes = [{ pane_id: 'a', agent: 'claude' }]
  const watch = f.start()
  await f.until(() => f.statuses().length === 1, 'both streams')
  watch.close()
  await f.until(() => !f.live.size, 'streams closed')
  assert.deepEqual(f.endings, [])
})

test('a change herdr does not announce is read when the watch is told of it', async (t) => {
  const f = await fixture(t)
  const watch = f.start()
  await f.until(() => f.snapshots.length === 1, 'first read')
  watch.refresh()
  watch.refresh()
  await f.until(() => f.reads() === 2, 'read on refresh')
  await sleep(200)
  assert.equal(f.reads(), 2)
})
