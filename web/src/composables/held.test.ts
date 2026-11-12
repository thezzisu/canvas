import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref } from 'vue'
import { useHeld } from './held.ts'

test('a held state lasts its minimum time and no longer than its source after that', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 1000
  t.mock.method(performance, 'now', () => now)
  const source = ref(false)
  const scope = effectScope()
  const held = scope.run(() => useHeld(() => source.value, 240))!
  t.after(() => scope.stop())

  source.value = true
  assert.equal(held.value, true)
  now += 20
  source.value = false
  t.mock.timers.tick(219)
  assert.equal(held.value, true)
  t.mock.timers.tick(1)
  assert.equal(held.value, false)

  // A state that returns in the meantime is one cover, measured from its start.
  source.value = true
  now += 100
  source.value = false
  source.value = true
  now += 400
  source.value = false
  t.mock.timers.tick(0)
  assert.equal(held.value, false)
})

test('a held state that returns within its linger is one state', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 1000
  t.mock.method(performance, 'now', () => now)
  const source = ref(true)
  const scope = effectScope()
  const held = scope.run(() => useHeld(() => source.value, 240, 200))!
  t.after(() => scope.stop())

  now += 300
  source.value = false
  t.mock.timers.tick(150)
  assert.equal(held.value, true)
  source.value = true
  now += 50
  source.value = false
  t.mock.timers.tick(199)
  assert.equal(held.value, true)
  t.mock.timers.tick(1)
  assert.equal(held.value, false)
})
