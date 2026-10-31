import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type Canvas, type NoteNode } from './state.ts'
import { AssetStore } from './assets.ts'
import { createApp } from './app.ts'
import type { TerminalManager } from './terminals.ts'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-shared-cards-')), store = new Store(join(directory, 'canvas.db'))
  const assets = new AssetStore(directory, store)
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {} as TerminalManager, { assets })
  store.addSession('fixture')
  const request = (path: string, method = 'GET', body?: unknown) => app.request(`http://localhost${path}`, {
    method, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const a = store.put<Canvas>('canvas', { id: randomUUID(), name: 'A', nodes: [] })
  const b = store.put<Canvas>('canvas', { id: randomUUID(), name: 'B', nodes: [] })
  t.after(async () => { await assets.close(); store.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, store, assets, app, request, a, b }
}
function noteIn(store: Store, canvasId: string, nodeId: string): NoteNode {
  const note = store.get<Canvas>('canvas', canvasId)!.nodes.find(node => node.id === nodeId)
  assert(note?.type === 'note')
  return note
}

test('note references share content in one published transaction while layout and minimization stay local', async t => {
  const f = await fixture(t)
  const creation = await f.request(`/api/canvases/${f.a.id}/notes`, 'POST', { title: 'Shared', content: 'Initial', color: 'blue', x: 10, y: 20 })
  const note = ((await creation.json()) as Canvas).nodes.find(node => node.type === 'note')!
  const share = `/api/canvases/${f.b.id}/references`, payload = { sourceCanvasId: f.a.id, nodeId: note.id, x: 400, y: 500 }
  const revision = f.store.revision
  assert.equal((await f.request(share, 'POST', payload)).status, 201)
  assert.equal(f.store.revision, revision + 1)
  assert.equal((await f.request(share, 'POST', { ...payload, x: -50 })).status, 200)
  assert.equal(f.store.revision, revision + 1, 'duplicate reference is a no-op')
  assert.equal(noteIn(f.store, f.b.id, note.id).x, 400)
  await f.request(`/api/canvases/${f.b.id}/layout`, 'PATCH', { nodes: [{ id: note.id, width: 720, height: 500 }] })
  const staleA = f.store.get<Canvas>('canvas', f.a.id)!, staleB = f.store.get<Canvas>('canvas', f.b.id)!
  const snapshots: string[][] = []
  const inspect = () => snapshots.push([f.a.id, f.b.id].map(id => noteIn(f.store, id, note.id).content))
  f.store.on('change', inspect)
  assert.equal((await f.request(`/api/canvases/${f.a.id}/notes/${note.id}`, 'PATCH', { title: 'Latest', content: 'Both browsers', color: 'green', minimized: true })).status, 200)
  f.store.off('change', inspect)
  assert.deepEqual(snapshots, [['Both browsers', 'Both browsers']], 'only the complete multi-canvas snapshot is published')
  for (const id of [f.a.id, f.b.id]) {
    const current = noteIn(f.store, id, note.id)
    assert.equal(current.title, 'Latest'); assert.equal(current.color, 'green'); assert.equal(current.content, 'Both browsers')
  }
  assert.equal(noteIn(f.store, f.a.id, note.id).minimized, true); assert.equal(noteIn(f.store, f.b.id, note.id).minimized, false)
  assert.equal(noteIn(f.store, f.a.id, note.id).width, 320); assert.equal(noteIn(f.store, f.b.id, note.id).width, 720)
  for (const [method, stale] of [['PUT', staleA], ['PATCH', staleB]] as const) {
    assert.equal((await f.request(`/api/canvases/${stale.id}`, method, { ...stale, name: 'Rename with old body' })).status, 200)
    assert.equal(noteIn(f.store, stale.id, note.id).content, 'Both browsers', 'a stale canvas body cannot replace shared content')
  }
  await f.request(`/api/canvases/${f.b.id}/notes/${note.id}`, 'PATCH', { content: 'Edited from B' })
  assert.equal(noteIn(f.store, f.a.id, note.id).content, 'Edited from B')
  await f.request(`/api/canvases/${f.a.id}`, 'DELETE')
  assert.equal(noteIn(f.store, f.b.id, note.id).content, 'Edited from B', 'deleting the originating canvas retains its other reference')
})

test('file references retain the original bytes until the last canvas reference is removed', async t => {
  const f = await fixture(t), bytes = Buffer.from('# Shared file\n\nOne stored file, two cards.')
  const upload = await f.assets.begin({ filename: 'shared.md', size: bytes.length }); await upload.write(bytes)
  const asset = await upload.complete({ canvasId: f.a.id, position: { x: 20, y: 40 } })
  const file = f.store.get<Canvas>('canvas', f.a.id)!.nodes.find(node => node.type === 'file')!
  assert.equal((await f.request(`/api/canvases/${f.b.id}/references`, 'POST', { sourceCanvasId: f.a.id, nodeId: file.id })).status, 201)
  assert.equal(f.store.fileAssetForCanvas(asset.id, f.b.id)?.id, asset.id)
  assert.equal(f.store.fileAssetForCanvas(asset.id, randomUUID()), undefined)
  assert.equal(f.store.fileAssetIds().length, 1)
  await f.request(`/api/canvases/${f.b.id}/layout`, 'PATCH', { nodes: [{ id: file.id, width: 880, height: 620 }] })
  assert.equal(f.store.get<Canvas>('canvas', f.a.id)!.nodes[0]!.width, file.width)
  assert.equal(f.store.get<Canvas>('canvas', f.b.id)!.nodes[0]!.width, 880)
  const unrelated = f.store.put<Canvas>('canvas', { id: randomUUID(), name: 'Unrelated', nodes: [] })
  assert.throws(() => f.store.put('canvas', { ...unrelated, nodes: [file] }), /File asset not found/)
  await f.request(`/api/canvases/${f.a.id}`, 'DELETE')
  assert.deepEqual(await readFile(join(f.directory, 'files', asset.id)), bytes)
  assert.equal(f.store.canvasView(f.store.get<Canvas>('canvas', f.b.id)!).nodes.find(node => node.type === 'file')!.asset.id, asset.id)
  const served = await f.request(`/api/files/${asset.id}`); assert.equal(served.status, 200); assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes)
  await f.request(`/api/canvases/${f.b.id}/nodes/${file.id}`, 'DELETE')
  const deadline = Date.now() + 2000
  while (await stat(join(f.directory, 'files', asset.id)).catch(() => undefined)) {
    assert(Date.now() < deadline, 'last-reference cleanup removes file bytes')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(f.store.fileAsset(asset.id), undefined)
})

test('reference creation validates its source, destination and type before making any change', async t => {
  const f = await fixture(t), revision = f.store.revision
  const payload = { sourceCanvasId: f.a.id, nodeId: 'absent' }
  assert.equal((await f.request(`/api/canvases/${f.b.id}/references`, 'POST', payload)).status, 404)
  assert.equal((await f.request(`/api/canvases/${randomUUID()}/references`, 'POST', payload)).status, 404)
  assert.equal((await f.request(`/api/canvases/${f.b.id}/references`, 'POST', { ...payload, sourceCanvasId: randomUUID() })).status, 404)
  assert.equal((await f.request('/api/canvases/overview/references', 'POST', payload)).status, 403)
  assert.equal((await f.request(`/api/canvases/${f.b.id}/references`, 'POST', { ...payload, sourceCanvasId: 'overview' })).status, 403)
  assert.equal((await f.app.request(`http://localhost/api/canvases/${f.b.id}/references`, { method: 'POST', body: JSON.stringify(payload) })).status, 401)
  assert.equal(f.store.revision, revision)
  assert.equal(f.store.get<Canvas>('canvas', f.b.id)!.nodes.length, 0)
})
