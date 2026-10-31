import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { isMobileLayout, touchViewport, type InputMode } from './mobile-layout.ts'
import { canvasFrame, preserveCanvasCenter, viewportFrame } from './viewport.ts'

test('automatic touch layout follows primary input capabilities regardless of display size', () => {
  const touch = { coarsePointer: true, noHover: true, touchPoints: 5 }
  for (const width of [320, 390, 1194, 1920, 3840]) {
    const screen = { width, screenWidth: width, screenHeight: width * 2 }
    assert.equal(isMobileLayout({ ...touch, ...screen }), true)
    assert.equal(isMobileLayout({ ...touch, ...screen, coarsePointer: false }), false)
    assert.equal(isMobileLayout({ ...touch, ...screen, noHover: false }), false)
    assert.equal(isMobileLayout({ ...touch, ...screen, touchPoints: 0 }), false)
  }
})

test('explicit input modes override capabilities and unknown preferences use automatic behavior', () => {
  const touch = { coarsePointer: true, noHover: true, touchPoints: 5 }
  const keyboard = { coarsePointer: false, noHover: false, touchPoints: 0 }
  assert.equal(isMobileLayout(touch, 'keyboard'), false)
  assert.equal(isMobileLayout(keyboard, 'touch'), true)
  assert.equal(isMobileLayout(touch, 'auto'), true)
  assert.equal(isMobileLayout(keyboard, 'auto'), false)
  assert.equal(isMobileLayout(touch, 'unexpected' as InputMode), true)
  assert.equal(isMobileLayout(keyboard, 'unexpected' as InputMode), false)
})

