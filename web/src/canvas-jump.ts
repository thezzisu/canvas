import type { CanvasAnchor } from './use-canvas-location'

export type CanvasDirection = 'previous' | 'next'
export interface CanvasEntry { id: string; name: string }
interface Point { x: number; y: number }
interface Viewport extends Point { zoom: number }

/** The neighbour among the canvases holding a window, in sidebar order. */
export function adjacentCanvas(entries: readonly CanvasEntry[], current: string, direction: CanvasDirection): CanvasEntry | undefined {
  const index = entries.findIndex(entry => entry.id === current)
  return index < 0 ? undefined : entries[index + (direction === 'next' ? 1 : -1)]
}

/** Records where a window currently appears on screen. */
export function canvasAnchor(target: { sourceId: string; windowId: string }, position: Point, viewport: Viewport): CanvasAnchor {
  return { sourceId: target.sourceId, windowId: target.windowId,
    x: viewport.x + position.x * viewport.zoom, y: viewport.y + position.y * viewport.zoom, zoom: viewport.zoom }
}

/** The camera that shows a window at its anchored screen position and scale. */
export function anchoredViewport(anchor: CanvasAnchor, position: Point): Viewport {
  return { x: anchor.x - position.x * anchor.zoom, y: anchor.y - position.y * anchor.zoom, zoom: anchor.zoom }
}
