import assert from 'node:assert/strict'
import test from 'node:test'
import { TouchpadGesture, type TouchpadButton } from './touchpad-gesture.ts'

const finger = (identifier: number, clientX = 20, clientY = 30) => ({
  identifier,
  clientX,
  clientY,
})
function fixture(acceptDrag = true) {
  const events: unknown[] = []
  const gesture = new TouchpadGesture({
    move: (x, y) => events.push(['move', x, y]),
    scroll: (x, y) => events.push(['scroll', x, y]),
    tap: (button: TouchpadButton) => events.push(['tap', button]),
    startDrag: () => {
      if (!acceptDrag) return false
      events.push(['down'])
      return true
    },
    endDrag: (cancelled) => events.push(['up', cancelled]),
  })
  return { gesture, events }
}

test('one, two and three finger taps emit only their final button on the last lift', () => {
  for (const [count, button] of [
    [1, 'left'],
    [2, 'right'],
    [3, 'middle'],
  ] as const) {
    const { gesture, events } = fixture()
    for (let size = 1; size <= count; size++)
      gesture.update(
        Array.from({ length: size }, (_, id) => finger(id)),
        size * 10,
      )
    assert.deepEqual(events, [], 'adding fingers never prematurely presses a mouse button')
    for (let remaining = count - 1; remaining > 0; remaining--) {
      gesture.end(remaining, 80)
      assert.deepEqual(events, [])
    }
    gesture.end(0, 90)
    gesture.end(0, 100)
    assert.deepEqual(events, [['tap', button]])
  }
})

test('single finger motion is relative and never also clicks on release', () => {
  const { gesture, events } = fixture()
  gesture.update([finger(1)], 0)
  gesture.update([finger(1, 50, 40)], 30)
  gesture.update([finger(1, 70, 30)], 60)
  gesture.end(0, 80)
  assert.deepEqual(events, [
    ['move', 30, 10],
    ['move', 20, -10],
  ])
})

