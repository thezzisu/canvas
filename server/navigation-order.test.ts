import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type Canvas, type Source } from './state.ts'
import { createApp } from './app.ts'
import type { TerminalManager } from './terminals.ts'

test('instance navigation order is durable, category scoped, and published only when changed', t => {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-order-')), file = join(directory, 'canvas.db')
  let store = new Store(file)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  for (const id of ['a', 'b', 'c']) {
    store.put<Canvas>('canvas', { id, name: id, nodes: [] })
    store.put<Source>('source', { id, name: id, transport: 'local' })
  }
  assert.deepEqual(store.navigationOrder(), { canvases: ['a', 'b', 'c'], sources: ['a', 'b', 'c'] })
  assert.equal(store.get('navigation', 'order'), undefined)
  let changes = 0
  store.on('change', () => changes++)
  store.updateNavigationOrder('canvases', ['c', 'a', 'b'])
  store.updateNavigationOrder('sources', ['b', 'a', 'c'])
  assert.equal(changes, 2)
  assert.deepEqual(store.snapshot().navigationOrder, { canvases: ['c', 'a', 'b'], sources: ['b', 'a', 'c'] })
  store.updateNavigationOrder('sources', ['b', 'a', 'c', 'missing', 'b'])
  assert.equal(changes, 2, 'duplicates and stale IDs cannot emit unnecessary states')
  store.close(); store = new Store(file)
  assert.deepEqual(store.navigationOrder(), { canvases: ['c', 'a', 'b'], sources: ['b', 'a', 'c'] })
  store.remove('source', 'a')
  store.put<Source>('source', { id: 'new', name: 'new', transport: 'local' })
  assert.deepEqual(store.navigationOrder().sources, ['b', 'c', 'new'])
  assert.deepEqual(store.updateNavigationOrder('sources', ['c', 'a', 'b']).sources, ['c', 'b', 'new'], 'stale client ordering retains newly added entries')
  assert.deepEqual(store.navigationOrder().canvases, ['c', 'a', 'b'])
})

test('navigation order API validates one category and shares changes without touching item documents', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-order-api-')), store = new Store(join(directory, 'canvas.db'))
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  store.addSession('fixture')
  for (const id of ['a', 'b']) store.put<Canvas>('canvas', { id, name: id, nodes: [] })
  const before = store.list<Canvas>('canvas')
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {} as TerminalManager)
  const call = (body: unknown, kind = 'canvases', token = 'fixture', origin = 'http://localhost') => app.request(`http://localhost/api/navigation-order/${kind}`, {
    method: 'PATCH', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal((await call({ ids: ['b', 'a'] }, 'canvases', 'missing')).status, 401)
  assert.equal((await call({ ids: ['b', 'a'] }, 'canvases', 'fixture', 'https://elsewhere.test')).status, 403)
  for (const [kind, body] of [['invalid', { ids: [] }], ['canvases', {}], ['canvases', { ids: [''] }], ['canvases', { ids: [1] }], ['canvases', { ids: [], extra: true }], ['canvases', { ids: Array(1001).fill('a') }]] as const) {
    assert.equal((await call(body, kind)).status, 400)
  }
  const response = await call({ ids: ['b', 'a', 'overview'] })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { canvases: ['b', 'a'], sources: [] })
  assert.deepEqual(store.list<Canvas>('canvas'), before, 'ordering never rewrites card geometry or canvas content')
  assert.deepEqual((await (await app.request('http://localhost/api/state', { headers: { Authorization: 'Bearer fixture' } })).json()).navigationOrder, { canvases: ['b', 'a'], sources: [] })
})
