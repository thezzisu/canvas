import test from 'node:test'
import assert from 'node:assert/strict'
import { adjacentPage, pageViewport, pageDragOffset, PageWheelGesture, retainPage, swipePage, type OverviewPage } from '../web/src/overview-paging.ts'

const page = (id: string, row: string, x: number, y: number, width = 800, height = 450): OverviewPage => ({ id, row, x, y, width, height })
const pages = [page('a', 'one', 0, 0), page('b', 'one', 820, 0), page('c', 'one', 1640, 0),
  page('d', 'two', 0, 520), page('e', 'two', 820, 520), page('f', 'three', 0, 1040, 1200)]

test('overview paging moves within a space horizontally and to the closest column vertically without wrapping', () => {
  assert.equal(adjacentPage(pages, 'b', 'left')?.id, 'a')
  assert.equal(adjacentPage(pages, 'b', 'right')?.id, 'c')
  assert.equal(adjacentPage(pages, 'b', 'down')?.id, 'e')
  assert.equal(adjacentPage(pages, 'c', 'down')?.id, 'e')
  assert.equal(adjacentPage(pages, 'e', 'up')?.id, 'b')
  assert.equal(adjacentPage(pages, 'e', 'down')?.id, 'f')
  assert.equal(adjacentPage(pages, 'a', 'left'), undefined)
  assert.equal(adjacentPage(pages, 'c', 'right'), undefined)
  assert.equal(adjacentPage(pages, 'a', 'up'), undefined)
  assert.equal(adjacentPage(pages, 'f', 'down'), undefined)
  assert.equal(adjacentPage(pages, 'missing', 'down'), undefined)
  assert.equal(adjacentPage([], 'a', 'right'), undefined)
})

test('vertical paging retains the preferred column through short rows and returns to the original window', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, column) => page(`long-${column}`, 'long', column * 820, 0)),
    ...Array.from({ length: 2 }, (_, column) => page(`short-${column}`, 'short', column * 820, 520)),
    page('single', 'single', 0, 1040),
    ...Array.from({ length: 5 }, (_, column) => page(`last-${column}`, 'last', column * 820, 1560)),
  ]
  const preferred = rows[3]!.x + rows[3]!.width / 2
  assert.equal(adjacentPage(rows, 'long-3', 'down', preferred)?.id, 'short-1')
  assert.equal(adjacentPage(rows, 'short-1', 'up', preferred)?.id, 'long-3')
  assert.equal(adjacentPage(rows, 'short-1', 'down', preferred)?.id, 'single')
  assert.equal(adjacentPage(rows, 'single', 'down', preferred)?.id, 'last-3')
  assert.equal(adjacentPage(rows, 'last-3', 'up', preferred)?.id, 'single')
  assert.equal(adjacentPage(rows, 'single', 'up', preferred)?.id, 'short-1')
  assert.equal(adjacentPage(rows, 'long-3', 'up', preferred), undefined)
})

test('a fresh horizontal target replaces the preferred column and vertical alignment uses card centers', () => {
  const preferred = pages[2]!.x + pages[2]!.width / 2
  const horizontal = adjacentPage(pages, 'e', 'left', preferred)!
  assert.equal(horizontal.id, 'd', 'a stored vertical goal never overrides horizontal neighbors')
  assert.equal(adjacentPage(pages, horizontal.id, 'up', horizontal.x + horizontal.width / 2)?.id, 'a')
  const unequal = [page('wide', 'one', 0, 0, 1600), page('narrow', 'two', 0, 520, 200), page('aligned', 'two', 400, 520, 800)]
  assert.equal(adjacentPage(unequal, 'wide', 'down', 800)?.id, 'aligned')
  assert.equal(adjacentPage(unequal, 'wide', 'down', 0)?.id, 'narrow', 'a zero-coordinate goal is retained')
  assert.equal(adjacentPage(pages.filter(value => value.id !== 'c'), 'e', 'up', preferred)?.id, 'b', 'removed destination clamps to the closest surviving card')
})

test('overview paging retains window identity through sorting and space moves, and chooses a nearby survivor after filtering', () => {
  const reordered = [pages[2]!, pages[0]!, pages[1]!, ...pages.slice(3)]
  assert.equal(retainPage(reordered, 'b')?.id, 'b')
  const moved = pages.map(value => value.id === 'b' ? { ...value, row: 'three', y: 1040 } : value)
  assert.equal(retainPage(moved, 'b')?.row, 'three')
  assert.equal(retainPage(pages.filter(value => value.id !== 'b'), 'b', pages[1])?.id, 'a')
  assert.equal(retainPage(pages.slice(3), 'b', pages[1])?.id, 'e')
  assert.equal(retainPage([], 'b', pages[1]), undefined)
})