test('native Touch coordinates may be prototype getters rather than enumerable fields', () => {
  class Finger {
    constructor(
      private readonly x: number,
      private readonly y: number,
    ) {}
    get identifier() {
      return 1
    }
    get clientX() {
      return this.x
    }
    get clientY() {
      return this.y
    }
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
  assert.deepEqual(
    events,
    [['scroll', -20, -20]],
    'lifting one finger cannot turn the wheel tail into a cursor move or click',
  )
})

test('cancellation, long holds and unsupported finger counts cannot synthesize clicks', () => {
  for (const mode of ['cancel', 'hold', 'four'] as const) {
    const { gesture, events } = fixture()
    gesture.update(mode === 'four' ? [finger(1), finger(2), finger(3), finger(4)] : [finger(1)], 0)
    if (mode === 'cancel') gesture.cancel()
    gesture.end(0, mode === 'hold' ? 500 : 100)
    assert.deepEqual(events, [])
    gesture.update([finger(9)], 600)
    gesture.end(0, 650)
    assert.deepEqual(events, [['tap', 'left']], 'a later independent gesture still works')
  }
})

test('three finger motion neither scrolls nor becomes a middle click', () => {
  const { gesture, events } = fixture()
  gesture.update([finger(1), finger(2), finger(3)], 0)
  gesture.update([finger(1, 40), finger(2, 40), finger(3, 40)], 20)
  gesture.end(2, 30)
  gesture.end(1, 40)
  gesture.end(0, 50)
  assert.deepEqual(events, [])
})

test('tap then nearby second-contact motion holds left before moving and releases once', () => {
  const { gesture, events } = fixture()
  gesture.update([finger(1)], 0)
  gesture.end(0, 30)
  gesture.update([finger(2, 22, 32)], 100)
  gesture.update([finger(2, 24, 34)], 120)
  assert.deepEqual(
    events,
    [['tap', 'left']],
    'second touch does not prematurely press while tap or finger count is undecided',
  )
  gesture.update([finger(2, 44, 44)], 150)
  gesture.update([finger(2, 64, 39)], 180)
  gesture.end(0, 200)
  gesture.end(0, 210)
  gesture.cancel()
  assert.deepEqual(events, [
    ['tap', 'left'],
    ['down'],
    ['move', 20, 10],
    ['move', 20, -5],
    ['up', false],
  ])
})

test('two quick stationary taps remain two ordinary clicks and a held second touch can start dragging later', () => {
  const { gesture, events } = fixture()
  gesture.update([finger(1)], 0)
  gesture.end(0, 20)
  gesture.update([finger(2)], 80)
  gesture.end(0, 100)
  assert.deepEqual(events, [
    ['tap', 'left'],
    ['tap', 'left'],
  ])
  gesture.update([finger(3)], 160)
  gesture.update([finger(3, 40, 50)], 900)
  gesture.end(0, 950)
  assert.deepEqual(
    events.slice(2),
    [['down'], ['move', 20, 20], ['up', false]],
    'the contact timing, not time spent holding it, arms dragging',
  )
})

test('late, distant and cancelled follow-ups move normally without holding left', () => {
  for (const scenario of ['late', 'distant', 'cancelled'] as const) {
    const { gesture, events } = fixture()
    gesture.update([finger(1)], 0)
    gesture.end(0, 20)
    if (scenario === 'cancelled') gesture.cancel()
    const x = scenario === 'distant' ? 80 : 20,
      now = scenario === 'late' ? 371 : 100
    gesture.update([finger(2, x, 30)], now)
    gesture.update([finger(2, x + 30, 45)], now + 30)
    gesture.end(0, now + 80)
    assert.deepEqual(
      events,
      [
        ['tap', 'left'],
        ['move', 30, 15],
      ],
      scenario,
    )
  }
})

test('cancelling a tap-drag releases it without completing a selection or retaining another tap candidate', () => {
  const { gesture, events } = fixture()
  gesture.update([finger(1)], 0)
  gesture.end(0, 20)
  gesture.update([finger(2)], 100)
  gesture.update([finger(2, 45, 40)], 120)
  gesture.cancel()
  gesture.cancel()
  gesture.end(0, 150)
  gesture.update([finger(3)], 200)
  gesture.update([finger(3, 50, 50)], 230)
  gesture.end(0, 250)
  assert.deepEqual(events, [
    ['tap', 'left'],
    ['down'],
    ['move', 25, 10],
    ['up', true],
    ['move', 30, 20],
  ])
})

test('adding fingers during tap-drag releases once and does not reinterpret the remaining gesture', () => {
  const { gesture, events } = fixture()
  gesture.update([finger(1)], 0)
  gesture.end(0, 20)
  gesture.update([finger(2)], 100)
  gesture.update([finger(2, 45, 40)], 120)
  gesture.update([finger(2, 45, 40), finger(3, 60, 40)], 140)
  gesture.update([finger(2, 75, 70), finger(3, 90, 70)], 160)
  gesture.end(1, 180)
  gesture.update([finger(2, 100, 90)], 200)
  gesture.end(0, 220)
  assert.deepEqual(events, [['tap', 'left'], ['down'], ['move', 25, 10], ['up', true]])
})

test('adding fingers before drag recognition keeps the normal multi-finger tap', () => {
  const { gesture, events } = fixture()
  gesture.update([finger(1)], 0)
  gesture.end(0, 20)
  gesture.update([finger(2)], 100)
  gesture.update([finger(2), finger(3, 60, 30)], 120)
  gesture.end(1, 140)
  gesture.end(0, 160)
  assert.deepEqual(events, [
    ['tap', 'left'],
    ['tap', 'right'],
  ])
})

test('a gesture that cannot acquire left ownership never releases the explicit control button', () => {
  const { gesture, events } = fixture(false)
  gesture.update([finger(1)], 0)
  gesture.end(0, 20)
  gesture.update([finger(2)], 100)
  gesture.update([finger(2, 45, 40)], 120)
  gesture.end(0, 150)
  gesture.cancel()
  assert.deepEqual(events, [
    ['tap', 'left'],
    ['move', 25, 10],
  ])
})
