import test from 'node:test'
import assert from 'node:assert/strict'
import { RetryDelay } from './retry-delay.ts'

test('a retry waits twice as long each time, up to its limit, and starts over after a success', () => {
  const delay = new RetryDelay(2000, 30_000)
  assert.deepEqual(
    Array.from({ length: 6 }, () => delay.take()),
    [2000, 4000, 8000, 16_000, 30_000, 30_000],
  )
  delay.reset()
  assert.equal(delay.take(), 2000)
})
