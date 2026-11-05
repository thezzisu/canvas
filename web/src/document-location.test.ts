import assert from 'node:assert/strict'
import test from 'node:test'
import { documentLocation } from './document-location.ts'
const base = `https://canvas.test/prefix/api/document/${'x'.repeat(43)}/`
test('document location preserves its mounted capture root and rejects out-of-root navigation', () => {
  const value = documentLocation(base + '?path=' + encodeURIComponent('/docs/a %23 中文.md'))
  assert(value)
  assert.equal(value.filename, 'a # 中文.md')
  assert.equal(value.raw.searchParams.get('canvas'), 'raw')
  assert.equal(value.download.searchParams.get('canvas'), 'download')
  for (const path of ['../../state', 'https://outside.invalid/a.md', '/%ZZ', '//outside/a.md'])
    assert.equal(documentLocation(base + '?path=' + encodeURIComponent(path)), undefined, path)
})