test('enabling paging starts with the window nearest the current camera center', () => {
  assert.equal(retainPage(pages, '', undefined, { x: -800, y: -400, zoom: 1 }, { width: 800, height: 600 })?.id, 'e')
  assert.equal(retainPage(pages, '')?.id, 'a')
})

test('page fitting centers the whole window with breathing room and never changes native dimensions', () => {
  const window = page('large', 'one', 320, 420, 1200, 720), original = { ...window }
  for (const frame of [{ width: 1366, height: 900 }, { width: 390, height: 744 }, { width: 844, height: 340 }]) {
    const view = pageViewport(window, frame)
    assert.ok(Math.abs((window.x + window.width / 2) * view.zoom + view.x - frame.width / 2) < 1e-8)
    assert.ok(Math.abs((window.y + window.height / 2) * view.zoom + view.y - frame.height / 2) < 1e-8)
    assert.ok(window.width * view.zoom < frame.width)
    assert.ok(window.height * view.zoom < frame.height)
    assert.ok(view.zoom <= 2)
  }
  assert.deepEqual(window, original)
  assert.equal(pageViewport(page('small', 'one', 0, 0, 300, 200), { width: 1366, height: 900 }).zoom, 2)
})

test('wheel gesture threshold ignores jitter and its entire momentum tail advances only once', () => {
  const wheel = new PageWheelGesture()
  assert.equal(wheel.consume(2, 10, 0), undefined)
  assert.equal(wheel.consume(-3, 12, 16), undefined)
  assert.equal(wheel.consume(1, 32, 32), 'down')
  for (let now = 48; now <= 1500; now += 16) assert.equal(wheel.consume(0, Math.max(1, 90 - now / 20), now), undefined)
  assert.equal(wheel.consume(-70, 3, 1800), 'left')
  assert.equal(wheel.consume(0, -100, 1816), undefined)
  assert.equal(wheel.consume(0, -100, 2100), 'up')
})

test('wheel gesture rejects oscillation below threshold and blocked pinch tails', () => {
  const wheel = new PageWheelGesture()
  for (let now = 0; now < 100; now += 10) assert.equal(wheel.consume(10 * (now % 20 ? 1 : -1), 0, now), undefined)
  wheel.block(100)
  assert.equal(wheel.consume(0, 90, 110), undefined)
  assert.equal(wheel.consume(60, 0, 400), 'right')
  wheel.reset()
  assert.equal(wheel.consume(0, 48, 410), 'down')
})

test('touch swipes use the dominant direction and taps or short drags do not advance', () => {
  assert.equal(swipePage(8, 12), undefined)
  assert.equal(swipePage(-65, 22), 'right')
  assert.equal(swipePage(65, -22), 'left')
  assert.equal(swipePage(-22, -65), 'down')
  assert.equal(swipePage(22, 65), 'up')
})


test('small drag feedback follows its signed axis while edge and long-pull feedback stay bounded', () => {
  assert.deepEqual(pageDragOffset(8, 1, 800, false), { x: -8, y: 0 })
  assert.deepEqual(pageDragOffset(-20, 2, 800, false), { x: 20, y: 0 })
  assert.deepEqual(pageDragOffset(1, -18, 600, false), { x: 0, y: 18 })
  let last = 0
  for (const distance of [1, 8, 28, 48, 120, 500, 10000]) {
    const edge = -pageDragOffset(distance, 0, 800, true).x
    assert(edge > last && edge < distance && edge <= 48)
    last = edge
  }
  const longPull = -pageDragOffset(10000, 0, 800, false).x
  assert(longPull > 120 && longPull <= 162)
})

test('a wheel gesture locks one axis and reverses net displacement without diagonal flips', () => {
  const wheel = new PageWheelGesture()
  assert.equal(wheel.consume(8, 2, 0), undefined)
  assert.deepEqual(wheel.displacement, { x: 8, y: 0 })
  assert.equal(wheel.consume(0, 90, 16), undefined)
  assert.deepEqual(wheel.displacement, { x: 8, y: 0 })
  assert.equal(wheel.consume(-20, 0, 32), undefined)
  assert.deepEqual(wheel.displacement, { x: -12, y: 0 })
  assert.equal(wheel.consume(-40, 0, 48), 'left')
  assert.equal(wheel.pending, false)
  assert.equal(wheel.isIdle(300), true)
  assert.equal(wheel.consume(0, 12, 300), undefined)
  assert.deepEqual(wheel.displacement, { x: 0, y: 12 })
  assert.equal(wheel.pending, true)
})


