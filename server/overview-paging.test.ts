import test from 'node:test'
import assert from 'node:assert/strict'
import { adjacentPage, pageViewport, PageWheelGesture, retainPage, swipePage, type OverviewPage } from '../web/src/overview-paging.ts'

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
