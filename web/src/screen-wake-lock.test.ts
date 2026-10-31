import test from 'node:test'
import assert from 'node:assert/strict'
import { ScreenWakeLockController } from './screen-wake-lock.ts'

class Lock extends EventTarget {
  released = false
  releases = 0
  async release() { this.releases++; this.systemRelease() }
  systemRelease() { this.released = true; this.dispatchEvent(new Event('release')) }
}
function fixture() {
  const requests: Array<{ resolve(lock: Lock): void; reject(error: Error): void }> = []
  const states: string[] = []
  const control = new ScreenWakeLockController(() => new Promise<Lock>((resolve, reject) => requests.push({ resolve, reject })), state => states.push(state))
  return { control, requests, states }
}
const settle = async () => { for (let turn = 0; turn < 6; turn++) await Promise.resolve() }

test('wake lock exists only while eligible and repeated updates do not acquire duplicates', async () => {
  const f = fixture(), lock = new Lock()
  f.control.setActive(false); assert.equal(f.requests.length, 0)
  f.control.setActive(true); f.control.setActive(true); f.control.retry()
  assert.equal(f.requests.length, 1); assert.deepEqual(f.states, ['pending'])
  f.requests[0]!.resolve(lock); await settle()
  assert.equal(f.states.at(-1), 'active')
  f.control.retry(); assert.equal(f.requests.length, 1)
  f.control.setActive(false); await settle()
  assert.equal(lock.releases, 1); assert.equal(f.states.at(-1), 'off')
  f.control.dispose(); assert.equal(lock.releases, 1)
})

test('a request resolving after hide, logout or disabling releases its late lock', async () => {
  const f = fixture(), lock = new Lock()
  f.control.setActive(true); f.control.setActive(false)
  f.requests[0]!.resolve(lock); await settle()
  assert.equal(lock.releases, 1); assert.equal(f.requests.length, 1)
  assert.deepEqual(f.states, ['pending', 'off'])
  f.control.dispose()
})

test('foreground return while the old acquisition is pending releases it before acquiring once', async () => {
  const f = fixture(), old = new Lock(), current = new Lock()
  f.control.setActive(true); f.control.setActive(false); f.control.setActive(true)
  assert.equal(f.requests.length, 1, 'no parallel browser requests')
  f.requests[0]!.resolve(old); await settle()
  assert.equal(old.releases, 1); assert.equal(f.requests.length, 2)
  f.requests[1]!.resolve(current); await settle()
  assert.equal(f.states.at(-1), 'active'); assert.equal(current.releases, 0)
  f.control.dispose(); assert.equal(current.releases, 1)
})

test('permission rejection never loops and allows one explicit retry', async () => {
  const f = fixture(), lock = new Lock()
  f.control.setActive(true); f.requests[0]!.reject(new Error('NotAllowedError')); await settle()
  assert.equal(f.states.at(-1), 'denied'); assert.equal(f.requests.length, 1)
  f.control.setActive(true); await settle(); assert.equal(f.requests.length, 1)
  f.control.retry(); f.control.retry(); assert.equal(f.requests.length, 2)
  f.requests[1]!.resolve(lock); await settle(); assert.equal(f.states.at(-1), 'active')
  f.control.dispose()
})

test('system release reports suspension without reacquiring until explicit retry or foreground return', async () => {
  const f = fixture(), lock = new Lock(), resumed = new Lock()
  f.control.setActive(true); f.requests[0]!.resolve(lock); await settle()
  lock.systemRelease(); await settle()
  assert.equal(f.states.at(-1), 'released'); assert.equal(f.requests.length, 1)
  f.control.setActive(false); f.control.setActive(true)
  assert.equal(f.requests.length, 2)
  f.requests[1]!.resolve(resumed); await settle()
  lock.systemRelease(); assert.equal(f.states.at(-1), 'active', 'old release events cannot suspend the current lock')
  f.control.dispose(); assert.equal(resumed.releases, 1)
})

test('a sentinel already released when acquired is not presented as active', async () => {
  const f = fixture(), lock = new Lock(); lock.systemRelease()
  f.control.setActive(true); f.requests[0]!.resolve(lock); await settle()
  assert.equal(f.states.at(-1), 'released'); assert.equal(f.requests.length, 1)
  f.control.dispose()
})

test('disposing while acquisition is pending releases the result and prevents any future request', async () => {
  const f = fixture(), lock = new Lock()
  f.control.setActive(true); f.control.dispose(); f.control.retry(); f.control.setActive(true)
  f.requests[0]!.resolve(lock); await settle()
  assert.equal(lock.releases, 1); assert.equal(f.requests.length, 1)
  assert.deepEqual(f.states, ['pending', 'off'])
})

test('a synchronous browser refusal is handled like a rejected acquisition', async () => {
  const states: string[] = []
  const control = new ScreenWakeLockController(() => { throw new Error('Refused') }, state => states.push(state))
  control.setActive(true); await settle()
  assert.deepEqual(states, ['pending', 'denied'])
  control.dispose()
})
