import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AssetStore } from './assets.ts'
import { Store, type Canvas } from './state.ts'
import { createApp } from './app.ts'
import { receiveCanvasFile } from './canvas-files.ts'
import type { TerminalManager } from './terminals.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-file-drop-')), store = new Store(join(root, 'canvas.db'))
  const assets = new AssetStore(root, store)
  store.addSession('fixture')
  const canvas = store.put<Canvas>('canvas', { id: randomUUID(), name: 'Drop', nodes: [] })
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {} as TerminalManager, { assets })
  t.after(async () => { await assets.close(); store.close(); await rm(root, { recursive: true, force: true }) })
  const upload = (filename: string, bytes: Uint8Array, options: { id?: string; token?: string; size?: number; x?: string; contentType?: string } = {}) => {
    const params = new URLSearchParams({ filename, size: String(options.size ?? bytes.length), x: options.x ?? '-123.5', y: '87.25' })
    return app.request(`http://canvas.test/api/canvases/${options.id ?? canvas.id}/files?${params}`, {
      method: 'POST', headers: { Authorization: `Bearer ${options.token ?? 'fixture'}`, 'Content-Type': options.contentType ?? 'application/octet-stream' }, body: new Uint8Array(bytes),
    })
  }
  return { root, store, assets, canvas, app, upload }
}

test('authenticated raw file uploads stream past the JSON limit into persistent positioned cards', async t => {
  const f = await fixture(t), content = Buffer.alloc(2 * 1024 * 1024 + 7, 65)
  const response = await f.upload('记录.md', content)
  assert.equal(response.status, 201)
  const asset = await response.json()
  assert.equal(asset.filename, '记录.md'); assert.equal(asset.size, content.length); assert.equal(asset.preview, 'text')
  const card = f.store.get<Canvas>('canvas', f.canvas.id)!.nodes[0]!
  assert.equal(card.type, 'file'); assert.equal(card.x, -123.5); assert.equal(card.y, 87.25)
  const served = await f.app.request(`http://canvas.test/api/files/${asset.id}`, { headers: { Authorization: 'Bearer fixture' } })
  assert.equal(served.status, 200); await served.body?.cancel()
  const stored = await f.assets.read(asset.id), chunks = []
  for await (const bytes of stored!.body) chunks.push(bytes)
  assert.deepEqual(Buffer.concat(chunks), content)
  const second = await f.upload('记录.md', Buffer.alloc(0))
  assert.equal(second.status, 201); assert.notEqual((await second.json()).id, asset.id)
})

test('file cards reject unauthenticated, overview, missing and invalid destinations without retaining bytes', async t => {
  const f = await fixture(t), bytes = Buffer.from('file')
  assert.equal((await f.upload('test.txt', bytes, { token: 'other' })).status, 401)
  assert.equal((await f.upload('test.txt', bytes, { id: 'overview' })).status, 403)
  assert.equal((await f.upload('test.txt', bytes, { id: randomUUID() })).status, 404)
  assert.equal((await f.upload('test.txt', bytes, { x: 'Infinity' })).status, 400)
  assert.equal((await f.upload('../test.txt', bytes)).status, 400)
  assert.equal((await f.upload('test.txt', bytes, { contentType: 'text/plain' })).status, 415)
  assert.equal((await f.upload('short.txt', bytes, { size: bytes.length + 1 })).status, 400)
  assert.equal((await f.upload('long.txt', bytes, { size: bytes.length - 1 })).status, 400)
  assert.equal(f.store.get<Canvas>('canvas', f.canvas.id)!.nodes.length, 0)
  assert.deepEqual(await readdir(join(f.root, 'files')), [])
  assert.deepEqual((await readdir(join(f.root, 'tmp'))).filter(name => name.endsWith('.part')), [])
})

test('request cancellation, logout and canvas removal cancel blocked uploads without partial cards', async t => {
  for (const reason of ['request', 'logout', 'canvas'] as const) await t.test(reason, async t => {
    const f = await fixture(t), controller = new AbortController()
    let reading!: () => void, cancelled = false
    const ready = new Promise<void>(resolve => { reading = resolve })
    const stream = new ReadableStream<Uint8Array>({ pull() { reading() }, cancel() { cancelled = true } })
    const request = new Request('http://canvas.test/file', { method: 'POST', body: stream, signal: controller.signal, duplex: 'half' } as RequestInit)
    const pending = receiveCanvasFile(f.store, f.assets, f.canvas.id, { filename: 'partial.txt', size: 10, x: 0, y: 0 }, request, 'fixture')
    await ready
    if (reason === 'request') controller.abort()
    else if (reason === 'logout') f.store.removeSession('fixture')
    else f.store.remove('canvas', f.canvas.id)
    await assert.rejects(pending)
    assert(cancelled)
    assert.deepEqual(f.store.fileAssetIds(), [])
    assert.deepEqual(await readdir(join(f.root, 'files')).catch(() => []), [])
  })
})
