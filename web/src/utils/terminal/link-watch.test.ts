import test from 'node:test'
import assert from 'node:assert/strict'
import { Outbox, RoundTrip } from './link-watch.ts'

test('the round trip is smoothed as RFC 6298 has it, and its timeout is at least a second', () => {
  const rtt = new RoundTrip()
  assert.equal(rtt.timeout, 1100, 'before any sample: a second, and the ack delay')
  rtt.sample(400)
  assert.deepEqual([rtt.smoothed, rtt.variation], [400, 200])
  assert.equal(rtt.timeout, 400 + 800 + 100)
  rtt.sample(200)
  assert.deepEqual([rtt.smoothed, rtt.variation], [375, 200])
  const steady = new RoundTrip()
  for (let i = 0; i < 50; i++) steady.sample(20)
  assert.equal(steady.timeout, 1100, 'a fast steady link still waits the minimum')
})

test('a higher count acknowledges what was sent up to it, and gives a round trip', () => {
  const box = new Outbox(0)
  box.sent(0)
  box.sent(10)
  // The server had received both 30 ms before it said so, 250 ms after the second left.
  assert.deepEqual(box.stamped({ got: 2, bytes: 90, since: 30 }, 260), {
    kind: 'progress',
    rtt: 220,
  })
  assert.equal(box.oldest, undefined)
  assert.equal(box.stamped({ got: 2, bytes: 90, since: 900 }, 1200), undefined, 'nothing new')
  assert.equal(
    box.stamped({ got: 9, bytes: 900, since: 0 }, 1300),
    undefined,
    'never what was not sent',
  )
})

test('bytes of the next message are progress; a stamp written before it could arrive is early', () => {
  const box = new Outbox(0)
  box.sent(100)
  box.stamped({ got: 1, bytes: 40, since: 0 }, 110)
  box.sent(1000)
  // The server wrote this 600 ms after message 1 arrived: before message 2, 900 ms later, could.
  assert.deepEqual(box.stamped({ got: 1, bytes: 40, since: 600 }, 1100), { kind: 'early' })
  // Written 1500 ms after: message 2 should have arrived, and it says nothing of it. No verdict.
  assert.equal(box.stamped({ got: 1, bytes: 40, since: 1500 }, 1200), undefined)
  // Bytes of message 2 arrived: it is on its way.
  assert.deepEqual(box.stamped({ got: 1, bytes: 60, since: 1600 }, 1300), { kind: 'progress' })
  assert.equal(box.stamped({ got: 1, bytes: 60, since: 1700 }, 1400), undefined)
  assert.deepEqual(box.stamped({ got: 2, bytes: 80, since: 0 }, 1500), {
    kind: 'progress',
    rtt: 500,
  })
})
