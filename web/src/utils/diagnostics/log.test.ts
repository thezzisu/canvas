import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  batchesToDrop,
  inputKind,
  LOG_CAP,
  logFileName,
  logLine,
  logTime,
  logWindow,
  type LogFields,
} from './log.ts'

const clock = {
  epoch: Date.UTC(2026, 10, 14, 13, 11, 3, 120),
  monotonic: 5123.456,
  session: 'ab12',
  offsetMinutes: 480,
}

test('a line carries the exact local time with its offset, the page clock and the session', () => {
  assert.equal(logTime(clock.epoch, 480), '2026-11-14T21:11:03.120+08:00')
  assert.equal(logTime(clock.epoch, -330), '2026-11-14T07:41:03.120-05:30')
  assert.equal(
    logLine(clock, 'cells', {
      w: logWindow({ sourceId: 'src', windowId: 'wF:t1' }),
      kind: 'patch',
      rev: 2841,
      ms: 0.4567,
    }),
    '{"t":"2026-11-14T21:11:03.120+08:00","m":5123.5,"s":"ab12","e":"cells","w":"src/wF:t1","kind":"patch","rev":2841,"ms":0.46}',
  )
  assert.equal(logFileName(clock.epoch, 480), 'canvas-log-20261114-211103.ndjson')
})

test('a line cannot carry free text', () => {
  // The types refuse a string that is not one of the log's words; this is what the line does
  // with one that reaches it anyway.
  const smuggled = {
    kind: 'echo secret',
    note: 'rm -rf /',
    n: Number.NaN,
    list: ['x'],
  } as unknown as LogFields
  assert.equal(
    logLine(clock, 'input', { ...smuggled, w: 'has space' as never, bytes: 11 }),
    '{"t":"2026-11-14T21:11:03.120+08:00","m":5123.5,"s":"ab12","e":"input","bytes":11}',
  )
})

test('an input is named by its kind alone', () => {
  assert.equal(inputKind('ls -al\r'), 'key')
  assert.equal(inputKind('\x1b[A'), 'key')
  assert.equal(inputKind('\x1b[200~secret\x1b[201~'), 'paste')
  assert.equal(inputKind('\x1b[<0;10;5M'), 'mouse')
  assert.equal(inputKind('\x1b[<35;10;5M'), 'mouse')
  assert.equal(inputKind('\x1b[<64;10;5M'), 'wheel')
  assert.equal(inputKind('\x1b[<65;10;5M'), 'wheel')
  assert.equal(inputKind('\x1b[I'), 'focus')
  assert.equal(inputKind('\x1b[O'), 'focus')
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
