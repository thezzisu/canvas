import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AssetStore } from './assets.ts'
import { Store, type Canvas, type NoteNode } from './state.ts'
import { createApp } from './app.ts'
import { receiveCanvasFile } from './canvas-files.ts'
import { CARD_REMOVAL_UNDO_MS } from '../shared/card-removal.ts'
import type { TerminalManager } from './terminals.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-note-assets-')), store = new Store(join(root, 'canvas.db'))
  const assets = new AssetStore(root, store)
  store.addSession('fixture')
  const note: NoteNode = { id: randomUUID(), type: 'note', title: '', content: 'Draft', color: 'blue', x: 0, y: 0, width: 320, height: 240 }
  const canvas = store.put<Canvas>('canvas', { id: randomUUID(), name: 'A', nodes: [note] })
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {} as TerminalManager, { assets })
  t.after(async () => { await assets.close(); store.close(); await rm(root, { recursive: true, force: true }) })
  const upload = async (noteId = note.id, canvasId = canvas.id) => app.request(`http://canvas.test/api/canvases/${canvasId}/notes/${noteId}/files?filename=photo.png&size=3`, {
    method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/octet-stream' }, body: 'abc',
  })
  return { root, store, assets, canvas, note, app, upload }
}

test('upload associates an asset with a shared note without replacing its current text or creating file cards', async t => {
  const f = await fixture(t)
  const peer = f.store.put<Canvas>('canvas', { id: randomUUID(), name: 'B', nodes: [] })
  f.store.addNodeReference(f.canvas.id, f.note.id, peer.id, { x: 50, y: 70 })
  f.store.updateNote(f.canvas.id, f.note.id, { content: 'Typing while uploading' })
  const response = await f.upload()
  assert.equal(response.status, 201)
  const asset = await response.json()
  for (const id of [f.canvas.id, peer.id]) {
    const canvas = f.store.get<Canvas>('canvas', id)!
    assert.equal(canvas.nodes.length, 1)
    assert.equal((canvas.nodes[0] as NoteNode).content, 'Typing while uploading')
    const view = f.store.canvasView(canvas).nodes[0] as NoteNode
    assert.equal(view.attachments?.[0]?.id, asset.id)
    assert.equal(f.store.fileAssetForCanvas(asset.id, id)?.id, asset.id)
  }
  assert.equal((await f.app.request(`http://canvas.test/api/files/${asset.id}`, { headers: { Authorization: 'Bearer fixture' } })).status, 200)
  assert.equal((await f.upload(randomUUID())).status, 404)
  assert.equal(f.store.fileAssetIds().length, 1)
})

test('removing capsules keeps bytes for editor undo; shared and removed-card references retain note assets', async t => {
  const f = await fixture(t), response = await f.upload(), asset = await response.json()
  f.store.updateNote(f.canvas.id, f.note.id, { content: '' })
  assert(f.store.fileAssetReferenced(asset.id), 'capsule content is not asset ownership')
  const peer = f.store.put<Canvas>('canvas', { id: randomUUID(), name: 'B', nodes: [] })
  f.store.addNodeReference(f.canvas.id, f.note.id, peer.id, { x: 0, y: 0 })
  f.store.remove('canvas', f.canvas.id)
  assert(f.store.fileAssetReferenced(asset.id))
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const removed = f.store.removeCard(peer.id, f.note.id, 'fixture')!
  assert(f.store.fileAssetReferenced(asset.id), 'last card remains recoverable during undo grace')
  assert(f.store.restoreCard(peer.id, removed.undo!.token, 'fixture'))
  t.mock.timers.tick(CARD_REMOVAL_UNDO_MS + 1)
  assert(f.store.fileAssetReferenced(asset.id), 'restored card owns the asset')
  f.store.removeCard(peer.id, f.note.id, 'fixture')
  t.mock.timers.tick(CARD_REMOVAL_UNDO_MS + 1)
  assert.equal(f.store.fileAssetReferenced(asset.id), false)
  assert(f.store.removeFileAssetIfUnreferenced(asset.id))
  assert.deepEqual(f.store.noteAttachments(f.note.id), [], 'association is removed with its asset')
})

test('deleting the note or revoking its session aborts an in-flight attachment and discards partial bytes', async t => {
  for (const reason of ['note', 'session'] as const) await t.test(reason, async t => {
    const f = await fixture(t)
    let ready!: () => void
    const reading = new Promise<void>(resolve => { ready = resolve })
    const stream = new ReadableStream<Uint8Array>({ pull() { ready() } })
    const request = new Request('http://canvas.test/file', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    const pending = receiveCanvasFile(f.store, f.assets, f.canvas.id, { noteId: f.note.id, filename: 'partial.png', size: 9 }, request, 'fixture')
    await reading
    if (reason === 'note') f.store.removeCard(f.canvas.id, f.note.id, 'fixture')
    else f.store.removeSession('fixture')
    await assert.rejects(pending)
    assert.deepEqual(f.store.fileAssetIds(), [])
    assert.deepEqual(await readdir(join(f.root, 'files')), [])
  })
})
