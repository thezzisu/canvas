import test from 'node:test'
import assert from 'node:assert/strict'
import { PreviewTap } from './preview-tap.ts'
const point = (values = {}) => ({ pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 20, ...values })
test('card previews open only on short, still taps or explicit keyboard activation', () => {
  const tap = new PreviewTap()
  tap.down(point(), 0); tap.up(point({ clientX: 13 }), 120); assert.equal(tap.click(1), true)
  assert.equal(tap.click(1), false); assert.equal(tap.click(0), true)
  tap.down(point(), 0); tap.up(point(), 600); assert.equal(tap.click(1), false)
})
test('card preview drags, pinches, cancellation and secondary clicks do not open', () => {
  const tap = new PreviewTap()
  tap.down(point(), 0); tap.move(point({ clientX: 30 })); tap.up(point(), 100); assert.equal(tap.click(1), false)
  tap.down(point(), 0); tap.down(point({ pointerId: 2, isPrimary: false }), 20); tap.up(point(), 100); assert.equal(tap.click(1), false)
  tap.down(point(), 0); tap.cancel(); tap.up(point(), 100); assert.equal(tap.click(1), false)
  tap.down(point({ button: 2 }), 0); tap.up(point(), 100); assert.equal(tap.click(1), false)
})
