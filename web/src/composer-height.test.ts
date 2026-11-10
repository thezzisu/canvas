import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composerHeightBounds } from './composer-height.ts'

test('composer height clamps, snaps to full coverage and collapses when dragged away', () => {
  assert.deepEqual(composerHeightBounds(0.4, 600), { value: 0.4, collapse: false })
  assert.deepEqual(composerHeightBounds(0.95, 600), { value: 1, collapse: false })
  assert.deepEqual(composerHeightBounds(0.12, 600), { value: 0.16, collapse: false }, 'a 96px minimum keeps the editor usable')
  assert.equal(composerHeightBounds(0.05, 600).collapse, true)
  assert.deepEqual(composerHeightBounds(0.5, 80), { value: 1, collapse: false }, 'a tiny terminal is covered completely')
})
