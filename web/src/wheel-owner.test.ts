import test from 'node:test'
import assert from 'node:assert/strict'
import { WheelOwner } from './wheel-owner.ts'

test('camera movement cannot transfer a wheel stream to newly hovered content', () => {
  const wheel = new WheelOwner<object>(), content = {}
  assert.equal(wheel.resolve(null, 0), null)
  assert.equal(wheel.resolve(content, 30), null)
  assert.equal(wheel.resolve(content, 230), null)
  assert.equal(wheel.resolve(content, 500), content)
})

test('content boundaries, focus loss and pointer movement cannot send momentum to another owner', () => {
  const wheel = new WheelOwner<object>(), first = {}, second = {}
  assert.equal(wheel.resolve(first, 0), first)
  assert.equal(wheel.resolve(null, 30), first)
  assert.equal(wheel.resolve(second, 60), first)
  assert.equal(wheel.resolve(second, 400), second)
})

test('explicit interaction and changing pinch mode start an independent gesture', () => {
  const wheel = new WheelOwner<object>(), content = {}
  wheel.resolve(content, 0)
  assert.equal(wheel.resolve(null, 10, true), null)
  assert.equal(wheel.resolve(content, 20, false), content)
  wheel.reset()
  assert.equal(wheel.resolve(null, 21), null)
})
