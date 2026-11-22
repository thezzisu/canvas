import { test } from 'node:test'
import assert from 'node:assert/strict'
import { progressLayers, progressShare } from './progress-fill'

const card = { x: 100, width: 400 }

test('a report fills its share of the card; one without a percentage fills it all', () => {
  assert.equal(progressShare({ state: 'normal', value: 25 }), 0.25)
  assert.equal(progressShare({ state: 'normal', value: 140 }), 1)
  assert.equal(progressShare({ state: 'paused', value: -5 }), 0)
  assert.equal(progressShare({ state: 'indeterminate', value: null }), 1)
  assert.equal(progressShare({ state: 'error', value: null }), 1)
})

test('each state draws its own layers on the minimap', () => {
  assert.deepEqual(progressLayers({ state: 'normal', value: 25 }, card), {
    filled: { x: 100, width: 100 },
    rest: { x: 200, width: 300 },
    sweep: 'forward',
  })
  assert.deepEqual(progressLayers({ state: 'indeterminate', value: null }, card), {
    filled: { x: 100, width: 400 },
    sweep: 'reverse',
  })
  assert.deepEqual(progressLayers({ state: 'paused', value: 50 }, card), {
    filled: { x: 100, width: 200 },
    rest: { x: 300, width: 200 },
  })
  assert.deepEqual(progressLayers({ state: 'error', value: 50 }, card), {
    filled: { x: 100, width: 200 },
    rest: { x: 300, width: 200 },
    edge: 300,
  })
  assert.equal(progressLayers({ state: 'normal', value: 100 }, card).rest, undefined)
})
