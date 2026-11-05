import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type Canvas, type CanvasNode, type NoteNode, type Source } from './state.ts'
import { AssetStore } from './assets.ts'
import { createApp } from './app.ts'
import type { TerminalManager } from './terminals.ts'
import { CARD_REMOVAL_UNDO_MS, type CardRemovalResponse } from '../shared/card-removal.ts'

const note = (id = 'note'): NoteNode => ({ id, type: 'note', title: 'Draft', content: 'Original', color: 'blue', x: -40.25, y: 80, width: 350.5, height: 240.25 })
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-remove-')), store = new Store(join(root, 'canvas.db')), assets = new AssetStore(root, store)
  store.addSession('first'); store.addSession('other')
  const source = store.put<Source>('source', { id: randomUUID(), name: 'Native', transport: 'local' })
  const terminal: CanvasNode = { id: 'terminal', type: 'terminal', sourceId: source.id, spaceId: 'space', windowId: 'window', x: 400.5, y: -10, width: 480, height: 320 }
  const canvas = store.put<Canvas>('canvas', { id: randomUUID(), name: 'Canvas', nodes: [note(), terminal] })
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {} as TerminalManager, { assets })
  const request = (path: string, method = 'POST', body: unknown = {}, session = 'first') => app.request(`http://localhost${path}`, {
    method, headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body),
  })
  const remove = async (id: string, canvasId = canvas.id) => {
    const response = await request(`/api/canvases/${canvasId}/nodes/${id}`, 'DELETE')
    assert.equal(response.status, 200)
    return await response.json() as CardRemovalResponse<Canvas>
  }
  const undo = (token: string, canvasId = canvas.id, session = 'first') => request(`/api/canvases/${canvasId}/removals/${token}/undo`, 'POST', {}, session)
  const current = () => store.get<Canvas>('canvas', canvas.id)!
  t.after(async () => { await assets.close(); store.close(); await rm(root, { recursive: true, force: true }) })
  return { root, store, assets, source, canvas, terminal, request, remove, undo, current }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
