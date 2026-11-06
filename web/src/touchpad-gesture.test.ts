import assert from 'node:assert/strict'
import test from 'node:test'
import { TouchpadGesture, type TouchpadButton } from './touchpad-gesture.ts'

const finger = (identifier: number, clientX = 20, clientY = 30) => ({ identifier, clientX, clientY })
function fixture() {
  const events: unknown[] = []
  const gesture = new TouchpadGesture({
    move: (x, y) => events.push(['move', x, y]), scroll: (x, y) => events.push(['scroll', x, y]),
    tap: (button: TouchpadButton) => events.push(['tap', button]),
  })
  return { gesture, events }
}

test('one, two and three finger taps emit only their final button on the last lift', () => {
  for (const [count, button] of [[1, 'left'], [2, 'right'], [3, 'middle']] as const) {
    const { gesture, events } = fixture()
    for (let size = 1; size <= count; size++) gesture.update(Array.from({ length: size }, (_, id) => finger(id)), size * 10)
    assert.deepEqual(events, [], 'adding fingers never prematurely presses a mouse button')
    for (let remaining = count - 1; remaining > 0; remaining--) { gesture.end(remaining, 80); assert.deepEqual(events, []) }
    gesture.end(0, 90); gesture.end(0, 100)
    assert.deepEqual(events, [['tap', button]])
  }
})

test('single finger motion is relative and never also clicks on release', () => {
  const { gesture, events } = fixture()
  gesture.update([finger(1)], 0)
  gesture.update([finger(1, 50, 40)], 30)
  gesture.update([finger(1, 70, 30)], 60)
  gesture.end(0, 80)
  assert.deepEqual(events, [['move', 30, 10], ['move', 20, -10]])
})

test('native Touch coordinates may be prototype getters rather than enumerable fields', () => {
  class Finger {
    constructor(private readonly x: number, private readonly y: number) {}
    get identifier() { return 1 }
    get clientX() { return this.x }
    get clientY() { return this.y }
  }
  const { gesture, events } = fixture()
  gesture.update([new Finger(20, 30)], 0)
  gesture.update([new Finger(45, 40)], 20)
  gesture.end(0, 50)
  assert.deepEqual(events, [['move', 25, 10]])
})

test('adding a second finger rebases without moving the cursor and then scrolls both axes', () => {
  const { gesture, events } = fixture()
  gesture.update([finger(1)], 0)
  gesture.update([finger(1), finger(2, 80, 50)], 20)
  assert.deepEqual(events, [])
  gesture.update([finger(1, 40, 50), finger(2, 100, 70)], 40)
  gesture.end(1, 60)
  gesture.update([finger(1, 80, 80)], 70)
  gesture.end(0, 90)
  assert.deepEqual(events, [['scroll', -20, -20]], 'lifting one finger cannot turn the wheel tail into a cursor move or click')
})

test('cancellation, long holds and unsupported finger counts cannot synthesize clicks', () => {
  for (const mode of ['cancel', 'hold', 'four'] as const) {
    const { gesture, events } = fixture()
    gesture.update(mode === 'four' ? [finger(1), finger(2), finger(3), finger(4)] : [finger(1)], 0)
    if (mode === 'cancel') gesture.cancel()
    gesture.end(0, mode === 'hold' ? 500 : 100)
    assert.deepEqual(events, [])
    gesture.update([finger(9)], 600); gesture.end(0, 650)
    assert.deepEqual(events, [['tap', 'left']], 'a later independent gesture still works')
  }
})

test('three finger motion neither scrolls nor becomes a middle click', () => {
  const { gesture, events } = fixture()
  gesture.update([finger(1), finger(2), finger(3)], 0)
  gesture.update([finger(1, 40), finger(2, 40), finger(3, 40)], 20)
  gesture.end(2, 30); gesture.end(1, 40); gesture.end(0, 50)
  assert.deepEqual(events, [])
})
