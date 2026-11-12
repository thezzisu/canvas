import type { CanvasViewport } from '../../composables/mobile-layout'
import { retainPage, type OverviewPage } from './overview-paging'

export interface CanvasCamera {
  x: number
  y: number
  zoom: number
}
/** Overview lists every native window; the working set is a ring of the recently used ones. */
export const systemCanvases = ['overview', 'working-set'] as const
export type SystemCanvas = (typeof systemCanvases)[number]
export interface CanvasLocation {
  instance: string
  canvas: string
  camera?: CanvasCamera
  /** Overview's window-by-window mode; the working set is always shown this way. */
  view?: 'paged'
  page?: string
}
export interface CameraFrame {
  width: number
  height: number
}
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const uuid = new RegExp(`^${uuidPattern}$`, 'i')
/** Route parameter patterns: a saved instance, and a system or custom canvas. */
export const instancePattern = uuidPattern
export const canvasPattern = `${systemCanvases.join('|')}|${uuidPattern}`
export const isSystemCanvas = (canvas: string): canvas is SystemCanvas =>
  (systemCanvases as readonly string[]).includes(canvas)
const coordinate = (value: number) => Number.isFinite(value) && Math.abs(value) <= 1e8
const validFrame = (frame: CameraFrame) =>
  Number.isFinite(frame.width) &&
  Number.isFinite(frame.height) &&
  frame.width > 0 &&
  frame.height > 0
const validCamera = (camera: CanvasCamera) =>
  coordinate(camera.x) &&
  coordinate(camera.y) &&
  Number.isFinite(camera.zoom) &&
  camera.zoom >= 0.08 &&
  camera.zoom <= 2
const pages = (canvas: string, view?: string) =>
  canvas === 'working-set' || (canvas === 'overview' && view === 'paged')

/** The view within a canvas, as URL query values. Identity stays in the route's path. */
export function locationQuery(location: CanvasLocation): Record<string, string> {
  const query: Record<string, string> = {}
  if (location.camera && validCamera(location.camera)) {
    const { x, y, zoom } = location.camera
    query.center = `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`
    query.zoom = String(Math.round(zoom * 10000) / 10000)
  }
  if (location.canvas === 'overview' && location.view === 'paged') query.view = 'paged'
  if (location.page && pages(location.canvas, location.view)) query.page = location.page
  return query
}

/** The app's hash route for a location; the router's canvas route parses the same shape. */
export function canvasHref(location: CanvasLocation): string {
  const query = new URLSearchParams(locationQuery(location)).toString()
  return `#/i/${location.instance}/${location.canvas}${query ? `?${query}` : ''}`
}

/** Query values come from a shared or edited URL: anything malformed is ignored. */
export function parseLocation(
  instance: string,
  canvas: string,
  query: Readonly<Record<string, unknown>> = {},
): CanvasLocation | undefined {
  if (!uuid.test(instance) || !(isSystemCanvas(canvas) || uuid.test(canvas))) return
  const location: CanvasLocation = {
    instance: instance.toLowerCase(),
    canvas: canvas.toLowerCase(),
  }
  const text = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : '')
  const center = text('center').split(','),
    zoom = text('zoom')
  if (center.length === 2 && center.every((value) => value.trim()) && zoom.trim()) {
    const camera = { x: Number(center[0]), y: Number(center[1]), zoom: Number(zoom) }
    if (validCamera(camera)) location.camera = camera
  }
  if (location.canvas === 'overview' && text('view') === 'paged') location.view = 'paged'
  const page = text('page')
  if (
    page &&
    page.length <= 600 &&
    !/[\x00-\x1f\x7f]/u.test(page) &&
    pages(location.canvas, location.view)
  )
    location.page = page
  return location
}

