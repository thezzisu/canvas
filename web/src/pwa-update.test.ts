import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pwaUpdateActions } from './pwa-update.ts'

test('a worker activated by another tab only notifies; user action alone can reload', async () => {
  let reloads = 0, notices = 0, activations = 0, waiting = true
  const first = pwaUpdateActions({ waiting: () => waiting, activate: async () => { activations++ },
    reload: () => { reloads++ }, notify: () => { notices++ } })
  first.activated()
  assert.equal(reloads, 0); assert.equal(notices, 1)
  await first.apply()
  assert.equal(reloads, 0); assert.equal(activations, 1)
  first.activated()
  assert.equal(reloads, 1)
  waiting = false
  const second = pwaUpdateActions({ waiting: () => waiting, activate: async () => { assert.fail('Already active worker') },
    reload: () => { reloads++ }, notify: () => { notices++ } })
  second.activated(); assert.equal(reloads, 1)
  await second.apply(); assert.equal(reloads, 2)
})

test('a rejected update leaves later external activations non-disruptive', async () => {
  let reloads = 0, notices = 0
  const update = pwaUpdateActions({ waiting: () => true, activate: async () => { throw new Error('Offline') },
    reload: () => { reloads++ }, notify: () => { notices++ } })
  await assert.rejects(update.apply(), /Offline/u)
  update.activated()
  assert.equal(reloads, 0); assert.equal(notices, 1)
})
