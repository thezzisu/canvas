import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref } from 'vue'
import { bindCanvasHistory, cameraFromViewport, formatCanvasLocation, parseCanvasLocation, recallCanvasLocation, recallFreeCanvasLocation, rememberCanvasLocation, resolveCanvasLocation, restoreCanvasPage, viewportFromCamera, type CanvasLocation } from '../web/src/canvas-location.ts'
import { useCanvasLocation } from '../web/src/use-canvas-location.ts'

const instance = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const canvas = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const location: CanvasLocation = { instance, canvas, camera: { x: -210.25, y: 380.75, zoom: .625 } }

function browser(initial = formatCanvasLocation(location)) {
  const listeners = new Map<string, Set<() => void>>()
  const entries = [initial]
  let index = 0
  const port = {
    location: { hash: initial },
    history: {
      state: { retained: true },
      pushState(_state: unknown, _title: string, url?: string | URL | null) { entries.splice(++index); entries.push(String(url)); port.location.hash = String(url) },
      replaceState(_state: unknown, _title: string, url?: string | URL | null) { entries[index] = String(url); port.location.hash = String(url) },
    },
    addEventListener(type: string, listener: () => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener) },
    removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener) },
    dispatch(type: string) { for (const listener of listeners.get(type) || []) listener() },
    go(delta: number) { index += delta; port.location.hash = entries[index]!; port.dispatch('popstate'); port.dispatch('hashchange') },
    entries,
  }
  return port
}
function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

test('canvas fragments preserve center, zoom and native page identities without endpoint data', () => {
  assert.deepEqual(parseCanvasLocation(formatCanvasLocation(location)), location)
  const paged: CanvasLocation = { ...location, canvas: 'overview', view: 'paged', page: `${other}/w:1/tab:日本語 #+?` }
  assert.deepEqual(parseCanvasLocation(formatCanvasLocation(paged)), paged)
  assert(!formatCanvasLocation(paged).includes('https:'))
  assert.deepEqual(parseCanvasLocation(formatCanvasLocation({ ...location, view: 'paged', page: 'unused' })), location)
  assert.equal(parseCanvasLocation('#instance=https://example.com&canvas=overview'), undefined)
  assert.equal(parseCanvasLocation(`#canvas=${canvas}`), undefined)
  assert.equal(parseCanvasLocation(`#instance=${instance}&canvas=../../other`), undefined)
})

test('malformed camera values never reach VueFlow while valid route identity remains usable', () => {
  for (const camera of ['center=NaN,5&zoom=1', 'center=Infinity,0&zoom=1', 'center=1&zoom=1', 'center=,1&zoom=1', 'center=1,2&zoom=0', 'center=1,2&zoom=3', 'center=1,2&zoom=', 'center=1e100,0&zoom=1']) {
    assert.deepEqual(parseCanvasLocation(`#instance=${instance}&canvas=overview&${camera}`), { instance, canvas: 'overview' })
  }
  assert.equal(parseCanvasLocation(`#instance=${instance}&canvas=overview&page=${'a'.repeat(5000)}`), undefined)
})

test('world center survives desktop to phone and landscape restoration without changing zoom', () => {
  const camera = cameraFromViewport({ x: -320, y: -180, zoom: .5 }, { width: 1200, height: 800 })!
  for (const frame of [{ width: 390, height: 700 }, { width: 844, height: 320 }, { width: 1600, height: 1000 }]) {
    const viewport = viewportFromCamera(camera, frame)!
    assert.deepEqual(cameraFromViewport(viewport, frame), camera)
  }
  assert.equal(viewportFromCamera(camera, { width: 0, height: 300 }), undefined)
  assert.equal(cameraFromViewport({ x: 0, y: 0, zoom: 0 }, { width: 390, height: 700 }), undefined)
})

