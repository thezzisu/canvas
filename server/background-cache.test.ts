import test from 'node:test'
import assert from 'node:assert/strict'
import { BackgroundCache } from '../web/src/background-cache.ts'

function fixture(load: (path: string, signal: AbortSignal) => Promise<Blob>) {
  const created: Blob[] = [], revoked: string[] = []
  const cache = new BackgroundCache(load, { createObjectURL: blob => { created.push(blob as Blob); return `blob:fixture-${created.length}` }, revokeObjectURL: url => revoked.push(url) })
  return { cache, created, revoked }
}
test('backgrounds share pending loads and reuse the original bytes across canvas switches', async () => {
  const bytes = new Blob(['original image bytes'], { type: 'image/png' }), calls: string[] = []
  const { cache, created } = fixture(async path => { calls.push(path); return bytes })
  const pending = cache.get('/api/backgrounds/a')
  assert.equal(cache.get('/api/backgrounds/a'), pending)
  assert.equal(await pending, 'blob:fixture-1')
  await cache.get('/api/backgrounds/b')
  assert.equal(await cache.get('/api/backgrounds/a'), 'blob:fixture-1')
  assert.equal(cache.peek('/api/backgrounds/a'), 'blob:fixture-1')
  assert.deepEqual(calls, ['/api/backgrounds/a', '/api/backgrounds/b'])
  assert.equal(created[0], bytes)
})
test('replaced or deleted backgrounds release their object URLs without evicting other canvases', async () => {
  const { cache, revoked } = fixture(async () => new Blob(['image']))
  await cache.get('/api/backgrounds/a'); await cache.get('/api/backgrounds/b')
  cache.retain(['/api/backgrounds/b', '/api/backgrounds/new-a'])
  assert.deepEqual(revoked, ['blob:fixture-1'])
  assert.equal(cache.peek('/api/backgrounds/a'), undefined)
  assert.equal(await cache.get('/api/backgrounds/b'), 'blob:fixture-2')
  assert.equal(await cache.get('/api/backgrounds/new-a'), 'blob:fixture-3')
  cache.clear()
  assert.deepEqual(revoked, ['blob:fixture-1', 'blob:fixture-2', 'blob:fixture-3'])
})
test('an old session load cannot install a URL after invalidation, even if its loader ignores abort', async () => {
  let complete!: (blob: Blob) => void, oldSignal!: AbortSignal
  const { cache, created } = fixture((_path, signal) => { oldSignal = signal; return new Promise(resolve => { complete = resolve }) })
  const stale = cache.get('/api/backgrounds/a')
  await Promise.resolve()
  cache.clear(); assert.equal(oldSignal.aborted, true)
  complete(new Blob(['old session']))
  await assert.rejects(stale, { name: 'AbortError' })
  assert.deepEqual(created, [])
  assert.equal(cache.peek('/api/backgrounds/a'), undefined)
})
test('a failed background can be retried without leaving a rejected cache entry', async () => {
  let calls = 0
  const { cache } = fixture(async () => { if (++calls === 1) throw new Error('Disconnected'); return new Blob(['image']) })
  await assert.rejects(cache.get('/api/backgrounds/a'), /Disconnected/)
  assert.equal(await cache.get('/api/backgrounds/a'), 'blob:fixture-1')
  assert.equal(calls, 2)
})