async function removed(path: string) {
  for (let i = 0; i < 100; i++) {
    if (!(await stat(path).catch(() => undefined))) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('expired final file reference was not collected')
}

test('remove is immediate and undo restores only its reference, geometry and current shared state', async t => {
  const f = await fixture(t), original = f.current().nodes[0]!
  const first = await f.remove(original.id)
  assert.equal(first.lastReference, true)
  assert(first.undo && first.undo.remainingMs > 0 && first.undo.remainingMs <= CARD_REMOVAL_UNDO_MS)
  assert.equal(first.canvas.nodes.length, 1); assert.equal(f.current().nodes.length, 1)
  assert.equal((await f.undo(first.undo.token, f.canvas.id, 'other')).status, 404)
  assert.equal((await f.undo(first.undo.token, randomUUID())).status, 404)
  f.store.put('canvas', { ...f.current(), name: 'Renamed elsewhere', nodes: [...f.current().nodes.map(node => ({ ...node, x: 900 })), note('another')] })
  assert.equal((await f.undo(first.undo.token)).status, 200)
  assert.deepEqual(f.current().nodes.find(node => node.id === original.id), original)
  assert.equal(f.current().name, 'Renamed elsewhere'); assert.equal(f.current().nodes.find(node => node.id === 'terminal')!.x, 900)
  const revision = f.store.revision
  assert.equal((await f.undo(first.undo.token)).status, 200); assert.equal(f.store.revision, revision)
  const second = await f.remove(original.id)
  assert.notEqual(second.undo!.token, first.undo.token)
  await f.undo(first.undo.token)
  assert(!f.current().nodes.some(node => node.id === original.id), 'old successful undo cannot cancel a later removal')
  assert.equal((await f.undo(second.undo!.token)).status, 200)
  const missing = await f.remove('missing')
  assert.equal(missing.undo, null); assert.equal(missing.lastReference, false)
  assert.equal((await f.remove('terminal')).lastReference, false, 'removing a terminal reference does not delete its native window')
  assert.equal((await f.request('/api/canvases/overview/nodes/note', 'DELETE')).status, 403)
  assert.equal((await f.request(`/api/canvases/${f.canvas.id}/nodes/note`, 'DELETE', {}, 'missing')).status, 401)
})

test('multiple note removals keep the newest shared content even after the final reference is gone', async t => {
  const f = await fixture(t), peer = f.store.put<Canvas>('canvas', { id: randomUUID(), name: 'Peer', nodes: [note()] })
  const first = await f.remove('note')
  assert.equal(first.lastReference, false)
  f.store.updateNote(peer.id, 'note', { title: 'Latest', content: 'Peer edit', color: 'green' })
  const last = await f.remove('note', peer.id)
  assert.equal(last.lastReference, true, 'a pending Undo is not an active reference')
  assert.equal((await f.undo(first.undo!.token)).status, 200)
  const restored = f.current().nodes.find((node): node is NoteNode => node.type === 'note')!
  assert.equal(restored.content, 'Peer edit'); assert.equal(restored.title, 'Latest'); assert.equal(restored.color, 'green')
  assert.equal(restored.width, note().width)
  assert.equal((await f.undo(last.undo!.token, peer.id)).status, 200)
  assert.equal((f.store.get<Canvas>('canvas', peer.id)!.nodes[0] as NoteNode).content, 'Peer edit')
})

test('final file bytes stay pinned during undo and are collected after the independent deadlines', async t => {
  const f = await fixture(t), upload = await f.assets.begin({ filename: 'picture.bin', size: 4 })
  await upload.write(Buffer.from([0, 1, 2, 255]))
  const asset = await upload.complete({ canvasId: f.canvas.id, position: { x: 23.5, y: 90.25 } })
  const file = f.current().nodes.find(node => node.type === 'file')!, path = join(f.root, 'files', asset.id)
  const peer = f.store.put<Canvas>('canvas', { id: randomUUID(), name: 'Peer', nodes: [] })
  f.store.addNodeReference(f.canvas.id, file.id, peer.id, { x: 500, y: 600 })
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const a = await f.remove(file.id)
  assert.equal(a.lastReference, false)
  t.mock.timers.tick(1000)
  const b = await f.remove(file.id, peer.id)
  assert.equal(b.lastReference, true)
  await settle(); assert.deepEqual(await readFile(path), Buffer.from([0, 1, 2, 255]))
  t.mock.timers.tick(4000); await settle()
  assert.equal((await f.undo(a.undo!.token)).status, 404)
  assert(f.store.fileAsset(asset.id), 'another removal still owns a live grace period')
  assert.equal((await f.undo(b.undo!.token, peer.id)).status, 200)
  const restored = f.store.get<Canvas>('canvas', peer.id)!.nodes.find(node => node.id === file.id)!
  assert.equal(restored.x, 500); assert.equal(restored.y, 600)
  const c = await f.remove(file.id, peer.id)
  assert.equal(c.lastReference, true)
  t.mock.timers.tick(CARD_REMOVAL_UNDO_MS)
  assert.equal((await f.undo(c.undo!.token, peer.id)).status, 404)
  t.mock.timers.reset()
  await removed(path); assert.equal(f.store.fileAsset(asset.id), undefined)
})

test('deleted canvas, source, replaced endpoint, native close and revoked session cannot resurrect references', async t => {
  for (const mutation of ['canvas', 'source', 'endpoint', 'native-close', 'session', 'other-sessions'] as const) await t.test(mutation, async t => {
    const f = await fixture(t), result = await f.remove('terminal')
    if (mutation === 'canvas') { f.store.remove('canvas', f.canvas.id); f.store.put('canvas', { ...f.canvas, nodes: [] }) }
    if (mutation === 'source') { f.store.remove('source', f.source.id); f.store.put('source', f.source) }
    if (mutation === 'endpoint') f.store.put('source', { ...f.source, herdrSession: 'other' })
    if (mutation === 'native-close') f.store.removeWindowReferences(f.source, [f.terminal.type === 'terminal' ? f.terminal.windowId : ''])
    if (mutation === 'session') { f.store.removeSession('first'); f.store.addSession('first') }
    if (mutation === 'other-sessions') { f.store.removeOtherSessions('other'); f.store.addSession('first') }
    assert.equal((await f.undo(result.undo!.token)).status, 404)
    assert(!f.current().nodes.some(node => node.id === 'terminal'))
  })
})

test('failed removal/restore writes remain retryable without partial reference changes', async t => {
  const f = await fixture(t)
  f.store.db.exec(`CREATE TRIGGER refuse_remove BEFORE UPDATE ON documents WHEN OLD.kind='canvas' AND OLD.id='${f.canvas.id}' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
  assert.throws(() => f.store.removeCard(f.canvas.id, 'note', 'first'), /fixture failure/)
  assert(f.current().nodes.some(node => node.id === 'note'))
  f.store.db.exec('DROP TRIGGER refuse_remove')
  const result = await f.remove('note')
  f.store.db.exec(`CREATE TRIGGER refuse_restore BEFORE UPDATE ON documents WHEN OLD.kind='canvas' AND OLD.id='${f.canvas.id}' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
  assert.equal((await f.undo(result.undo!.token)).status, 400)
  assert(!f.current().nodes.some(node => node.id === 'note'))
  f.store.db.exec('DROP TRIGGER refuse_restore')
  assert.equal((await f.undo(result.undo!.token)).status, 200)
})

test('restart finalizes a pending last-file removal without persisting an undo journal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-remove-restart-')), path = join(root, 'canvas.db')
  let store = new Store(path), assets = new AssetStore(root, store)
  t.after(async () => { await assets.close(); store.close(); await rm(root, { recursive: true, force: true }) })
  store.addSession('fixture')
  const canvas = store.put<Canvas>('canvas', { id: randomUUID(), name: 'Files', nodes: [] })
  const upload = await assets.begin({ filename: 'file.txt', size: 3 }); await upload.write(Buffer.from('abc'))
  const file = await upload.complete({ canvasId: canvas.id, position: { x: 10, y: 20 } })
  const node = store.get<Canvas>('canvas', canvas.id)!.nodes[0]!
  const removal = store.removeCard(canvas.id, node.id, 'fixture')!
  assert(store.fileAssetReferenced(file.id))
  await assets.close(); store.close()
  store = new Store(path); assets = new AssetStore(root, store)
  assert.equal(store.restoreCard(canvas.id, removal.undo!.token, 'fixture'), undefined)
  const next = await assets.begin({ filename: 'next.txt', size: 0 }); await next.abort()
  assert.equal(store.fileAsset(file.id), undefined)
  await assert.rejects(readFile(join(root, 'files', file.id)))
  assert.deepEqual(store.get<Canvas>('canvas', canvas.id)!.nodes, [])
})

test('restoring a removed file cannot replace a different card that reused its node ID', async t => {
  const f = await fixture(t), upload = await f.assets.begin({ filename: 'file.txt', size: 3 }); await upload.write(Buffer.from('abc'))
  const asset = await upload.complete({ canvasId: f.canvas.id, position: { x: 0, y: 0 } })
  const file = f.current().nodes.find(node => node.type === 'file')!
  const removal = await f.remove(file.id)
  f.store.put('canvas', { ...f.current(), nodes: [...f.current().nodes, note(file.id)] })
  assert.equal((await f.undo(removal.undo!.token)).status, 404)
  assert.equal(f.current().nodes.find(node => node.id === file.id)!.type, 'note')
  f.store.removeSession('first')
  await removed(join(f.root, 'files', asset.id))
})
