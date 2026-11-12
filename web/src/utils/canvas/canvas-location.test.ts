import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cameraFromViewport,
  canvasHref,
  locationQuery,
  parseLocation,
  recallCanvasLocation,
  recallFreeCanvasLocation,
  recallLastCanvasLocation,
  rememberCanvasLocation,
  resolveCanvasLocation,
  restoreCanvasPage,
  viewportFromCamera,
} from './canvas-location.ts'

const instance = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const canvas = '33333333-3333-4333-8333-333333333333'
function storage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

test('a view round-trips through its query: center, zoom and the paged window', () => {
  const location = {
    instance,
    canvas: 'overview',
    camera: { x: 120.456, y: -80.004, zoom: 0.75 },
    view: 'paged' as const,
    page: 'source/window 1',
  }
  const query = locationQuery(location)
  assert.deepEqual(query, {
    center: '120.46,-80',
    zoom: '0.75',
    view: 'paged',
    page: 'source/window 1',
  })
  assert.deepEqual(parseLocation(instance, 'overview', query), {
    ...location,
    camera: { x: 120.46, y: -80, zoom: 0.75 },
  })
  assert.equal(
    canvasHref({ instance, canvas }),
    `#/i/${instance}/${canvas}`,
    'a canvas without a camera has no query',
  )
})

test('only Overview can be paged by choice; the working set always names its window', () => {
  assert.deepEqual(locationQuery({ instance, canvas, view: 'paged', page: 'a/b' }), {})
  assert.deepEqual(locationQuery({ instance, canvas: 'working-set', page: 'a/b' }), { page: 'a/b' })
  assert.equal(parseLocation(instance, canvas, { view: 'paged', page: 'a/b' })?.page, undefined)
  assert.equal(parseLocation(instance, 'working-set', { page: 'a/b' })?.page, 'a/b')
})

test('malformed values are ignored while a valid identity remains usable', () => {
  assert.equal(parseLocation('not-an-instance', 'overview'), undefined)
  assert.equal(parseLocation(instance, 'elsewhere'), undefined)
  for (const query of [
    { center: '1', zoom: '1' },
    { center: 'NaN,2', zoom: '1' },
    { center: '1,2', zoom: '9' },
    { center: '1e9,2', zoom: '1' },
    { center: ['1,2'], zoom: '1' },
  ])
    assert.deepEqual(parseLocation(instance, canvas, query), { instance, canvas })
  assert.equal(
    parseLocation(instance, 'overview', { view: 'paged', page: 'a\u0000b' })?.page,
    undefined,
  )
})

test('a world-coordinate camera keeps its center on a differently sized screen', () => {
  const desktop = { width: 1600, height: 900 },
    phone = { width: 390, height: 780 }
  const camera = cameraFromViewport({ x: -200, y: 150, zoom: 0.5 }, desktop)!
  const viewport = viewportFromCamera(camera, phone)!
  assert.equal(viewport.zoom, 0.5)
  assert.deepEqual(cameraFromViewport(viewport, phone), camera)
  assert.equal(cameraFromViewport({ x: 0, y: 0, zoom: 5 }, desktop), undefined)
  assert.equal(viewportFromCamera(camera, { width: 0, height: 10 }), undefined)
})

test('each canvas remembers its view per instance; the free camera survives paged browsing', () => {
  const store = storage()
  const free = { instance, canvas: 'overview', camera: { x: 1, y: 2, zoom: 1 } }
  rememberCanvasLocation(store, free)
  rememberCanvasLocation(store, { ...free, view: 'paged', page: 'a/b' })
  rememberCanvasLocation(store, { instance: other, canvas, camera: { x: 9, y: 9, zoom: 2 } })
  assert.deepEqual(recallCanvasLocation(store, instance, 'overview'), {
    ...free,
    view: 'paged',
    page: 'a/b',
  })
  assert.deepEqual(recallFreeCanvasLocation(store, instance, 'overview'), free)
  assert.equal(recallCanvasLocation(store, instance, canvas), undefined)
  assert.equal(recallLastCanvasLocation(store, other).canvas, canvas)
})

test('an instance never visited, or with unreadable storage, starts at Overview', () => {
  assert.deepEqual(recallLastCanvasLocation(storage(), instance), { instance, canvas: 'overview' })
  const broken = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('full')
    },
  }
  rememberCanvasLocation(broken, { instance, canvas })
  assert.deepEqual(recallLastCanvasLocation(broken, instance), { instance, canvas: 'overview' })
  const corrupt = storage()
  corrupt.values.set(`canvas:view:${instance}:overview`, '{not json')
  assert.equal(recallCanvasLocation(corrupt, instance, 'overview'), undefined)
})

test('a removed canvas resolves to Overview; system canvases always exist', () => {
  assert.deepEqual(resolveCanvasLocation({ instance, canvas }, []), {
    instance,
    canvas: 'overview',
  })
  assert.equal(resolveCanvasLocation({ instance, canvas }, [canvas]).canvas, canvas)
  assert.equal(resolveCanvasLocation({ instance, canvas: 'working-set' }, []).canvas, 'working-set')
})

test('paged restoration follows the named window, else the nearest surviving one', () => {
  const page = (id: string, x: number) => ({ id, row: 'r', x, y: 0, width: 100, height: 100 })
  const pages = [page('a/1', 0), page('a/2', 1000), page('create-tab:a:s', 2000)]
  const frame = { width: 800, height: 600 }
  assert.equal(
    restoreCanvasPage({ instance, canvas: 'overview', page: 'a/2' }, pages, frame)?.id,
    'a/2',
  )
  assert.equal(
    restoreCanvasPage(
      { instance, canvas: 'overview', page: 'gone', camera: { x: 1900, y: 50, zoom: 1 } },
      pages,
      frame,
    )?.id,
    'a/2',
    'a create card is never the fallback while a window exists',
  )
})