/** Store world coordinates, so opening the URL on a different screen keeps its center. */
export function cameraFromViewport(
  viewport: CanvasViewport,
  frame: CameraFrame,
): CanvasCamera | undefined {
  if (
    !validFrame(frame) ||
    !Number.isFinite(viewport.zoom) ||
    viewport.zoom < 0.08 ||
    viewport.zoom > 2
  )
    return
  const camera = {
    x: (frame.width / 2 - viewport.x) / viewport.zoom,
    y: (frame.height / 2 - viewport.y) / viewport.zoom,
    zoom: viewport.zoom,
  }
  return validCamera(camera) ? camera : undefined
}
export function viewportFromCamera(
  camera: CanvasCamera,
  frame: CameraFrame,
): CanvasViewport | undefined {
  if (!validCamera(camera) || !validFrame(frame)) return
  return {
    x: frame.width / 2 - camera.x * camera.zoom,
    y: frame.height / 2 - camera.y * camera.zoom,
    zoom: camera.zoom,
  }
}

/** A removed canvas falls back to Overview. */
export function resolveCanvasLocation(
  location: CanvasLocation,
  canvasIds: readonly string[],
): CanvasLocation {
  return isSystemCanvas(location.canvas) || canvasIds.includes(location.canvas)
    ? location
    : { instance: location.instance, canvas: 'overview' }
}

/** A filtered or removed page falls back near its saved center without changing filters. */
export function restoreCanvasPage(
  location: CanvasLocation,
  pages: readonly OverviewPage[],
  frame: CameraFrame,
): OverviewPage | undefined {
  const exact = pages.find((page) => page.id === location.page)
  if (exact) return exact
  const windows = pages.filter((page) => !page.id.startsWith('create-'))
  const viewport = location.camera ? viewportFromCamera(location.camera, frame) : undefined
  return retainPage(windows.length ? windows : pages, '', undefined, viewport, frame)
}

type LocationStore = Pick<Storage, 'getItem' | 'setItem'>
const storageKey = (instance: string, canvas: string) => `canvas:view:${instance}:${canvas}`
const lastCanvasKey = (instance: string) => `canvas:last-canvas:${instance}`
function recall(storage: Pick<Storage, 'getItem'>, key: string, instance: string, canvas: string) {
  try {
    const saved: unknown = JSON.parse(storage.getItem(key) || 'null')
    if (saved && typeof saved === 'object')
      return parseLocation(instance, canvas, saved as Record<string, unknown>)
  } catch {
    /* A neutral view remains usable without browser storage. */
  }
}

/** Each canvas keeps its last view; its free camera survives a visit to the paged mode. */
export function rememberCanvasLocation(
  storage: Pick<LocationStore, 'setItem'>,
  location: CanvasLocation,
) {
  try {
    const view = JSON.stringify(locationQuery(location)),
      key = storageKey(location.instance, location.canvas)
    storage.setItem(key, view)
    if (!pages(location.canvas, location.view)) storage.setItem(`${key}:free`, view)
    storage.setItem(lastCanvasKey(location.instance), location.canvas)
  } catch {
    /* Navigation works when browser storage is full or unavailable. */
  }
}
export function recallCanvasLocation(
  storage: Pick<LocationStore, 'getItem'>,
  instance: string,
  canvas: string,
): CanvasLocation | undefined {
  return recall(storage, storageKey(instance, canvas), instance, canvas)
}
export function recallFreeCanvasLocation(
  storage: Pick<LocationStore, 'getItem'>,
  instance: string,
  canvas: string,
): CanvasLocation | undefined {
  const location = recall(storage, `${storageKey(instance, canvas)}:free`, instance, canvas)
  return location?.view ? undefined : location
}
/** Where this browser last was on an instance; Overview when it has never been there. */
export function recallLastCanvasLocation(
  storage: Pick<LocationStore, 'getItem'>,
  instance: string,
): CanvasLocation {
  let canvas = 'overview'
  try {
    canvas = storage.getItem(lastCanvasKey(instance)) || canvas
  } catch {
    /* A neutral startup remains usable without browser storage. */
  }
  return recallCanvasLocation(storage, instance, canvas) || { instance, canvas: 'overview' }
}
