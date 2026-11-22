import { test } from 'node:test'
import assert from 'node:assert/strict'
import { batchesToDrop, LOG_CAP, logFileName } from './log.ts'

test('a downloaded log is named by its local start time', () => {
  assert.equal(
    logFileName(Date.UTC(2026, 10, 14, 13, 11, 3, 120), 480),
    'canvas-log-20261114-211103.ndjson',
  )
})

test('the oldest batches leave, a megabyte at a time, once the cap is reached', () => {
  const mb = 1024 * 1024
  assert.equal(LOG_CAP, 50 * mb)
  assert.equal(batchesToDrop([], 1000), 0)
  assert.equal(batchesToDrop(new Array(49).fill(mb), mb), 0)
  // Fifty megabytes and one batch more: the oldest megabyte and what is over it leave.
  const full = new Array(50).fill(mb)
  assert.equal(batchesToDrop(full, 4096), 2)
  const kept = full.slice(2).reduce((sum, size) => sum + size, 0) + 4096
  assert(kept <= LOG_CAP - mb + 4096 && kept > LOG_CAP - 3 * mb)
  // Small batches leave until a megabyte is free, and never more than there are.
  assert.equal(batchesToDrop(new Array(1000).fill(1000), 500, 1_000_000), 501)
  assert.equal(batchesToDrop([10, 10], 10_000, 100), 2)
})
