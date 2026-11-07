import assert from 'node:assert/strict'
import test from 'node:test'
import { captureUrl } from './capture-url'

test('capture paths resolve under each viewer API base and retain application bootstrap query/hash', () => {
  const path = '/login?ticket=fixture#return'
  assert.equal(captureUrl(new URL('http://127.0.0.1:3010/api/capture/id/'), path)?.href,
    'http://127.0.0.1:3010/api/capture/id/login?ticket=fixture#return')
  assert.equal(captureUrl(new URL('https://example.test/instance/api/capture/id/'), path)?.href,
    'https://example.test/instance/api/capture/id/login?ticket=fixture#return')
  assert.equal(captureUrl(new URL('https://example.test/api/capture/id/'), '/file%20name.html')?.pathname,
    '/api/capture/id/file%20name.html')
})

test('a descriptor cannot escape its capture lease or supply a different origin', () => {
  const base = new URL('https://example.test/instance/api/capture/id/')
  for (const path of ['', 'relative', 'https://other.test/', '//other.test/', '/../other/', '/%2e%2e/other', '/\\other', '/page\n'])
    assert.equal(captureUrl(base, path), undefined, path)
})
