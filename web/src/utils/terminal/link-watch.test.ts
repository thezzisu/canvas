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
  assert(steady.spread < 2)
})

test('a message leaves when the buffer drains past it, and an answer to it is a round trip', () => {
  const box = new Outbox(0)
  box.sent(10, 0, 10)
  box.sent(20, 0, 30)
  assert.equal(box.oldest!.left, undefined, 'still in the browser')
  assert.equal(box.drain(20, 50), true)
  assert.equal(box.oldest!.left, 50)
  assert.equal(box.drain(20, 60), false, 'nothing more left')
  box.drain(0, 70)
  // Received 30 ms before the server sent this; 200 ms after the first left.
  assert.deepEqual(box.stamped({ got: 1, since: 30, quiet: 30 }, 250, 10), {
    progressed: true,
    sample: 170,
  })
  assert.equal(box.oldest!.index, 2)
  assert.deepEqual(
    box.stamped({ got: 9, since: 0, quiet: 0 }, 260, 10),
    {},
    'never what was not sent',
  )
})

test('bytes sent before the next message could arrive are queued; after, without it, it is held', () => {
  const box = new Outbox(0)
  box.sent(5, 100, 0) // message 1 leaves at once
  box.stamped({ got: 1, since: 0, quiet: 0 }, 150, 50)
  box.sent(5, 1000, 0) // message 2 leaves 900 ms after message 1
  // The server sent this 600 ms after message 1 arrived: before message 2 could.
  assert.deepEqual(box.stamped({ got: 1, since: 600, quiet: 600 }, 1100, 50), { queued: true })
  // 1500 ms after: 600 ms after message 2 should have arrived, as message 1 did.
  assert.deepEqual(box.stamped({ got: 1, since: 1500, quiet: 1500 }, 1200, 50), { held: true })
  // A byte arrived since, so message 2 is on its way.
  assert.deepEqual(box.stamped({ got: 1, since: 1600, quiet: 50 }, 1300, 50), { progressed: true })
  assert.deepEqual(box.stamped({ got: 1, since: 1700, quiet: 150 }, 1400, 50), { held: true })
})
