import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AssetStore } from './assets.ts'
import { Store, type Canvas, type NoteNode, type Source } from './state.ts'
import { createApp } from './app.ts'
import { UploadService } from './uploads.ts'
import { sendComposer } from './composer-send.ts'
import type { TerminalManager } from './terminals.ts'
import type { SourceResource } from './runtimes.ts'
import type { PasteSegment } from '../shared/paste.ts'

class FakeSocket { readyState = 1; messages: Record<string, any>[] = []; send(value: string) { this.messages.push(JSON.parse(value)) } }

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-composer-')), store = new Store(join(root, 'canvas.db'))
  const assets = new AssetStore(root, store)
  store.addSession('fixture')
  const source = store.put<Source>('source', { id: randomUUID(), name: 'Fixture', transport: 'local' })
  const target = { sourceId: source.id, windowId: 'window-a' }
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {} as TerminalManager, { assets })
  const pasted: string[][] = [], written = new Map<string, Buffer>()
  const terminals = { captureFilePaste: async () => async (segments: readonly PasteSegment[]) => { pasted.push(segments.map(segment => segment.text)) } } as unknown as TerminalManager
  const uploads = new UploadService(terminals, {
    write: async (_source, file, bytes) => {
      const chunks: Buffer[] = []
      for await (const chunk of bytes) chunks.push(Buffer.from(chunk))
      const path = `/inbox/${written.size}_${file.name}`
      written.set(path, Buffer.concat(chunks)); return path
    },
    remove: async () => {},
    resources: async () => ({ ...source, status: 'online', spaces: [{ id: 'space', name: 'Space', windows: [{ id: 'window-a', name: 'a', panes: [], status: 'unknown' }] }] }) as unknown as SourceResource,
  })
  t.after(async () => { await uploads.closeAll(); await assets.close(); store.close(); await rm(root, { recursive: true, force: true }) })
  const request = (path: string, init: RequestInit = {}) => app.request(`http://canvas.test/api/sources/${source.id}/windows/window-a/composer${path}`,
    { ...init, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json', ...init.headers } })
  const upload = async (name = 'log.txt', body = 'abc') => {
    const response = await request(`/files?filename=${name}&size=${Buffer.byteLength(body)}`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } })
    assert.equal(response.status, 201)
    return await response.json() as { id: string }
  }
  const edit = async (content: string) => (await request('', { method: 'PATCH', body: JSON.stringify({ content }) })).json()
  const send = async (id = 'send') => {
    const socket = new FakeSocket(), composer = store.composer(target)!
    await sendComposer(store, assets, uploads, source, 'window-a', socket as never, 'fixture', { id, composer: composer.id, version: composer.version })
    return socket.messages
  }
  return { root, store, assets, source, target, app, pasted, written, upload, edit, send, request }
}
const token = (id: string) => `￼${id}￼`

