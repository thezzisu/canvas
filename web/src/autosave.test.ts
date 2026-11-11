import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAutosave } from './autosave.ts'

test('autosave waits for a pause but never longer than the max wait while typing continues', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const autosave = createAutosave(1000, 5000), saves: number[] = []
  const edit = () => autosave.schedule('note', () => saves.push(Date.now()))
  edit(); t.mock.timers.tick(999); assert.deepEqual(saves, [])
  t.mock.timers.tick(1); assert.deepEqual(saves, [1000], 'a pause saves after the idle wait')
  // Typing every 300ms for 10.2s from t=1000 never pauses for a second.
  for (let i = 0; i < 34; i++) { edit(); t.mock.timers.tick(300) }
  assert.equal(saves.length, 3, 'continuous typing still saves every five seconds')
  edit(); t.mock.timers.tick(999); assert.equal(saves.length, 3)
  t.mock.timers.tick(1); assert.equal(saves.length, 4, 'the final pause saves the rest')
  edit(); autosave.cancel('note'); t.mock.timers.tick(5000); assert.equal(saves.length, 4, 'a cancelled wait never saves')
  assert.equal(autosave.has('note'), false)
})
