import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { TerminalReconnect } from '../web/src/terminal-reconnect.ts'

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let active = true
  const attempts: boolean[] = [], waiting: number[] = []
  let exhausted = 0, timeouts = 0
  const control = new TerminalReconnect({
    active: () => active, connect: probe => attempts.push(probe), waiting: count => waiting.push(count),
    failed: () => exhausted++, timeout: () => { timeouts++; control.failed() },
  })
  t.after(() => control.pause())
  return { control, attempts, waiting, exhausted: () => exhausted, timeouts: () => timeouts,
    detach: () => { active = false; control.pause() }, attach: () => { active = true; control.resume() } }
}

test('automatic reconnection makes only three delayed attempts before requiring manual retry', t => {
  const f = fixture(t); f.control.resume()
  assert.deepEqual(f.attempts, [false])
  for (const [index, delay] of [500, 1500, 3000].entries()) {
    f.control.failed()
    assert.equal(f.waiting.at(-1), index + 1)
    t.mock.timers.tick(delay - 1)
    assert.equal(f.attempts.length, index + 1)
    t.mock.timers.tick(1)
    assert.equal(f.attempts.length, index + 2)
  }
  f.control.failed(); t.mock.timers.tick(60_000)
  assert.equal(f.exhausted(), 1); assert.deepEqual(f.attempts, [false, true, true, true])
  f.control.resume(); t.mock.timers.tick(60_000)
  assert.equal(f.attempts.length, 4, 'remount cannot reset the exhausted budget')
  f.control.restart()
  assert.equal(f.attempts.length, 5); assert.equal(f.waiting.at(-1), 0)
  f.control.failed(); t.mock.timers.tick(500)
  assert.equal(f.attempts.length, 6, 'manual retry starts one fresh budget')
})

test('a socket open or connecting protocol without connected status times out within twelve seconds', t => {
  const f = fixture(t); f.control.resume()
  t.mock.timers.tick(11_999)
  assert.equal(f.timeouts(), 0)
  t.mock.timers.tick(1)
  assert.equal(f.timeouts(), 1); assert.equal(f.waiting.at(-1), 1)
  t.mock.timers.tick(500)
  assert.equal(f.attempts.length, 2)
  t.mock.timers.tick(12_000)
  assert.equal(f.timeouts(), 2); assert.equal(f.waiting.at(-1), 2)
})

test('brief connected flaps spend the same budget instead of retrying forever', t => {
  const f = fixture(t); f.control.resume()
  for (const delay of [500, 1500, 3000]) {
    f.control.connected(); t.mock.timers.tick(4000)
    f.control.failed(); t.mock.timers.tick(delay)
  }
  f.control.connected(); t.mock.timers.tick(4999); f.control.failed()
  assert.equal(f.exhausted(), 1)
  t.mock.timers.tick(60_000)
  assert.equal(f.attempts.length, 4)
})

test('connected status must stay stable for five seconds to replenish the budget', t => {
  const f = fixture(t); f.control.resume(); f.control.failed(); t.mock.timers.tick(500)
  f.control.connected(); t.mock.timers.tick(3000); f.control.connected(); t.mock.timers.tick(2000)
  f.control.failed()
  assert.equal(f.waiting.at(-1), 1, 'repeated status notifications do not restart the stability timer')
  t.mock.timers.tick(500)
  assert.equal(f.attempts.length, 3)
  assert.equal(f.timeouts(), 0, 'effective connected status clears the handshake timeout')
})

test('detaching cancels timers and remounting resumes the remaining retry budget', t => {
  const f = fixture(t); f.control.resume(); f.control.failed()
  f.detach(); t.mock.timers.tick(60_000)
  assert.equal(f.attempts.length, 1); assert.equal(f.timeouts(), 0)
  f.attach(); t.mock.timers.tick(500)
  assert.equal(f.attempts.length, 2)
  f.control.failed(); assert.equal(f.waiting.at(-1), 2)
  f.detach(); t.mock.timers.tick(60_000)
  assert.equal(f.attempts.length, 2)
  f.attach(); t.mock.timers.tick(1500)
  assert.equal(f.attempts.length, 3)
})

test('authorization or source removal stops retries and disposed handshakes cannot fire later', t => {
  const f = fixture(t); f.control.resume(); f.control.failed(false)
  t.mock.timers.tick(60_000); f.control.resume()
  assert.equal(f.exhausted(), 1); assert.equal(f.attempts.length, 1)
  f.control.restart(); f.detach(); t.mock.timers.tick(60_000)
  assert.equal(f.timeouts(), 0); assert.equal(f.attempts.length, 2)
})
