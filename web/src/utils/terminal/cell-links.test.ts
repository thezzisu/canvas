import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLinks } from './cell-links.ts'

const found = (text: string) => detectLinks(text).map((link) => text.slice(link.start, link.end))

test('web addresses in a row are links', () => {
  const text = 'see https://example.com/a?b=1#c and http://localhost:5173/ now'
  assert.deepEqual(detectLinks(text), [
    { start: 4, end: 31, uri: 'https://example.com/a?b=1#c' },
    { start: 36, end: 58, uri: 'http://localhost:5173/' },
  ])
  assert.deepEqual(found('HTTPS://EXAMPLE.COM/x'), ['HTTPS://EXAMPLE.COM/x'])
})

test('punctuation and brackets around an address are prose', () => {
  assert.deepEqual(found('at https://example.com/t, ok'), ['https://example.com/t'])
  assert.deepEqual(found('(see https://example.com/a).'), ['https://example.com/a'])
  assert.deepEqual(found('https://en.wikipedia.org/wiki/Rust_(language))'), [
    'https://en.wikipedia.org/wiki/Rust_(language)',
  ])
  assert.deepEqual(found('[docs](https://example.com/d)!'), ['https://example.com/d'])
  assert.deepEqual(found('网址：https://example.com/页。'), ['https://example.com/页'])
  assert.deepEqual(found('"https://example.com/q" <https://example.com/r>'), [
    'https://example.com/q',
    'https://example.com/r',
  ])
})

test('an address stops at a pane border', () => {
  assert.deepEqual(found('https://example.com/a│https://example.com/b'), [
    'https://example.com/a',
    'https://example.com/b',
  ])
})

test('what the link rules refuse is not a link', () => {
  assert.deepEqual(
    found(`https://${['user', 'pw'].join(':')}@example.com/ http:// ftp://example.com file:///etc`),
    [],
  )
  assert.deepEqual(found('no links here: example.com'), [])
})