test('saved camera and paging preferences are isolated by instance and canvas', () => {
  const store = storage()
  rememberCanvasLocation(store, location)
  const second: CanvasLocation = { instance: other, canvas, camera: { x: 40, y: 50, zoom: 1 } }
  rememberCanvasLocation(store, second)
  assert.deepEqual(recallCanvasLocation(store, instance, canvas), location)
  assert.deepEqual(recallCanvasLocation(store, other, canvas), second)
  assert.equal(recallCanvasLocation(store, instance, 'overview'), undefined)
  const free = { ...location, canvas: 'overview' }
  rememberCanvasLocation(store, free)
  const paged: CanvasLocation = { ...free, view: 'paged', page: 'native-window', camera: { x: 200, y: 400, zoom: .8 } }
  rememberCanvasLocation(store, paged)
  assert.deepEqual(recallCanvasLocation(store, instance, 'overview'), paged)
  assert.deepEqual(recallFreeCanvasLocation(store, instance, 'overview'), free, 'leaving paging can restore the previous free canvas camera')
})

test('paged restoration follows native identity or the nearest surviving window without changing filters', () => {
  const pages = [
    { id: 'first', row: 'a', x: 0, y: 0, width: 400, height: 300 },
    { id: 'second', row: 'b', x: 600, y: 500, width: 400, height: 300 },
    { id: 'create-a', row: 'b', x: 1100, y: 500, width: 400, height: 300 },
  ]
  const frame = { width: 390, height: 700 }
  const route: CanvasLocation = { instance, canvas: 'overview', view: 'paged', page: 'first', camera: { x: 810, y: 650, zoom: .8 } }
  assert.equal(restoreCanvasPage(route, pages, frame)?.id, 'first')
  assert.equal(restoreCanvasPage({ ...route, page: 'removed' }, pages, frame)?.id, 'second')
  assert.equal(restoreCanvasPage({ ...route, page: 'create-a' }, pages, frame)?.id, 'create-a')
  assert.equal(restoreCanvasPage(route, [], frame), undefined)
  assert.deepEqual(resolveCanvasLocation(location, [canvas]), location)
  assert.deepEqual(resolveCanvasLocation(location, []), { instance, canvas: 'overview' }, 'a deleted canvas does not apply its unrelated camera to overview')
})

test('camera moves replace history and back/forward restores one canvas step without duplicate events', () => {
  const port = browser(), seen: (CanvasLocation | undefined)[] = []
  const history = bindCanvasHistory(port, value => seen.push(value))
  history.read(); history.read()
  assert.equal(seen.length, 1)
  const moved = { ...location, camera: { x: 20, y: 30, zoom: 1 } }
  history.write(moved, 'replace')
  history.write({ instance, canvas: 'overview', view: 'paged', page: `${instance}/w:t1` }, 'push')
  history.write({ instance, canvas: 'overview', view: 'paged', page: `${instance}/w:t2` }, 'replace')
  assert.equal(port.entries.length, 2)
  port.go(-1)
  assert.deepEqual(seen.at(-1), moved)
  assert.equal(seen.length, 2)
  port.go(1)
  assert.equal(seen.at(-1)?.page, `${instance}/w:t2`)
  history.dispose(); port.go(-1)
  assert.equal(seen.length, 3)
})

test('navigation cannot select unknown instances or let a stale restore overwrite a newer request', t => {
  const unknown = '33333333-3333-4333-8333-333333333333'
  const port = browser(formatCanvasLocation({ instance: unknown, canvas: 'overview' }))
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: port })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage() })
  const scope = effectScope(), active = ref(instance), selected: string[] = []
  t.after(() => {
    scope.stop()
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window')
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  const navigation = scope.run(() => useCanvasLocation({ instanceId: active, hasInstance: id => [instance, other].includes(id), selectInstance: id => { selected.push(id); active.value = id } }))!
  navigation.read()
  assert.equal(navigation.unknownInstance.value, unknown)
  assert.deepEqual(selected, [])
  assert.equal(navigation.save(location), false)
  assert.equal(navigation.visit(unknown, canvas), false)
  assert(navigation.visit(instance, canvas))
  const first = navigation.requested.value!
  assert(navigation.visit(other, canvas))
  const second = navigation.requested.value!
  assert.deepEqual(selected, [other])
  assert.equal(navigation.restored(first, location), false)
  assert.equal(navigation.save({ ...location, instance: other }), false)
  assert(navigation.restored(second, { ...location, instance: other }))
  assert.equal(navigation.requested.value, undefined)
  assert.equal(navigation.save(location), false)
  assert(navigation.save({ ...location, instance: other, camera: { x: 1, y: 2, zoom: 1 } }))
})