test('cancellation consumes existing momentum without postponing the next independent gesture', () => {
  const wheel = new PageWheelGesture()
  wheel.consume(20, 0, 0)
  wheel.block()
  assert.equal(wheel.consume(8, 0, 50), undefined)
  assert.equal(wheel.pending, false)
  assert.equal(wheel.isIdle(300), true)
  assert.equal(wheel.consume(12, 0, 300), undefined)
  assert.equal(wheel.pending, true)
  assert.deepEqual(wheel.displacement, { x: 12, y: 0 })
})

test('renewed trackpad acceleration advances again without waiting for its old tail to end', () => {
  const wheel = new PageWheelGesture(), directions: string[] = []
  let now = 0
  const feed = (values: number[]) => {
    for (const value of values) {
      const direction = wheel.consume(value, 0, now += 16)
      if (direction) directions.push(direction)
    }
  }
  feed([20, 24, 6, 100, 80, 50, 25, 10, 4, 1, 1, 1])
  assert.deepEqual(directions, ['right'], 'acceleration after the first threshold is still the same stroke')
  feed([8, 16, 24, 40, 30, 10, 3, 1])
  assert.deepEqual(directions, ['right', 'right'], 'a fresh pulse after decay commits at its accumulated threshold')
  feed([-12, -16, -20])
  assert.deepEqual(directions, ['right', 'right', 'left'], 'clear reversal does not require a quiet gap')
  feed([-16, -12, -8, -4, -1, ...Array(500).fill(-1)])
  assert.deepEqual(directions, ['right', 'right', 'left'], 'even a long momentum tail cannot create another page')
})

test('tail noise and isolated acceleration cannot accumulate weak inertia into a new stroke', () => {
  const wheel = new PageWheelGesture()
  let now = 0
  assert.equal(wheel.consume(60, 0, now), 'right')
  for (const value of [40, 20, 8, 2, 1, 3, 1, 5, 2, 1, 8, 1, ...Array(100).fill(1)]) {
    assert.equal(wheel.consume(value, 0, now += 16), undefined)
  }
  for (const value of [8, 16]) assert.equal(wheel.consume(value, 0, now += 16), undefined)
  assert.equal(wheel.consume(24, 0, now += 16), 'right')
})

test('reversal must reach the threshold continuously and resets when the original direction returns', () => {
  const wheel = new PageWheelGesture()
  let now = 0
  assert.equal(wheel.consume(60, 0, now), 'right')
  for (const value of [-20, -20, 1, -20, -20]) assert.equal(wheel.consume(value, 0, now += 16), undefined)
  assert.equal(wheel.consume(-8, 0, now += 16), 'left')
})

test('a new axis is accepted only after the committed stroke has decayed', () => {
  const wheel = new PageWheelGesture()
  let now = 0
  assert.equal(wheel.consume(48, 0, now), 'right')
  for (const value of [16, 16, 32]) assert.equal(wheel.consume(0, value, now += 16), undefined, 'original axis stays locked')
  for (const value of [30, 16, 8, 2]) assert.equal(wheel.consume(value, 0, now += 16), undefined)
  for (const value of [8, 16]) assert.equal(wheel.consume(0, value, now += 16), undefined)
  assert.equal(wheel.consume(0, 24, now += 16), 'down')
  assert.equal(wheel.consume(60, 0, now += 16), undefined, 'the new stroke establishes its own axis lock')
})

test('hard cancellation ignores reversal and acceleration until an actual quiet gap', () => {
  const wheel = new PageWheelGesture()
  let now = 0
  assert.equal(wheel.consume(60, 0, now), 'right')
  wheel.block()
  for (const value of [40, 20, 8, 2, 1, 8, 16, 24, -60, 100]) assert.equal(wheel.consume(value, 0, now += 16), undefined)
  assert.equal(wheel.consume(60, 0, now += 300), 'right')
})

test('zero movement never starts or prolongs a wheel gesture', () => {
  const wheel = new PageWheelGesture()
  assert.equal(wheel.consume(0, 0, 0), undefined)
  assert.equal(wheel.pending, false)
  assert.equal(wheel.consume(60, 0, 10), 'right')
  for (let now = 26; now < 1000; now += 16) assert.equal(wheel.consume(0, 0, now), undefined)
  assert.equal(wheel.consume(60, 0, 1000), 'right')
})
