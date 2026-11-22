import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inputKind,
  logIdentifier,
  logLine,
  logTime,
  logWindow,
  type LogFields,
} from './log-line.ts'

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
})

test('identifiers of sockets, views and addresses are written as they are', () => {
  assert.equal(
    logLine(clock, 'socket', {
      socket: logIdentifier('k3x9'),
      address: logIdentifier('192.168.149.10'),
      state: 'open',
    }),
    '{"t":"2026-11-14T21:11:03.120+08:00","m":5123.5,"s":"ab12","e":"socket","socket":"k3x9","address":"192.168.149.10","state":"open"}',
  )
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
