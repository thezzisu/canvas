import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pwaOptions, shellNavigation } from './pwa.config.ts'

test('PWA caches only the static shell and icons, with no API fallback or runtime cache', () => {
  assert.deepEqual(pwaOptions.workbox?.globPatterns, ['index.html', 'assets/*.{js,css}', 'icons/*.{png,svg}'])
  assert.deepEqual(pwaOptions.workbox?.runtimeCaching, [])
  assert.deepEqual(pwaOptions.workbox?.globIgnores, ['**/fonts/**'])
  assert.equal(pwaOptions.registerType, 'prompt')
  assert.equal(pwaOptions.workbox?.skipWaiting, false)
  assert.equal(pwaOptions.workbox?.clientsClaim, false)
  assert(shellNavigation.test('/')); assert(shellNavigation.test('/?server=https%3A%2F%2Fbackend.example'))
  assert(shellNavigation.test('/index.html'))
  for (const path of ['/api/session', '/api/login', '/api/state', '/api/files/id', '/api/media/id', '/api/downloads/id',
    '/api/forward/id/', '/api/terminal', '/prefix/api/events', '/fonts/maple/regular.woff2', '/private-document'])
    assert.equal(shellNavigation.test(path), false)
})

test('install manifest uses neutral start URL and real 192, 512, maskable and Apple PNG assets', async () => {
  const manifest = pwaOptions.manifest
  assert(manifest)
  assert.equal(manifest.name, 'Canvas'); assert.equal(manifest.start_url, './')
  assert.equal(manifest.scope, './'); assert.equal(manifest.display, 'standalone')
  for (const icon of [...manifest.icons!, { src: 'icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }]) {
    const bytes = await readFile(new URL(`./web/public/${icon.src}`, import.meta.url))
    const [width, height] = icon.sizes!.split('x').map(Number)
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    assert.equal(bytes.readUInt32BE(16), width); assert.equal(bytes.readUInt32BE(20), height)
  }
  assert(manifest.icons!.some(icon => icon.purpose === 'maskable'))
})
