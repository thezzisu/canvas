import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMobileLayout, touchViewport } from '../web/src/mobile-layout.ts'
import { canvasFrame, insetViewport, preserveCanvasCenter, viewportFrame } from '../web/src/viewport.ts'

test('mobile layout requires touch and primary coarse input, not a narrow desktop window', () => {
  const phone = { coarsePointer: true, noHover: true, touchPoints: 5, width: 390, screenWidth: 390, screenHeight: 844 }
  assert.equal(isMobileLayout(phone), true)
  assert.equal(isMobileLayout({ ...phone, width: 844 }), true)
  assert.equal(isMobileLayout({ ...phone, coarsePointer: false }), false)
  assert.equal(isMobileLayout({ ...phone, noHover: false }), false)
  assert.equal(isMobileLayout({ ...phone, touchPoints: 0 }), false)
  assert.equal(isMobileLayout({ ...phone, width: 1920, screenWidth: 1920, screenHeight: 1080 }), false)
  assert.equal(isMobileLayout({ ...phone, width: 1194, screenWidth: 834, screenHeight: 1194 }), true)
})

test('visible viewport retains keyboard height and browser pan offsets with a layout fallback', () => {
  const layout = { width: 390, height: 844 }
  assert.deepEqual(viewportFrame(layout, { width: 390, height: 410, offsetTop: 36, offsetLeft: 0 }),
    { width: 390, height: 410, top: 36, left: 0 })
  assert.deepEqual(viewportFrame(layout), { width: 390, height: 844, top: 0, left: 0 })
  assert.deepEqual(viewportFrame(layout, { width: NaN, height: 0, offsetTop: -2, offsetLeft: NaN }),
    { width: 390, height: 844, top: 0, left: 0 })
  // resizes-content shrinks both viewports; browsers without that policy can
  // still report the remaining space through visualViewport alone.
  const keyboard = { width: 390, height: 410, offsetTop: 0, offsetLeft: 0 }
  assert.deepEqual(viewportFrame({ width: 390, height: 410 }, keyboard), viewportFrame(layout, keyboard))
})

test('IME calibration reduces only usable height without changing raw geometry or compounding', () => {
  const visual = { width: 384, height: 535.47, offsetTop: 0, offsetLeft: 0 }
  const frame = viewportFrame({ width: 384, height: 823 }, visual)
  assert.deepEqual(insetViewport(frame, 15), { width: 384, height: 520.47, top: 0, left: 0 })
  assert.deepEqual(insetViewport(frame, 0), frame)
  assert.equal(frame.height, visual.height, 'raw and held frames stay unmodified')
  assert.deepEqual(insetViewport({ ...frame, top: 30, left: 2 }, 48), { width: 384, height: 487.47, top: 30, left: 2 })
  assert.equal(insetViewport({ ...frame, height: 30 }, 48).height, 1)
})

test('IME calibration leaves the saved canvas frame unchanged', t => {
  const before = new Map(['window', 'getComputedStyle'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  t.after(() => { for (const [name, descriptor] of before) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  } })
  let inset = 0
  const app = { clientWidth: 384, clientHeight: 535, classList: { contains: () => true } }
  const surface = { clientWidth: 384, clientHeight: 491, closest: () => app }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 384, innerHeight: 823, visualViewport: { width: 384, height: 535.47 } } })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ getPropertyValue: () => String(inset) }) })
  const frame = canvasFrame(surface as unknown as HTMLElement)
  inset = 15; app.clientHeight -= inset; surface.clientHeight -= inset
  assert.deepEqual(canvasFrame(surface as unknown as HTMLElement), frame)
})

test('touch navigation pans in screen pixels and pinches around the moving two-finger midpoint', () => {
  const view = { x: 20, y: -30, zoom: .5 }
  assert.deepEqual(touchViewport(view, { x: 100, y: 120 }, { x: 130, y: 145 }, 0, 0), { x: 50, y: -5, zoom: .5 })
  const zoomed = touchViewport(view, { x: 100, y: 120 }, { x: 110, y: 140 }, 80, 160)
  assert.deepEqual(zoomed, { x: -50, y: -160, zoom: 1 })
  assert.equal((110 - zoomed.x) / zoomed.zoom, (100 - view.x) / view.zoom)
  assert.equal((140 - zoomed.y) / zoomed.zoom, (120 - view.y) / view.zoom)
  assert.equal(touchViewport(view, { x: 0, y: 0 }, { x: 0, y: 0 }, 1, 1000).zoom, 2)
})

test('layout rotation preserves the world center for visible and restored canvas cameras', () => {
  const portrait = { layoutWidth: 390, width: 390, height: 800 }
  const landscape = { layoutWidth: 844, width: 844, height: 346 }
  const camera = { x: -110, y: 27, zoom: .6 }
  const expected = { x: 117, y: -200, zoom: .6 }
  const worldCenter = (view: typeof camera, frame: typeof portrait) => ({
    x: (frame.width / 2 - view.x) / view.zoom, y: (frame.height / 2 - view.y) / view.zoom,
  })
  assert.deepEqual(preserveCanvasCenter(camera, portrait, landscape), expected)
  // Restoring a camera after focused-terminal rotation uses its saved frame.
  const saved = JSON.parse(JSON.stringify({ ...camera, frame: portrait }))
  assert.deepEqual(preserveCanvasCenter(saved, saved.frame, landscape), expected)
  assert.deepEqual(worldCenter(expected, landscape), worldCenter(camera, portrait))
  // Fullscreen exit restores the pre-entry camera in the new normal frame.
  assert.deepEqual(preserveCanvasCenter(camera, portrait, landscape), expected)
  assert.deepEqual(preserveCanvasCenter(expected, landscape, portrait), camera)
})

test('keyboard height changes and legacy viewport records never move the camera', () => {
  const camera = { x: 20, y: 40, zoom: .8 }
  const before = { layoutWidth: 390, width: 390, height: 800 }
  const keyboard = { layoutWidth: 390, width: 390, height: 380 }
  assert.equal(preserveCanvasCenter(camera, before, keyboard), camera)
  assert.equal(preserveCanvasCenter(camera, undefined, before), camera)
  assert.equal(preserveCanvasCenter(camera, { width: 'invalid' }, before), camera)
})