test('a composer is a window-owned note shared through state and released when empty', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.store.snapshot().composers, {})
  const view = await f.edit('hello')
  assert.equal(view.content, 'hello'); assert.equal(view.version, 1)
  assert.equal(f.store.snapshot().composers[`${f.source.id}/window-a`]?.content, 'hello')
  assert.equal((await f.edit('hello')).version, 1, 'an unchanged draft is not a new version')
  await f.edit('')
  assert.deepEqual(f.store.snapshot().composers, {}, 'an empty draft without files is removed')
  assert.equal((await f.app.request(`http://canvas.test/api/sources/${randomUUID()}/windows/w/composer`, { method: 'PATCH', body: JSON.stringify({ content: 'x' }),
    headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' } })).status, 404)
})

test('composer attachments survive garbage collection, link into notes without copies and close with the window', async t => {
  const f = await fixture(t), asset = await f.upload()
  await f.edit(`see ${token(asset.id)}`)
  assert(f.store.fileAssetReferenced(asset.id), 'a composer owns its attachment without any canvas')
  await f.edit('cut away')
  assert(f.store.fileAssetReferenced(asset.id), 'a cut attachment stays available for pasting')
  const note: NoteNode = { id: randomUUID(), type: 'note', title: '', content: '', color: 'yellow', x: 0, y: 0, width: 320, height: 240 }
  const canvas = f.store.put<Canvas>('canvas', { id: randomUUID(), name: 'A', nodes: [note] })
  assert.deepEqual(f.store.referenceNoteFiles(canvas.id, note.id, [asset.id])?.map(item => item.id), [asset.id])
  assert.equal(f.store.fileAssetIds().length, 1, 'pasting into a note links the same bytes')
  const linked = await (await f.request('/file-references', { method: 'POST', body: JSON.stringify({ assetIds: [asset.id] }) })).json()
  assert.equal(linked[0].id, asset.id)
  f.store.removeWindowReferences(f.source, ['window-a'])
  assert.equal(f.store.composer(f.target), undefined)
  assert(f.store.fileAssetReferenced(asset.id), 'the note keeps its own reference')
  f.store.remove('canvas', canvas.id)
  assert(!f.store.fileAssetReferenced(asset.id))
})

test('sending delivers the seen version once from stored bytes, then clears it and releases sent files', async t => {
  const f = await fixture(t), log = await f.upload('error.log', 'boom'), kept = await f.upload('kept.txt', 'k')
  await f.edit(`check ${token(log.id)} and ${token(log.id)}\nnow`)
  const messages = await f.send()
  assert.equal(messages.at(-1)?.state, 'completed')
  assert.deepEqual(f.pasted, [['check ', "'/inbox/0_error.log'", ' and ', "'/inbox/0_error.log'", '\nnow']])
  assert.deepEqual([...f.written.values()].map(String), ['boom'])
  const after = f.store.composer(f.target)!
  assert.equal(after.content, ''); assert.equal(f.store.composerView(after).attachments.map(item => item.id).join(), kept.id,
    'only delivered files are released; an unsent cut file stays linked')
  assert(!f.store.fileAssetReferenced(log.id))
})

test('a draft changed on another device or emptied is never sent', async t => {
  const f = await fixture(t)
  await f.edit('first')
  const composer = f.store.composer(f.target)!
  await f.edit('second')
  const socket = new FakeSocket()
  await sendComposer(f.store, f.assets, new UploadService({} as TerminalManager), f.source, 'window-a', socket as never, 'fixture', { id: 'stale', composer: composer.id, version: composer.version })
  assert.equal(socket.messages.at(-1)?.state, 'failed'); assert.deepEqual(f.pasted, [])
  assert.equal(f.store.composer(f.target)?.content, 'second')
  await f.edit('  ')
  assert.equal((await f.send('blank')).at(-1)?.error, '草稿为空')
})

test('attachment-only drafts paste as separate paths like a native drop', async t => {
  const f = await fixture(t), a = await f.upload('a.txt', 'a'), b = await f.upload('b.txt', 'b')
  await f.edit(`${token(a.id)}\n${token(b.id)}`)
  assert.equal((await f.send()).at(-1)?.state, 'completed')
  assert.deepEqual(f.pasted, [["'/inbox/0_a.txt'", ' ', "'/inbox/1_b.txt'"]])
  assert.deepEqual(f.store.snapshot().composers, {})
})

test('a closed window rejects late draft writes and uploads, and source removal releases composer files', async t => {
  const f = await fixture(t), asset = await f.upload()
  await f.edit(`x ${token(asset.id)}`)
  f.store.removeWindowReferences(f.source, ['window-a'])
  assert.equal((await f.request('', { method: 'PATCH', body: JSON.stringify({ content: 'late' }) })).status, 404)
  assert.equal((await f.request('/files?filename=late.txt&size=1', { method: 'POST', body: 'x', headers: { 'Content-Type': 'application/octet-stream' } })).status, 404)
  assert.deepEqual(f.store.snapshot().composers, {})
  assert(!f.store.fileAssetReferenced(asset.id))
  const other = { sourceId: f.source.id, windowId: 'window-b' }, kept = f.store.updateComposer(other, 'draft')
  assert(kept.id)
  f.store.remove('source', f.source.id)
  assert.equal(f.store.composer(other), undefined)
})

test('a draft edited during delivery is pasted once but not cleared, and missing bytes stop before pasting', async t => {
  const f = await fixture(t), asset = await f.upload('a.txt', 'a')
  await f.edit(`send ${token(asset.id)}`)
  const composer = f.store.composer(f.target)!, socket = new FakeSocket()
  const uploads = new UploadService({ captureFilePaste: async () => async (segments: readonly PasteSegment[]) => {
    f.store.updateComposer(f.target, 'typed during delivery'); f.pasted.push(segments.map(segment => segment.text))
  } } as unknown as TerminalManager, { write: async () => '/inbox/a.txt', remove: async () => {},
    resources: async () => ({ ...f.source, status: 'online', spaces: [{ id: 's', name: 's', windows: [{ id: 'window-a', name: 'a', panes: [], status: 'unknown' }] }] }) as unknown as SourceResource })
  t.after(() => uploads.closeAll())
  await sendComposer(f.store, f.assets, uploads, f.source, 'window-a', socket as never, 'fixture', { id: 'race', composer: composer.id, version: composer.version })
  assert.equal(socket.messages.at(-1)?.state, 'completed'); assert.equal(f.pasted.length, 1)
  assert.equal(f.store.composer(f.target)?.content, 'typed during delivery')
  assert(f.store.fileAssetReferenced(asset.id), 'files stay with the newer draft')
  const missing = await f.upload('gone.txt', 'g')
  await f.edit(token(missing.id))
  await rm(join(f.root, 'files', missing.id))
  const failed = await f.send('missing')
  assert.equal(failed.at(-1)?.state, 'failed'); assert.equal(f.pasted.length, 1, 'nothing is pasted without every file')
})
