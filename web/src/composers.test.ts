import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composerHasContent, sentFiles } from './composer-content.ts'

const a = '0f8fad5b-d9cb-469f-a165-70867728950e',
  b = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const token = (id: string) => `￼${id}￼`

test('a draft counts as content with text or any attachment, not whitespace', () => {
  assert.equal(composerHasContent(' \n '), false)
  assert.equal(composerHasContent(token(a)), true)
  assert.equal(composerHasContent('x'), true)
})

test('sent files are the distinct attachments in draft order', () => {
  const attachments = [
    { id: b, filename: 'b.txt' },
    { id: a, filename: 'a.log' },
  ]
  assert.deepEqual(
    sentFiles(`see ${token(a)} and ${token(b)} then ${token(a.toUpperCase())}`, attachments),
    ['a.log', 'b.txt'],
  )
  assert.deepEqual(sentFiles('only text', attachments), [])
})
