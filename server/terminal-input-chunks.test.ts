import test from 'node:test'
import assert from 'node:assert/strict'
import { terminalInputChunks } from '../web/src/terminal-input-chunks.ts'

test('long Unicode paste preserves every scalar and its one bracketed-paste pair', () => {
  const body = '中文😀\0\t\n\r"\\'.repeat(20_000)
  assert.equal(body.length, 200_000)
  const input = `\x1b[200~${body}\x1b[201~`, chunks = [...terminalInputChunks(input)]
  assert(chunks.length > 1)
  assert.equal(chunks.join(''), input)
  assert.deepEqual(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), Buffer.from(input))
  assert.equal(chunks.join('').match(/\x1b\[200~/gu)?.length, 1)
  assert.equal(chunks.join('').match(/\x1b\[201~/gu)?.length, 1)
  assert(chunks.join('').endsWith('\x1b[201~'), 'no Enter is appended')
  for (const chunk of chunks) {
    assert(chunk.length <= 16 * 1024)
    assert(chunk.isWellFormed())
    assert(Buffer.byteLength(JSON.stringify({ type: 'input', data: chunk })) <= 128 * 1024)
  }
})

test('worst-case JSON escapes and surrogate pairs at each boundary remain bounded', () => {
  for (const input of ['\0'.repeat(200_000), 'a'.repeat(16 * 1024 - 1) + '😀' + 'b'.repeat(16 * 1024), '😀'.repeat(100_000), '']) {
    const chunks = [...terminalInputChunks(input)]
    assert.equal(chunks.join(''), input)
    assert(chunks.every(chunk => chunk.isWellFormed()))
    assert(chunks.every(chunk => Buffer.byteLength(JSON.stringify({ type: 'input', data: chunk })) < 128 * 1024))
  }
})
