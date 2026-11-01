import type { CanvasViewport } from './mobile-layout'
import { retainPage, type OverviewPage } from './overview-paging'

export interface CanvasCamera { x: number; y: number; zoom: number }
export interface CanvasLocation {
  instance: string
  canvas: string
  camera?: CanvasCamera
  view?: 'paged'
  page?: string
}
export interface CameraFrame { width: number; height: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const coordinate = (value: number) => Number.isFinite(value) && Math.abs(value) <= 1e8
const validFrame = (frame: CameraFrame) => Number.isFinite(frame.width) && Number.isFinite(frame.height) && frame.width > 0 && frame.height > 0
const validCamera = (camera: CanvasCamera) => coordinate(camera.x) && coordinate(camera.y) && Number.isFinite(camera.zoom) && camera.zoom >= .08 && camera.zoom <= 2

/** Fragment values identify saved instances; endpoints and credentials never belong here. */
export function parseCanvasLocation(hash: string): CanvasLocation | undefined {
  if (!hash.startsWith('#') || hash.length > 4096) return
  const params = new URLSearchParams(hash.slice(1))
  const instance = params.get('instance') || '', canvas = params.get('canvas') || ''
  if (!uuid.test(instance) || !(canvas === 'overview' || uuid.test(canvas))) return
  const location: CanvasLocation = { instance: instance.toLowerCase(), canvas: canvas.toLowerCase() }
  const center = params.get('center')?.split(','), zoom = params.get('zoom')
  if (center?.length === 2 && center.every(value => value.trim()) && zoom?.trim()) {
    const camera = { x: Number(center[0]), y: Number(center[1]), zoom: Number(zoom) }
    if (validCamera(camera)) location.camera = camera
  }
  if (canvas === 'overview' && params.get('view') === 'paged') {
    location.view = 'paged'
    const page = params.get('page')
    if (page && page.length <= 600 && !/[\x00-\x1f\x7f]/u.test(page)) location.page = page
  }
  return location
}

export function formatCanvasLocation(location: CanvasLocation): string {
  const params = new URLSearchParams({ instance: location.instance, canvas: location.canvas })
  if (location.camera && validCamera(location.camera)) {
    const { x, y, zoom } = location.camera
    params.set('center', `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`)
    params.set('zoom', String(Math.round(zoom * 10000) / 10000))
  }
  if (location.canvas === 'overview' && location.view === 'paged') {
    params.set('view', 'paged')
    if (location.page) params.set('page', location.page)
  }
  return `#${params}`
}

/** Store world coordinates, so opening the URL on a different screen keeps its center. */
export function cameraFromViewport(viewport: CanvasViewport, frame: CameraFrame): CanvasCamera | undefined {
  if (!validFrame(frame) || !Number.isFinite(viewport.zoom) || viewport.zoom < .08 || viewport.zoom > 2) return
  const camera = { x: (frame.width / 2 - viewport.x) / viewport.zoom, y: (frame.height / 2 - viewport.y) / viewport.zoom, zoom: viewport.zoom }
  return validCamera(camera) ? camera : undefined
}
export function viewportFromCamera(camera: CanvasCamera, frame: CameraFrame): CanvasViewport | undefined {
  if (!validCamera(camera) || !validFrame(frame)) return
  return { x: frame.width / 2 - camera.x * camera.zoom, y: frame.height / 2 - camera.y * camera.zoom, zoom: camera.zoom }
}

export function resolveCanvasLocation(location: CanvasLocation, canvasIds: readonly string[]): CanvasLocation {
  return location.canvas === 'overview' || canvasIds.includes(location.canvas) ? location : { instance: location.instance, canvas: 'overview' }
}

/** A filtered or removed page falls back near its saved center without changing filters. */
export function restoreCanvasPage(location: CanvasLocation, pages: readonly OverviewPage[], frame: CameraFrame): OverviewPage | undefined {
  const exact = pages.find(page => page.id === location.page)
  if (exact) return exact
  const windows = pages.filter(page => !page.id.startsWith('create-'))
  const viewport = location.camera ? viewportFromCamera(location.camera, frame) : undefined
  return retainPage(windows.length ? windows : pages, '', undefined, viewport, frame)
}

const storageKey = (instance: string, canvas: string) => `canvas:view:${instance}:${canvas}`
const lastCanvasKey = (instance: string) => `canvas:last-canvas:${instance}`
export function rememberCanvasLocation(storage: Pick<Storage, 'setItem'>, location: CanvasLocation) {
  try {
    const hash = formatCanvasLocation(location), key = storageKey(location.instance, location.canvas)
    storage.setItem(key, hash)
    if (!location.view) storage.setItem(`${key}:free`, hash)
    storage.setItem(lastCanvasKey(location.instance), location.canvas)
  } catch { /* Navigation works when browser storage is full or unavailable. */ }
}
export function recallLastCanvasLocation(storage: Pick<Storage, 'getItem'>, instance: string): CanvasLocation | undefined {
  try {
    const canvas = storage.getItem(lastCanvasKey(instance))
    if (canvas && (canvas === 'overview' || uuid.test(canvas))) return recallCanvasLocation(storage, instance, canvas)
  } catch { /* A neutral startup remains usable without browser storage. */ }
}
export function recallCanvasLocation(storage: Pick<Storage, 'getItem'>, instance: string, canvas: string): CanvasLocation | undefined {
  try {
    const location = parseCanvasLocation(storage.getItem(storageKey(instance, canvas)) || '')
    return location?.instance === instance && location.canvas === canvas ? location : undefined
  } catch { return undefined }
}
export function recallFreeCanvasLocation(storage: Pick<Storage, 'getItem'>, instance: string, canvas: string): CanvasLocation | undefined {
  try {
    const location = parseCanvasLocation(storage.getItem(`${storageKey(instance, canvas)}:free`) || '')
    return location?.instance === instance && location.canvas === canvas && !location.view ? location : undefined
  } catch { return undefined }
}

export interface CanvasHistoryBrowser {
  location: Pick<Location, 'hash'>
  history: Pick<History, 'state' | 'pushState' | 'replaceState'>
  addEventListener(type: 'popstate' | 'hashchange', listener: () => void): void
  removeEventListener(type: 'popstate' | 'hashchange', listener: () => void): void
}
/** A camera move replaces its entry; deliberate navigation creates one history step. */
export function bindCanvasHistory(browser: CanvasHistoryBrowser, changed: (location: CanvasLocation | undefined) => void) {
  let observed: string | undefined
  const read = () => {
    const hash = browser.location.hash
    if (hash === observed) return
    observed = hash
    changed(parseCanvasLocation(hash))
  }
  browser.addEventListener('popstate', read)
  browser.addEventListener('hashchange', read)
  return {
    read,
    write(location: CanvasLocation, mode: 'push' | 'replace') {
      const hash = formatCanvasLocation(location)
      if (hash === browser.location.hash) { observed = hash; return }
      browser.history[mode === 'push' ? 'pushState' : 'replaceState'](browser.history.state, '', hash)
      observed = hash
    },
    dispose() { browser.removeEventListener('popstate', read); browser.removeEventListener('hashchange', read) },
  }
}
