import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rewraps, showsCover } from './resize-cover.ts'

test('only another column count wraps the lines on screen anew', () => {
  const shown = { cols: 57, rows: 55 }
  // A keyboard opening, closing or settling changes the rows alone.
  const shorter = { cols: 57, rows: 35 }
  assert.equal(rewraps(shown, shorter), false)
  assert.equal(rewraps(shown, shown), false)
  // A rotation changes both, and a split screen may change the columns alone.
  const turned = { cols: 120, rows: 22 }
  const narrower = { cols: 40, rows: 55 }
  assert.equal(rewraps(shown, turned), true)
  assert.equal(rewraps(shown, narrower), true)
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
