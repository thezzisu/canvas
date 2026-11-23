import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inZone,
  leftZone,
  movedZone,
  restingZone,
  ZONE_EXIT_MARGIN,
  zoneLook,
  zoneOf,
  type ZoneMemory,
  type ZonePlace,
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

// Places the pointer moves to.
const canvas: ZonePlace = { inside: false, near: false, onTerminal: false, yieldable: true }
const terminal: ZonePlace = { ...canvas, onTerminal: true }
const control: ZonePlace = { ...canvas, inside: true, near: true }
const edge: ZonePlace = { ...canvas, near: true }
function walk(places: (ZonePlace | 'left')[], memory: ZoneMemory = restingZone, held = false) {
  return places.map((place) => {
    memory = place === 'left' ? leftZone(memory) : movedZone(memory, place, held)
    return memory.state
  })
}

test('where the pointer came from decides, and the decision holds across the zone', () => {
  // From the canvas into the minimap, across the gap, onto the toolbar: engaged throughout.
  assert.deepEqual(walk([canvas, control, control, control]), [
    'idle',
    'engaged',
    'engaged',
    'engaged',
  ])
  // From the focused terminal: yielding, and still yielding where the zone leaves the terminal.
  assert.deepEqual(walk([terminal, control, control]), ['idle', 'yielding', 'yielding'])
})

test('a pointer leaves the zone only past its margin, or when a held button is released', () => {
  assert.deepEqual(walk([terminal, control, edge, control, canvas]), [
    'idle',
    'yielding',
    'yielding',
    'yielding',
    'idle',
  ])
  // Out and back in from outside the terminal engages it.
  assert.deepEqual(walk([terminal, control, canvas, control]), [
    'idle',
    'yielding',
    'idle',
    'engaged',
  ])
  // Dragging out of the zone keeps it engaged until the release.
  const engaged = { state: 'engaged', fromTerminal: false } as const
  assert.deepEqual(walk([canvas, canvas], engaged, true), ['engaged', 'engaged'])
  assert.deepEqual(walk([canvas], engaged), ['idle'])
})

test("with nothing to yield to, the controls are the pointer's own", () => {
  const clear = { ...control, yieldable: false }
  assert.deepEqual(walk([terminal, clear]), ['idle', 'engaged'])
  // The terminal lost focus under a yielding zone: the next move engages it.
  assert.deepEqual(walk([terminal, control, clear]), ['idle', 'yielding', 'engaged'])
})

test('a window opening under a still pointer changes nothing shown', () => {
  // An input method's candidates over the pointer report it leaving the page; they close and
  // the browser reports the same place again.
  for (const [before, at] of [
    [[terminal], terminal],
    [[terminal, control], control],
    [[canvas, control], control],
  ] as const) {
    let memory = restingZone
    for (const place of before) memory = movedZone(memory, place, false)
    const shown = zoneLook(memory, at === terminal)
    memory = leftZone(memory)
    assert.equal(zoneLook(memory, at === terminal), shown, 'leaving changes nothing shown')
    memory = movedZone(memory, at, false)
    assert.equal(
      zoneLook(memory, at === terminal),
      shown,
      'coming back to the same place changes nothing',
    )
  }
})

test('what comes in after leaving the page comes from outside', () => {
  // On the terminal, out of the window, and back straight into the zone: engaged.
  assert.deepEqual(walk([terminal, 'left', control]), ['idle', 'idle', 'engaged'])
})

test('how the controls look follows the zone, and at rest the pointer on a covered terminal', () => {
  assert.equal(zoneLook(restingZone, false), undefined)
  assert.equal(zoneLook(restingZone, true), 'covering')
  assert.equal(zoneLook({ state: 'yielding', fromTerminal: false }, false), 'yielding')
  assert.equal(zoneLook({ state: 'engaged', fromTerminal: false }, true), 'engaged')
})