test('phone and tablet browser hints retain touch layout with a fine or hovering primary pointer', () => {
  const pointer = { coarsePointer: false, noHover: false, touchPoints: 5 }
  const devices = [
    { userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36' },
    { userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/152.0.0.0 Mobile Safari/537.36 Vivaldi/7.0' },
    { userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36' },
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
    { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' },
    { userAgent: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)' },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', platform: 'MacIntel' },
    { userAgentData: { mobile: true, platform: '' } },
    { userAgentData: { mobile: false, platform: 'Android' } },
    { userAgentData: { mobile: false, platform: 'iOS' } },
  ]
  for (const device of devices) {
    assert.equal(isMobileLayout({ ...pointer, ...device }), true, JSON.stringify(device))
    assert.equal(isMobileLayout({ ...pointer, ...device }, 'keyboard'), false)
    assert.equal(isMobileLayout({ ...pointer, ...device, touchPoints: 0 }), false, 'a user agent alone does not provide touch input')
  }
})

test('desktop and unrecognized device hints keep capability fallback without model or size guesses', () => {
  const fine = { coarsePointer: false, noHover: false, touchPoints: 10 }
  for (const device of [
    { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', userAgentData: { mobile: false, platform: 'Windows' } },
    { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64', userAgentData: { mobile: false, platform: 'Linux' } },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', platform: 'MacIntel', touchPoints: 0 },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', platform: 'MacIntel', userAgentData: { mobile: false, platform: 'macOS' } },
    { userAgent: 'Unknown', platform: 'Unknown' },
  ]) {
    assert.equal(isMobileLayout({ ...fine, ...device }), false)
    assert.equal(isMobileLayout({ ...fine, ...device }, 'touch'), true)
  }
  assert.equal(isMobileLayout({ ...fine, coarsePointer: true, noHover: true, userAgent: 'Unknown' }), true)
  assert.equal(isMobileLayout({ ...fine, touchPoints: 1, platform: 'MacIntel' }), false)
})

test('shared layout reacts to preferences and media changes, persists choices and releases its readers', () => {
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', String.raw`
    import assert from 'node:assert/strict'
    const values = new Map([['canvas:input-mode', 'invalid']])
    const storage = { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
    class Query extends EventTarget {
      matches = true
      listeners = new Set()
      addEventListener(type, listener, options) { this.listeners.add(listener); super.addEventListener(type, listener, options) }
      removeEventListener(type, listener, options) { this.listeners.delete(listener); super.removeEventListener(type, listener, options) }
      change(matches) { this.matches = matches; this.dispatchEvent(Object.assign(new Event('change'), { matches })) }
    }
    const coarse = new Query(), hover = new Query(), calls = []
    const window = Object.assign(new EventTarget(), { localStorage: storage,
      navigator: { maxTouchPoints: 5, userAgent: 'fixture' },
      matchMedia(query) { calls.push(query); return query === '(pointer: coarse)' ? coarse : hover } })
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: window },
      navigator: { configurable: true, value: window.navigator },
      document: { configurable: true, value: { createElement: () => ({}) } },
    })
    const { effectScope, nextTick } = await import('vue')
    const { useMobileLayout, inputMode } = await import(process.argv[1])
    assert.equal(inputMode.value, 'auto')
    const a = effectScope(), b = effectScope(), c = effectScope()
    const first = a.run(useMobileLayout), second = b.run(useMobileLayout), third = c.run(useMobileLayout)
    assert.equal(first, second); assert.equal(second, third)
    assert.deepEqual(calls, ['(pointer: coarse)', '(hover: none)'])
    assert.equal(first.value, true)
    inputMode.value = 'keyboard'; assert.equal(first.value, false)
    await nextTick(); assert.equal(values.get('canvas:input-mode'), 'keyboard')
    coarse.change(false); hover.change(false)
    inputMode.value = 'touch'; assert.equal(first.value, true)
    inputMode.value = 'auto'; assert.equal(first.value, false)
    coarse.change(true); assert.equal(first.value, false)
    hover.change(true); assert.equal(first.value, true)
    await nextTick()
    storage.setItem('canvas:input-mode', 'keyboard')
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'canvas:input-mode', newValue: 'keyboard', storageArea: storage }))
    await nextTick(); assert.equal(inputMode.value, 'keyboard'); assert.equal(first.value, false)
    storage.setItem('canvas:input-mode', 'invalid')
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'canvas:input-mode', newValue: 'invalid', storageArea: storage }))
    await nextTick(); assert.equal(inputMode.value, 'auto'); assert.equal(first.value, true)
    a.stop(); b.stop(); assert.equal(coarse.listeners.size, 1); assert.equal(hover.listeners.size, 1)
    c.stop(); assert.equal(coarse.listeners.size, 0); assert.equal(hover.listeners.size, 0)
  `, new URL('./mobile-layout.ts', import.meta.url).href], { cwd: process.cwd(), stdio: 'pipe' })
})

test('CSS content geometry ignores a visual viewport that subtracts the keyboard twice', () => {
  const layout = { width: 384, height: 487.2 }
  const visual = { width: 384, height: 199.2, offsetTop: 0, offsetLeft: 0 }
  assert.deepEqual(viewportFrame(layout, visual), { width: 384, height: 487.2, top: 0, left: 0 })
  assert.deepEqual(viewportFrame(layout, { ...visual, offsetTop: 36 }), { width: 384, height: 487.2, top: 0, left: 0 })
})

test('explicit visual geometry retains keyboard height and browser pan offsets with a CSS fallback', () => {
  const layout = { width: 384, height: 823.47 }
  const visual = { width: 384, height: 535.47, offsetTop: 36, offsetLeft: 0 }
  assert.deepEqual(viewportFrame(layout, visual, 'resizes-visual'), { width: 384, height: 535.47, top: 36, left: 0 })
  assert.deepEqual(viewportFrame(layout, undefined, 'resizes-visual'), { width: 384, height: 823.47, top: 0, left: 0 })
  assert.deepEqual(viewportFrame(layout, { width: NaN, height: 0, offsetTop: -2, offsetLeft: NaN }, 'resizes-visual'),
    { width: 384, height: 823.47, top: 0, left: 0 })
})

test('overlay geometry uses the CSS keyboard-inset result without subtracting visual occlusion again', () => {
  const measured = { width: 384, height: 520.8 }
  assert.deepEqual(viewportFrame(measured, { width: 384, height: 823.47, offsetTop: 0, offsetLeft: 0 }, 'overlays-content'),
    { width: 384, height: 520.8, top: 0, left: 0 })
  assert.deepEqual(viewportFrame(measured, { width: 384, height: 199.2, offsetTop: 34, offsetLeft: 0 }, 'overlays-content'),
    { width: 384, height: 520.8, top: 0, left: 0 })
})

test('canvas camera geometry uses its actual surface without visual viewport compensation', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window') })
  const window = { innerWidth: 384, innerHeight: 487, visualViewport: { width: 384, height: 199.2 } }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  const surface = { clientWidth: 384, clientHeight: 443 }
  assert.deepEqual(canvasFrame(surface as HTMLElement), { layoutWidth: 384, width: 384, height: 443 })
  window.visualViewport.height = 487.2
  assert.deepEqual(canvasFrame(surface as HTMLElement), { layoutWidth: 384, width: 384, height: 443 })
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
