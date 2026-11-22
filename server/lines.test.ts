import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LineSplitter, LineTooLong } from './lines.ts'

const text = (lines: Buffer[]) => lines.map((line) => line.toString())

test('lines are split as their newlines arrive, across and within chunks', () => {
  const lines = new LineSplitter(64)
  assert.deepEqual(text(lines.push(Buffer.from('{"a":'))), [])
  assert.deepEqual(text(lines.push(Buffer.from('1}\n{"b":2}\n{"c"'))), ['{"a":1}', '{"b":2}'])
  assert.equal(lines.rest.toString(), '{"c"')
  assert.deepEqual(text(lines.push(Buffer.from(':3}\n'))), ['{"c":3}'])
  assert.equal(lines.rest.length, 0)
  // A multi-byte character split between chunks is whole in its line.
  const bytes = Buffer.from('中文\n')
  assert.deepEqual(text([...lines.push(bytes.subarray(0, 2)), ...lines.push(bytes.subarray(2))]), [
    '中文',
  ])
})

test('a line, or bytes waiting for one, over the limit is refused', () => {
  assert.throws(() => new LineSplitter(4).push(Buffer.from('12345\n')), LineTooLong)
  const waiting = new LineSplitter(4)
  waiting.push(Buffer.from('123'))
  assert.throws(() => waiting.push(Buffer.from('45')), LineTooLong)
  assert.deepEqual(text(new LineSplitter(4).push(Buffer.from('1234\n'))), ['1234'])
})
