import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { serveCanvasStatic } from './static.ts'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-static-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'assets'))
  await Promise.all([
    writeFile(join(directory, 'index.html'), '<!doctype html><title>Canvas</title>'),
    writeFile(join(directory, 'sw.js'), '/* service worker */'),
    writeFile(join(directory, 'build-info.json'), '{"version":"fixture"}'),
    writeFile(join(directory, 'assets/maple-regular-A1b2C3d4.woff2'), Buffer.from([0, 1, 2, 255])),
    writeFile(join(directory, 'assets/index-A1b2C3d4.js'), 'export {}'),
    writeFile(join(directory, 'assets/unversioned.js'), 'export {}'),
  ])
  const app = new Hono()
  app.use('*', serveCanvasStatic(directory))
  app.get('/api/fixture', c => { c.header('Cache-Control', 'private, no-store'); return c.json({ ok: true }) })
  return app
}

test('hashed fonts and scripts are immutable; documents and unversioned files revalidate', async t => {
  const app = await fixture(t)
  for (const path of ['/assets/maple-regular-A1b2C3d4.woff2', '/assets/index-A1b2C3d4.js']) {
    const response = await app.request(path)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    await response.arrayBuffer()
  }
  const font = await app.request('/assets/maple-regular-A1b2C3d4.woff2')
  assert.equal(font.headers.get('content-type'), 'font/woff2')
  assert.deepEqual(Buffer.from(await font.arrayBuffer()), Buffer.from([0, 1, 2, 255]))
  for (const path of ['/', '/index.html', '/sw.js', '/build-info.json', '/assets/unversioned.js']) {
    const response = await app.request(path)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate')
    await response.arrayBuffer()
  }
})

test('GET and HEAD conditional requests avoid sending unchanged bytes and respect validator precedence', async t => {
  const app = await fixture(t)
  const path = '/assets/maple-regular-A1b2C3d4.woff2'
  const original = await app.request(path)
  const etag = original.headers.get('etag')!
  const modified = original.headers.get('last-modified')!
  await original.arrayBuffer()
  for (const method of ['GET', 'HEAD']) {
    for (const headers of [
      { 'If-None-Match': etag }, { 'If-None-Match': etag.slice(2) },
      { 'If-None-Match': `"another", ${etag}` }, { 'If-None-Match': '*' },
      { 'If-Modified-Since': modified },
    ] as Record<string, string>[]) {
      const response = await app.request(path, { method, headers })
      assert.equal(response.status, 304)
      assert.equal(response.headers.get('etag'), etag)
      assert.equal(response.headers.get('content-length'), null)
      assert.equal((await response.arrayBuffer()).byteLength, 0)
    }
  }
  for (const headers of [
    { 'If-None-Match': '"different"', 'If-Modified-Since': modified },
    { 'If-Modified-Since': 'invalid' }, { 'If-Modified-Since': new Date(0).toUTCString() },
  ] as Record<string, string>[]) {
    const response = await app.request(path, { headers })
    assert.equal(response.status, 200)
    assert.equal((await response.arrayBuffer()).byteLength, 4)
  }
  const head = await app.request(path, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), '4')
  assert.equal((await head.arrayBuffer()).byteLength, 0)
})

test('missing static assets never become HTML and API cache policy is untouched', async t => {
  const app = await fixture(t)
  for (const path of ['/assets/missing-A1b2C3d4.js', '/fonts/missing.woff2', '/missing', '/assets/', '/assets/%00.woff2', '/assets/%2e%2e%2findex.html']) {
    const response = await app.request(path)
    assert.equal(response.status, 404, path)
    assert.equal(response.headers.get('etag'), null)
    assert.equal(response.headers.get('cache-control'), null)
  }
  const api = await app.request('/api/fixture')
  assert.equal(api.status, 200)
  assert.equal(api.headers.get('cache-control'), 'private, no-store')
  assert.equal(api.headers.get('etag'), null)
  assert.deepEqual(await api.json(), { ok: true })
})
