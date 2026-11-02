import test from 'node:test'
import assert from 'node:assert/strict'
import { compactHeader } from './header-capacity.ts'

test('centered cutouts fold the primary action at the actual inner-width boundary', () => {
  assert.equal(compactHeader(320, 56, 'center'), false)
  assert.equal(compactHeader(318.4, 56, 'center'), true)
  assert.equal(compactHeader(318.4, 40, 'center'), false)
  assert.equal(compactHeader(390, 130, 'center'), true)
  assert.equal(compactHeader(390, 126, 'center'), false)
})
test('side cutouts retain a title and fixed-size controls, folding rather than shrinking', () => {
  for (const position of ['left', 'right'] as const) {
    assert.equal(compactHeader(320, 100, position), false)
    assert.equal(compactHeader(318.4, 100, position), true)
    assert.equal(compactHeader(320, 240, position), true)
  }
  assert.equal(compactHeader(320, 0, 'center'), false)
  assert.equal(compactHeader(0, 0, 'center'), true)
})
test('full card action rows fold on phones and remain expanded when each side has room', () => {
  assert.equal(compactHeader(320, 0, 'center', 6), true)
  assert.equal(compactHeader(390, 0, 'center', 6), false)
  assert.equal(compactHeader(600, 72, 'center', 6), false)
  assert.equal(compactHeader(598.4, 72, 'center', 6), true)
})
