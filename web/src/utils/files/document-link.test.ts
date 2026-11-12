import assert from 'node:assert/strict'
import test from 'node:test'
import { documentLinkNeedsTrust } from './document-link.ts'
const base = `https://canvas.test/prefix/api/document/${'x'.repeat(43)}/`
const source = base.replace('/api/document/', '/api/capture/')
test('document navigation requires trust for directories, encoded HTML and unknown executable responses', () => {
  for (const path of [
    'site/',
    'app',
    'page.html',
    'page%2Ehtml',
    'page%2EHTML',
    'document.svg',
    'page.xhtml',
  ])
    assert.equal(documentLinkNeedsTrust(source + path, base), true, path)
  for (const path of ['readme.md', 'readme%2Emd', 'image.png', 'report.pdf'])
    assert.equal(documentLinkNeedsTrust(source + path, base), false, path)
  assert.equal(documentLinkNeedsTrust('#heading', base), false)
})
