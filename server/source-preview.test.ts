import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { getRequestListener } from '@hono/node-server'
import { AssetStore } from './assets.ts'
import { createApp } from './app.ts'
import { CaptureService } from './capture.ts'
import { OpenDownloadService } from './open-download.ts'
import { SourcePreviewService } from './source-preview.ts'
import { Store, sourceConnectionKey, type Canvas, type FileOrigin, type Source } from './state.ts'
import type { TerminalManager } from './terminals.ts'

async function fixture(t: TestContext, idleTtlMs?: number) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-source-preview-'))
  const store = new Store(join(root, 'canvas.db')), assets = new AssetStore(root, store)
  store.addSession('owner'); store.addSession('other')
  const source: Source = { id: randomUUID(), name: 'Preview fixture', transport: 'local' }
  store.put('source', source)
  const captures = new CaptureService(store)
  const previews = new SourcePreviewService(store, captures, await readFile(new URL('../cli/canvas', import.meta.url), 'utf8'), idleTtlMs)
  const downloads = new OpenDownloadService({ createUpload: metadata => assets.begin(metadata),
    readTemporary: (id, range) => assets.readTemporary(id, range),
    prepare: async () => { throw new Error('Not used by file previews') },
    resources: async () => { throw new Error('Not used by file previews') }, recipient: async () => undefined })
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {
    onNotification: () => ({ dispose() {} }),
  } as unknown as TerminalManager, { assets, previewFile: (id, temporary, session, base) => {
    const assetId = temporary ? downloads.stagedAssetId(id, session) : id
    return previews.open(assetId ? assets.origin(assetId, temporary) : undefined, session, base)
  } })
  const listener = getRequestListener(app.fetch)
  const server = createServer((req, res) => { if (!captures.handle(req, res)) void listener(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const site = join(root, 'site'); await mkdir(site)
  const file = join(site, '演示 (one).html')
  await writeFile(file, '<link rel="stylesheet" href="style.css"><h1>Original preview</h1>')
  await writeFile(join(site, 'style.css'), 'body { color: green }')
  await writeFile(join(root, 'outside.txt'), 'outside')
  await symlink(join(root, 'outside.txt'), join(site, 'escape.txt'))
  const canvas = store.put<Canvas>('canvas', { id: randomUUID(), name: 'Fixture', nodes: [] })
  const origin: FileOrigin = { sourceId: source.id, sourceKey: sourceConnectionKey(source), path: file }
  async function asset(temporary = false, includeOrigin = true) {
    const upload = await assets.begin({ filename: '演示 (one).html', size: 4 })
    await upload.write(Buffer.from('copy'))
    const asset = await upload.complete({ canvasId: temporary ? 'overview' : canvas.id, position: { x: 0, y: 0 },
      ...(includeOrigin ? { origin } : {}) })
    const id = temporary ? downloads.registerStaged(asset.id, 'owner') : asset.id
    return { asset, id, endpoint: `/api/${temporary ? 'downloads' : 'files'}/${id}/preview` }
  }
  const request = (endpoint: string, body: unknown = { apiBase: base }, session = 'owner', extraHeaders = {}) => fetch(base + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}`, ...extraHeaders }, body: JSON.stringify(body),
  })
  t.after(async () => {
    await previews.close(); await captures.close(); await downloads.closeAll(); await assets.close()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    store.close(); await rm(root, { recursive: true, force: true })
  })
  return { root, site, file, store, source, captures, previews, assets, origin, canvas, base, asset, request }
}

test('HTML source preview serves the original directory through capture and reuses one owned process', async t => {
  const f = await fixture(t), opened = await f.asset()
  assert.equal(opened.asset.sourcePreview, true)
  assert.deepEqual(f.assets.origin(opened.id), f.origin)
  assert(!JSON.stringify(f.store.canvasView(f.canvas)).includes(f.file), 'source paths never enter public canvas metadata')
  const [first, second] = await Promise.all([f.request(opened.endpoint), f.request(opened.endpoint)])
  assert.equal(first.status, 200); assert.equal(second.status, 200)
  const preview = await first.json() as { id: string; url: string }
  assert.deepEqual(await second.json(), preview)
  const page = await fetch(preview.url)
  assert.match(await page.text(), /Original preview/u, 'uses the original file, not the uploaded copy')
  assert.equal(await (await fetch(new URL('style.css', preview.url))).text(), 'body { color: green }')
  assert.equal((await fetch(new URL('escape.txt', preview.url))).status, 404, 'symlinks cannot expose files outside the preview root')
  assert.equal(f.captures.stop(preview.id, 'other'), false)
  assert.equal(f.captures.stop(preview.id, 'owner'), true)
  assert.equal((await fetch(preview.url)).status, 404)
  const homeRelative = await f.previews.open({ ...f.origin, path: '~/' + relative(homedir(), f.file) }, 'owner', f.base)
  assert.match(await (await fetch(homeRelative.url)).text(), /Original preview/u, 'scanner home paths resolve on the source machine')
})

test('preview requires server-side provenance, source identity and an authenticated ticket owner', async t => {
  const f = await fixture(t), missing = await f.asset(false, false), temporary = await f.asset(true)
  assert.equal((await f.request(missing.endpoint)).status, 404)
  assert.equal((await f.request(temporary.endpoint, undefined, 'other')).status, 404)
  assert.equal((await f.request(temporary.endpoint, undefined, 'missing')).status, 401)
  assert.equal((await f.request(temporary.endpoint, { apiBase: f.base, path: f.file })).status, 400)
  assert.equal((await f.request(temporary.endpoint, { apiBase: `${f.base}/different/` })).status, 400)
  const started = await f.request(temporary.endpoint); assert.equal(started.status, 200)
  const preview = await started.json() as { url: string }
  f.store.put('source', { ...f.source, herdrSession: 'changed' })
  assert.equal((await fetch(preview.url)).status, 404)
  assert.equal((await f.request(temporary.endpoint)).status, 404)
})

test('preview detects removed originals, expires on sign-out, and removes durable provenance with the final file reference', async t => {
  const f = await fixture(t), opened = await f.asset()
  const started = await f.request(opened.endpoint); assert.equal(started.status, 200)
  const preview = await started.json() as { url: string }
  f.store.removeSession('owner')
  assert.equal((await fetch(preview.url)).status, 404)
  f.store.addSession('owner'); await rm(f.file)
  assert.equal((await f.request(opened.endpoint)).status, 502)
  f.store.put('canvas', { ...f.canvas, nodes: [] })
  f.store.removeFileAssetIfUnreferenced(opened.id)
  assert.equal(f.store.get('file-origin', opened.id), undefined)
})

test('only browser previews expire after idle time, and successful access extends their lifetime', async t => {
  const f = await fixture(t, 1000)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const now = Date.now(), preview = await f.previews.open(f.origin, 'owner', f.base)
  const ordinary = f.captures.prepareCapture(f.source, { publicBase: f.base, session: 'owner', port: 12345, windowId: 'window', paneId: 'pane' })
  await ordinary.ready()
  t.mock.timers.setTime(now + 800)
  assert.equal((await fetch(preview.url)).status, 200)
  t.mock.timers.setTime(now + 1200); f.store.emit('change')
  assert.equal((await fetch(preview.url)).status, 200, 'access renewed the idle lease')
  t.mock.timers.setTime(now + 2300); f.store.emit('change')
  assert.equal((await fetch(preview.url)).status, 404)
  await ordinary.ready()
})
