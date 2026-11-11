import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createApp } from './app.ts'
import { Store, type Canvas, type ComposerView, type NoteNode, type Source } from './state.ts'
import type { TerminalManager } from './terminals.ts'
import { WriteOrder, parseWriteMark } from './write-order.ts'

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-write-order-'))
  const store = new Store(join(dir, 'canvas.db'))
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {
    closeAll: async () => {},
    closeSource: async () => {},
    onNotification: () => ({ dispose() {} }),
  } as unknown as TerminalManager)
  store.addSession('test')
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const source = store.put<Source>('source', {
    id: randomUUID(),
    name: 'Fixture',
    transport: 'local',
  })
  const canvas = store.put<Canvas>('canvas', {
    id: randomUUID(),
    name: 'Canvas',
    nodes: [
      {
        id: 'note',
        type: 'note',
        title: 'A',
        content: 'A',
        color: 'yellow',
        x: 0,
        y: 0,
        width: 320,
        height: 240,
      },
    ],
  })
  let changes = 0
  store.on('change', () => changes++)
  /** `mark` is the page and the sequence number of its write; none sends no header. */
  const patch = (path: string, body: unknown, mark?: string) =>
    app.request(`http://localhost${path}`, {
      method: 'PATCH',
      headers: {
        Host: 'localhost',
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
        ...(mark ? { 'Canvas-Write': mark } : {}),
      },
      body: JSON.stringify(body),
    })
  return {
    store,
    patch,
    canvas: `/api/canvases/${canvas.id}`,
    composer: `/api/sources/${source.id}/windows/window/composer`,
    note: () =>
      store
        .get<Canvas>('canvas', canvas.id)!
        .nodes.find((node): node is NoteNode => node.type === 'note')!,
    changes: () => changes,
  }
}

test('a note write that a newer one from its page overtook is acknowledged and ignored', async (t) => {
  const f = fixture(t),
    path = `${f.canvas}/notes/note`
  assert.equal((await f.patch(path, { content: 'newer' }, 'page.2')).status, 200)
  const published = f.changes()
  const late = await f.patch(path, { content: 'older' }, 'page.1')
  assert.equal(late.status, 200, 'the page is not told its superseded write failed')
  assert.equal(f.note().content, 'newer')
  assert.deepEqual(
    ((await late.json()) as Canvas).nodes.map((node) => node.type === 'note' && node.content),
    ['newer'],
    'the acknowledgement carries the stored note',
  )
  assert.equal(f.changes(), published, 'nothing changed, so nothing is published')
  await f.patch(path, { content: 'latest' }, 'page.3')
  assert.equal(f.note().content, 'latest')
})

test('note fields are ordered separately, so an overtaken write keeps what nothing newer replaced', async (t) => {
  const f = fixture(t),
    path = `${f.canvas}/notes/note`
  await f.patch(path, { content: 'newer' }, 'page.2')
  await f.patch(path, { title: 'Title', content: 'older' }, 'page.1')
  assert.deepEqual([f.note().title, f.note().content], ['Title', 'newer'])
})

test('writes from different pages keep last-writer-wins', async (t) => {
  const f = fixture(t),
    path = `${f.canvas}/notes/note`
  await f.patch(path, { content: 'first page' }, 'first.9')
  await f.patch(path, { content: 'second page' }, 'second.1')
  assert.equal(f.note().content, 'second page')
})

test('a layout write that a newer one from its page overtook is acknowledged and ignored', async (t) => {
  const f = fixture(t),
    path = `${f.canvas}/layout`
  await f.patch(path, { nodes: [{ id: 'note', x: 200, y: 200 }] }, 'page.2')
  const published = f.changes()
  const late = await f.patch(path, { nodes: [{ id: 'note', x: 100, width: 400 }] }, 'page.1')
  assert.equal(late.status, 200)
  assert.deepEqual(
    [f.note().x, f.note().y, f.note().width],
    [200, 200, 400],
    'only the field nothing newer wrote is applied',
  )
  const again = await f.patch(path, { nodes: [{ id: 'note', x: 100 }] }, 'page.1')
  assert.equal(again.status, 200)
  assert.equal(f.note().x, 200)
  assert.equal(f.changes(), published + 1, 'a wholly superseded write publishes nothing')
})

