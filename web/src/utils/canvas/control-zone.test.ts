import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inZone,
  nextZone,
  ZONE_EXIT_MARGIN,
  zoneOf,
  type ZoneState,
  type ZoneStep,
} from './control-zone'

// The desktop layout: the minimap standing 8px above the toolbar, at the bottom left.
const minimap = { left: 20, top: 700, right: 172, bottom: 800 }
const toolbar = { left: 20, top: 808, right: 152, bottom: 840 }
const zone = zoneOf([minimap, toolbar])

test('the zone joins controls that stand close, across the gap between them', () => {
  assert.equal(zone.length, 3)
  assert.deepEqual(zone[2], { left: 20, right: 152, top: 800, bottom: 808 })
  assert(inZone(zone, { x: 60, y: 804 }), 'the gap above the toolbar is in the zone')
  assert(!inZone(zone, { x: 165, y: 804 }), 'beside the narrower toolbar is not')
  // Controls far apart, as on a touch screen, stay apart.
  assert.equal(zoneOf([{ left: 300, top: 10, right: 400, bottom: 70 }, toolbar]).length, 2)
  // Side by side within the gap.
  assert.equal(
    zoneOf([
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 20, top: 0, right: 30, bottom: 10 },
    ]).length,
    3,
  )
  // A hidden control takes no room.
  assert.deepEqual(zoneOf([toolbar, { left: 0, top: 0, right: 0, bottom: 0 }]), [toolbar])
})

test('the exit margin reaches past the zone by the gap', () => {
  assert(inZone(zone, { x: 172 + ZONE_EXIT_MARGIN - 1, y: 750 }, ZONE_EXIT_MARGIN))
  assert(!inZone(zone, { x: 172 + ZONE_EXIT_MARGIN, y: 750 }, ZONE_EXIT_MARGIN))
})

const step = (overrides: Partial<ZoneStep>): ZoneStep => ({
  inside: false,
  near: false,
  held: false,
  fromTerminal: false,
  yieldable: true,
  ...overrides,
})
function walk(steps: Partial<ZoneStep>[], state: ZoneState = 'idle') {
  return steps.map((overrides) => (state = nextZone(state, step(overrides))))
}

test('where the pointer came from decides, and the decision holds across the zone', () => {
  // From the canvas into the minimap, across the gap, onto the toolbar: engaged throughout.
  assert.deepEqual(
    walk([
      {},
      { inside: true, near: true },
      { inside: true, near: true },
      { inside: true, near: true },
    ]),
    ['idle', 'engaged', 'engaged', 'engaged'],
  )
  // From the focused terminal: yielding, and still yielding where the zone leaves the terminal.
  assert.deepEqual(
    walk([
      { inside: true, near: true, fromTerminal: true },
      { inside: true, near: true },
    ]),
    ['yielding', 'yielding'],
  )
})

test('a pointer leaves the zone only past its margin, or when a held button is released', () => {
  // Trembling on the edge keeps the decision; past the margin it is gone.
  assert.deepEqual(walk([{ near: true }, { inside: true, near: true }, {}], 'yielding'), [
    'yielding',
    'yielding',
    'idle',
  ])
  // Dragging out of the zone keeps it engaged until the release.
  assert.deepEqual(walk([{ held: true }, { held: true }, {}], 'engaged'), [
    'engaged',
    'engaged',
    'idle',
  ])
  // Out and back in from outside the terminal wakes it.
  assert.deepEqual(walk([{}, { inside: true, near: true }], 'yielding'), ['idle', 'engaged'])
})

test("with nothing to yield to, the controls are the pointer's own", () => {
  assert.equal(
    nextZone('idle', step({ inside: true, near: true, fromTerminal: true, yieldable: false })),
    'engaged',
  )
  assert.equal(
    nextZone('yielding', step({ inside: true, near: true, yieldable: false })),
    'engaged',
  )
})
