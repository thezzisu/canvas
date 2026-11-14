import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resizesRowsOnly, showsCover } from './resize-cover.ts'

test('only a change of the row count alone resizes rows only', () => {
  const shown = { cols: 57, rows: 55 }
  assert.equal(resizesRowsOnly(shown, { cols: 57, rows: 35 }), true)
  assert.equal(resizesRowsOnly(shown, { cols: 57, rows: 60 }), true)
  // A rotation changes both, and a split screen may change the columns alone.
  assert.equal(resizesRowsOnly(shown, { cols: 120, rows: 22 }), false)
  assert.equal(resizesRowsOnly(shown, { cols: 40, rows: 55 }), false)
  assert.equal(resizesRowsOnly(shown, shown), false)
})

test('the cover is over a painted, connected terminal whose frame is not the one to look at', () => {
  const rest = {
    connected: true,
    painted: true,
    appShowing: false,
    dragging: false,
    awaitingFrame: false,
  }
  assert.equal(showsCover(rest), false)
  assert.equal(showsCover({ ...rest, dragging: true }), true)
  assert.equal(showsCover({ ...rest, awaitingFrame: true }), true)
  // The loading panel, the reconnecting panel and a captured app cover in its place.
  for (const other of [{ painted: false }, { connected: false }, { appShowing: true }])
    assert.equal(showsCover({ ...rest, awaitingFrame: true, ...other }), false)
})
