import assert from 'node:assert/strict'
import test from 'node:test'
import { ringLayout, ringNeighbour } from './ring-layout.ts'

const card = (id: string, width = 800, height = 500) => ({ id, width, height })
const centre = (placed: { x: number; y: number; width: number; height: number }) => ({
  x: placed.x + placed.width / 2,
  y: placed.y + placed.height / 2,
})
const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('cards sit on one circle without touching, for any count', () => {
  for (const count of [1, 2, 3, 5, 12]) {
    const placed = ringLayout(Array.from({ length: count }, (_, index) => card(`w${index}`)))
    assert.equal(placed.length, count)
    for (const [index, a] of placed.entries())
      for (const b of placed.slice(index + 1)) assert.equal(overlaps(a, b), false, `${count}`)
    const radii = placed.map((item) => Math.hypot(centre(item).x, centre(item).y))
    for (const radius of radii) assert.ok(Math.abs(radius - radii[0]!) < 1e-6)
  }
})

test('mixed sizes still leave every card clear of its neighbours', () => {
  const placed = ringLayout([card('a', 1600, 900), card('b', 400, 300), card('c', 900, 1200)])
  assert.equal(overlaps(placed[0]!, placed[1]!), false)
  assert.equal(overlaps(placed[1]!, placed[2]!), false)
  assert.equal(overlaps(placed[2]!, placed[0]!), false)
})

test('a pinned card keeps its place while the others are re-ordered, added or removed', () => {
  const before = ringLayout([card('a'), card('b'), card('c'), card('d')])
  const held = centre(before.find((item) => item.id === 'c')!)
  const pin = { id: 'c', ...held }
  for (const order of [['c', 'a', 'b', 'd'], ['d', 'c'], ['a', 'b', 'c', 'd', 'e', 'f'], ['c']]) {
    const after = ringLayout(
      order.map((id) => card(id)),
      pin,
    )
    const kept = centre(after.find((item) => item.id === 'c')!)
    assert.ok(Math.abs(kept.x - held.x) < 1e-6 && Math.abs(kept.y - held.y) < 1e-6, order.join())
  }
})

test('a pin whose card left the ring is ignored', () => {
  assert.deepEqual(
    ringLayout([card('a'), card('b')], { id: 'gone', x: 5000, y: 5000 }),
    ringLayout([card('a'), card('b')]),
  )
})

test('neighbours wrap around the ring in both directions', () => {
  const cards = [card('a'), card('b'), card('c')]
  assert.equal(ringNeighbour(cards, 'c', 1)?.id, 'a')
  assert.equal(ringNeighbour(cards, 'a', -1)?.id, 'c')
  assert.equal(ringNeighbour(cards, 'b', 1)?.id, 'c')
  assert.equal(ringNeighbour([card('a')], 'a', 1), undefined)
  assert.equal(ringNeighbour(cards, 'missing', 1), undefined)
})