test('a window size shared by two canvases is ordered across them', async (t) => {
  const f = fixture(t)
  const card = {
    id: 'terminal',
    type: 'terminal' as const,
    sourceId: randomUUID(),
    spaceId: 'space',
    windowId: 'window',
    x: 0,
    y: 0,
    width: 500,
    height: 300,
  }
  const [a, b] = ['A', 'B'].map((name) =>
    f.store.put<Canvas>('canvas', { id: randomUUID(), name, nodes: [{ ...card }] }),
  )
  await f.patch(
    `/api/canvases/${b!.id}/layout`,
    { nodes: [{ id: 'terminal', width: 700 }] },
    'page.2',
  )
  const late = await f.patch(
    `/api/canvases/${a!.id}/layout`,
    { nodes: [{ id: 'terminal', x: 40, width: 600 }] },
    'page.1',
  )
  assert.equal(late.status, 200)
  assert.equal(f.store.windowSize(card.sourceId, card.windowId).width, 700)
  assert.equal(f.store.get<Canvas>('canvas', a!.id)!.nodes[0]!.x, 40, 'positions stay per canvas')
})

test('a rejected write does not supersede the older one it overtook', async (t) => {
  const f = fixture(t),
    path = `${f.canvas}/layout`
  const conflict = await f.patch(
    path,
    { nodes: [{ id: 'note', x: 300, expected: { x: 999 } }] },
    'page.2',
  )
  assert.equal(conflict.status, 409)
  await f.patch(path, { nodes: [{ id: 'note', x: 100 }] }, 'page.1')
  assert.equal(f.note().x, 100)
})

test('a composer write that a newer one from its page overtook is acknowledged and ignored', async (t) => {
  const f = fixture(t)
  await f.patch(f.composer, { content: 'newer' }, 'page.2')
  const published = f.changes()
  const late = await f.patch(f.composer, { content: 'older' }, 'page.1')
  assert.equal(late.status, 200)
  const view = (await late.json()) as ComposerView
  assert.deepEqual([view.content, view.version], ['newer', 1])
  assert.equal(f.changes(), published)
})

test('a malformed write order is refused; a caller that sends none is simply not ordered', async (t) => {
  const f = fixture(t)
  const writes = [
    [`${f.canvas}/notes/note`, { content: 'unordered' }],
    [`${f.canvas}/layout`, { nodes: [{ id: 'note', x: 5 }] }],
    [f.composer, { content: 'unordered' }],
  ] as const
  for (const mark of ['page', 'page.x', '.1', 'page.1.2'])
    for (const [path, body] of writes)
      assert.equal((await f.patch(path, body, mark)).status, 400, `${mark} ${path}`)
  assert.deepEqual([f.note().content, f.note().x], ['A', 0])
  for (const [path, body] of writes) assert.equal((await f.patch(path, body)).status, 200, path)
  assert.deepEqual([f.note().content, f.note().x], ['unordered', 5])
})

test('the order forgets the resources written longest ago', () => {
  const order = new WriteOrder(2),
    mark = (sequence: number) => ({ page: 'page', sequence })
  order.record(mark(5), 'a', ['content'])
  order.record(mark(6), 'b', ['content'])
  order.record(mark(7), 'a', ['title'])
  order.record(mark(8), 'c', ['content'])
  assert.deepEqual(order.fresh(mark(1), 'a', ['content', 'title', 'color']), ['color'])
  assert.deepEqual(order.fresh(mark(1), 'b', ['content']), ['content'], 'b was written first')
  assert.deepEqual(order.fresh(mark(8), 'c', ['content']), [], 'a repeated write is not newer')
  assert.deepEqual(order.fresh({ page: 'other', sequence: 1 }, 'c', ['content']), ['content'])
  assert.deepEqual(parseWriteMark('0f8fad5b-d9cb-469f-a165-70867728950e.12'), {
    page: '0f8fad5b-d9cb-469f-a165-70867728950e',
    sequence: 12,
  })
})
