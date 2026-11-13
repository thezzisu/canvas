import test from 'node:test'
import assert from 'node:assert/strict'
import type { WebSocket } from 'ws'
import { createApp } from './app.ts'
import { Store, sourceConnectionKey, type Source } from './state.ts'
import { TerminalManager } from './terminals.ts'

const source: Source = {
  id: '663ee353-dbab-4a62-9628-0548fbb8ea4d',
  name: 'Original',
  transport: 'local',
  herdrSocket: '/fixture/a.sock',
}
const target = { sourceId: source.id, spaceId: 'space', windowId: 'window' }
const key = `${source.id}/${target.windowId}`
const socket = () => ({ readyState: 1 }) as WebSocket
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function entry(manager: TerminalManager, connection = source) {
  const terminal = {
    sourceId: source.id,
    spaceId: target.spaceId,
    connectionKey: sourceConnectionKey(connection),
    closed: false,
    clients: new Set<WebSocket>(),
    async join(ws: WebSocket) {
      this.clients.add(ws)
    },
    async close() {
      this.closed = true
      this.clients.clear()
      manager.entries.delete(key)
    },
  }
  manager.entries.set(key, Promise.resolve(terminal) as never)
  return terminal
}

for (const method of ['PATCH', 'DELETE'] as const)
  test(`${method} retires a source through bridge cleanup and configuration commit`, async (t) => {
    const store = new Store(':memory:'),
      manager = new TerminalManager()
    t.after(async () => {
      await manager.closeAll()
      store.close()
    })
    store.put('source', source)
    store.addSession('fixture')
    const cleaning = gate(),
      release = gate()
    t.after(release.resolve)
    const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, manager, {
      closeOpenBridge: async () => {
        cleaning.resolve()
        await release.promise
      },
    })
    const request = async (verb: string, body?: unknown) =>
      app.request(`http://localhost/api/sources/${source.id}`, {
        method: verb,
        headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const previous = entry(manager)
    await manager.connect(source, target, socket())
    const changing = request(
      method,
      method === 'PATCH' ? { herdrSocket: '/fixture/b.sock' } : undefined,
    )
    await Promise.race([
      cleaning.promise,
      changing.then(async (response) =>
        assert.fail(`request ended before cleanup: ${response.status} ${await response.text()}`),
      ),
    ])
    assert.equal(previous.closed, true)
    assert.deepEqual(store.get('source', source.id), source)
    await assert.rejects(manager.connect(source, target, socket()), /closing/)
    assert.equal(manager.entries.size, 0, 'cleanup cannot admit another old-endpoint attachment')
    const concurrent = await request(
      method,
      method === 'PATCH' ? { herdrSocket: '/fixture/c.sock' } : undefined,
    )
    assert.equal(concurrent.status, 400)
    assert.match((await concurrent.json()).error, /already changing/)
    if (method === 'PATCH')
      assert.equal((await request('PATCH', { name: 'Renamed while closing' })).status, 200)
    release.resolve()
    assert.equal((await changing).status, 200)
    assert.equal(manager.entries.size, 0)
    if (method === 'DELETE') assert.equal(store.get('source', source.id), undefined)
    else {
      const current = store.get<Source>('source', source.id)!
      assert.equal(current.herdrSocket, '/fixture/b.sock')
      assert.equal(
        current.name,
        'Renamed while closing',
        'a partial endpoint patch preserves a concurrent name-only edit',
      )
      const replacement = entry(manager, current)
      await manager.connect(current, target, socket())
      assert.equal(replacement.clients.size, 1)
      assert.equal(previous.clients.size, 0)
    }
  })

test('failed source cleanup retains configuration and releases the retirement gate', async (t) => {
  const store = new Store(':memory:'),
    manager = new TerminalManager()
  t.after(async () => {
    await manager.closeAll()
    store.close()
  })
  store.put('source', source)
  store.addSession('fixture')
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, manager, {
    closeOpenBridge: async () => {
      throw new Error('Fixture cleanup failed')
    },
  })
  entry(manager)
  const response = await app.request(`http://localhost/api/sources/${source.id}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
  })
  assert.equal(response.status, 400)
  assert.deepEqual(store.get('source', source.id), source)
  const replacement = entry(manager)
  await manager.connect(source, target, socket())
  assert.equal(replacement.clients.size, 1)
})

test('existing transport identity must match the requested endpoint', async (t) => {
  const manager = new TerminalManager(),
    terminal = entry(manager)
  t.after(() => manager.closeAll())
  await assert.rejects(
    manager.connect({ ...source, herdrSocket: '/fixture/b.sock' }, target, socket()),
    /connection changed/,
  )
  assert.equal(terminal.clients.size, 0)
  await manager.connect({ ...source, name: 'Renamed' }, target, socket())
  assert.equal(terminal.clients.size, 1, 'display name is not connection identity')
})

test('an attachment resolving during retirement never joins its waiting browser', async (t) => {
  const manager = new TerminalManager(),
    terminal = entry(manager),
    ready = gate()
  t.after(() => manager.closeAll())
  t.after(ready.resolve)
  manager.entries.set(key, ready.promise.then(() => terminal) as never)
  const connecting = manager.connect(source, target, socket())
  const rejected = assert.rejects(connecting, /closing/)
  const retiring = manager.closeSource(source.id)
  ready.resolve()
  await Promise.all([rejected, retiring])
  assert.equal(terminal.closed, true)
  assert.equal(terminal.clients.size, 0)
  assert.equal(manager.entries.size, 0)
})
