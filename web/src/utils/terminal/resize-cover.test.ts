import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coversResize, resizesRowsOnly, settlingPeriod } from './resize-cover.ts'

test('a resize is covered unless it is the page settling after a cover', () => {
  const settling = { covered: false, prompted: false, sinceUncovered: 400 }
  assert.equal(coversResize(settling), false)
  // Under the cover it extends it; asked for by the user it is covered again.
  assert.equal(coversResize({ ...settling, covered: true }), true)
  assert.equal(coversResize({ ...settling, prompted: true }), true)
  // Later, or with no cover before it, it is a resize of its own.
  assert.equal(coversResize({ ...settling, sinceUncovered: settlingPeriod }), true)
  assert.equal(coversResize({ ...settling, sinceUncovered: undefined }), true)
})

test('only a change of the row count alone resizes rows only', () => {
  const shown = { cols: 57, rows: 55 }
  assert.equal(resizesRowsOnly(shown, { cols: 57, rows: 35 }), true)
  assert.equal(resizesRowsOnly(shown, { cols: 57, rows: 60 }), true)
  // A rotation changes both, and a split screen may change the columns alone.
  assert.equal(resizesRowsOnly(shown, { cols: 120, rows: 22 }), false)
  assert.equal(resizesRowsOnly(shown, { cols: 40, rows: 55 }), false)
  assert.equal(resizesRowsOnly(shown, shown), false)
})
