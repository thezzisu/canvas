import test from 'node:test'
import assert from 'node:assert/strict'
import { cachedCodePreview, cachedFont, shellNavigation } from './pwa-routes.ts'

const route = (path: string, destination: RequestDestination, origin = 'https://canvas.test') => ({
  request: { destination },
  url: new URL(path, origin),
  sameOrigin: origin === 'https://canvas.test',
})

test('API, private-document and capture URLs never get the shell fallback or a runtime cache entry', () => {
  for (const path of ['/', '/?server=https%3A%2F%2Fbackend.example', '/index.html'])
    assert(shellNavigation.test(path), path)
  for (const path of [
    '/api/session',
    '/api/state',
    '/api/files/id',
    '/api/media/id',
    '/api/downloads/id',
    '/api/forward/id/',
    '/api/terminal',
    '/prefix/api/events',
    '/fonts/maple/regular.woff2',
    '/private-document',
  ])
    assert(!shellNavigation.test(path), path)
  assert(cachedFont(route('/assets/regular-A1b2C3d4.woff2', 'font')))
  for (const destination of ['script', 'worker'] as const)
    assert(cachedCodePreview(route('/assets/code-preview/html-A1b2C3d4.js', destination)))
  for (const path of [
    '/api/files/font.woff2',
    '/api/forward/id/assets/font-A1b2C3d4.woff2',
    '/assets/regular.woff2',
  ])
    assert(!cachedFont(route(path, 'font')), path)
  for (const path of [
    '/api/capture/id/assets/code-preview/html-A1b2C3d4.js',
    '/assets/html-A1b2C3d4.js',
    '/assets/code-preview/html.js',
  ])
    assert(!cachedCodePreview(route(path, 'script')), path)
  assert(!cachedFont(route('/assets/regular-A1b2C3d4.woff2', 'font', 'https://other.test')))
  assert(
    !cachedCodePreview(
      route('/assets/code-preview/html-A1b2C3d4.js', 'script', 'https://other.test'),
    ),
  )
})
