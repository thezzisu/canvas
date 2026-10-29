import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { terminalConsumesWheel } from './terminals'
import { touchViewport, type TouchPosition } from './mobile-layout'
import { canvasFrame, preserveCanvasCenter, type CanvasFrame } from './viewport'

type Viewport = { x: number; y: number; zoom: number }
export function useCanvasNavigation(options: {
  getCanvasId(): string
  getViewport(): Viewport
  setViewport(viewport: Viewport): Promise<unknown>
  saveViewport(): void
  blocked(): boolean
  beforeFullscreen(): void
  mobile(): boolean
}) {
  const surface = ref<HTMLElement>()
  const app = ref<HTMLElement>()
  const fullscreen = ref(false)
  let previous: { canvasId: string; viewport: Viewport; width: number; height: number; frame?: CanvasFrame } | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let changing = false
  let gesture: { count: number; viewport: Viewport; point: TouchPosition; distance: number } | undefined
  let moved = false
  let suppressClickUntil = 0
  let lastTouch: TouchPosition | undefined
  let editorScroll: { element: HTMLElement; point: TouchPosition; left: number; top: number } | undefined

  function touchPosition(touches: TouchList) {
    const box = surface.value!.getBoundingClientRect()
    const first = touches[0]!, second = touches[1]
    return { count: Math.min(2, touches.length), point: {
      x: (second ? (first.clientX + second.clientX) / 2 : first.clientX) - box.left,
      y: (second ? (first.clientY + second.clientY) / 2 : first.clientY) - box.top,
    }, distance: second ? Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY) : 0 }
  }
  function touchStart(event: TouchEvent) {
    if (!options.mobile() || options.blocked() || !surface.value || !event.touches.length) return
    const target = event.target instanceof Element ? event.target : undefined
    // A fresh touch is an independent tap, even immediately after panning.
    if (!gesture && event.touches.length === 1) suppressClickUntil = 0
    const editor = target?.closest<HTMLElement>('.note-content, .file-preview-text')
    if (!gesture && editor && event.touches.length === 1) {
      const first = event.touches[0]!
      editorScroll = { element: editor, point: { x: first.clientX, y: first.clientY }, left: editor.scrollLeft, top: editor.scrollTop }
      return
    }
    editorScroll = undefined
    if (!gesture && !target?.closest('.terminal-preview-button') &&
        target?.closest('button, a, input, select, .file-preview, .canvas-toolbar, .vue-flow__minimap')) return
    if (!gesture) moved = false
    gesture = { ...touchPosition(event.touches), viewport: { ...options.getViewport() } }
    if (gesture.count > 1) { moved = true; suppressClickUntil = performance.now() + 500 }
  }
  function touchMove(event: TouchEvent) {
    if (editorScroll && event.touches.length === 1) {
      const first = event.touches[0]!
      const dx = first.clientX - editorScroll.point.x, dy = first.clientY - editorScroll.point.y
      if (Math.hypot(dx, dy) >= 6) {
        event.preventDefault(); event.stopPropagation()
        editorScroll.element.scrollLeft = editorScroll.left - dx
        editorScroll.element.scrollTop = editorScroll.top - dy
      }
      return
    }
    if (!gesture || !options.mobile() || options.blocked() || !surface.value || !event.touches.length) return
    const current = touchPosition(event.touches)
    if (current.count !== gesture.count) {
      gesture = { ...current, viewport: { ...options.getViewport() } }
      return
    }
    if (!moved && current.count === 1 && Math.hypot(current.point.x - gesture.point.x, current.point.y - gesture.point.y) < 6) return
    moved = true
    suppressClickUntil = performance.now() + 500
    event.preventDefault()
    event.stopPropagation()
    void options.setViewport(touchViewport(gesture.viewport, gesture.point, current.point, gesture.distance, current.distance))
  }
  function touchEnd(event: TouchEvent) {
    if (!event.touches.length) editorScroll = undefined
    if (!gesture) return
    if (moved) {
      suppressClickUntil = performance.now() + 500
      const ended = event.changedTouches[0]
      if (ended) lastTouch = { x: ended.clientX, y: ended.clientY }
      clearTimeout(saveTimer)
      saveTimer = setTimeout(options.saveViewport, 160)
    }
    gesture = event.touches.length && surface.value
      ? { ...touchPosition(event.touches), viewport: { ...options.getViewport() } } : undefined
  }
  function touchCancel() {
    if (gesture && moved) options.saveViewport()
    gesture = undefined
    editorScroll = undefined
  }
  function click(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : undefined
    if (!target?.closest('.terminal-preview-button') && target?.closest('button, a, input, select, .canvas-toolbar')) return
    if (options.mobile() && event.detail > 0 && lastTouch && performance.now() < suppressClickUntil &&
        Math.hypot(event.clientX - lastTouch.x, event.clientY - lastTouch.y) < 24) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }

  function wheel(event: WheelEvent) {
    if (options.blocked() || !surface.value) return
    // Editors retain ordinary text scrolling; pinch remains a canvas gesture.
    if (!event.ctrlKey && (event.target as HTMLElement)?.closest('.note-content, .file-preview, .vue-flow__minimap, .canvas-toolbar')) return
    if (terminalConsumesWheel(event)) return
    event.preventDefault()
    event.stopPropagation()
    const box = surface.value.getBoundingClientRect()
    const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? box.height : 1
    const current = options.getViewport()
    if (event.ctrlKey) {
      const zoom = Math.max(.08, Math.min(2, current.zoom * 2 ** (-event.deltaY * unit * .02)))
      const scale = zoom / current.zoom
      const x = event.clientX - box.left, y = event.clientY - box.top
      void options.setViewport({ zoom, x: x - (x - current.x) * scale, y: y - (y - current.y) * scale })
    } else {
      const horizontal = event.shiftKey && !event.deltaX
      void options.setViewport({ ...current,
        x: current.x - (horizontal ? event.deltaY : event.deltaX) * unit,
        y: current.y - (horizontal ? 0 : event.deltaY) * unit })
    }
    clearTimeout(saveTimer)
    saveTimer = setTimeout(options.saveViewport, 160)
  }

  async function settle() {
    await nextTick()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
  async function restore() {
    if (!fullscreen.value) return
    const saved = previous
    previous = undefined
    fullscreen.value = false
    await settle()
    if (saved?.canvasId === options.getCanvasId()) {
      const frame = canvasFrame(surface.value)
      await options.setViewport(options.mobile() && frame ? preserveCanvasCenter(saved.viewport, saved.frame, frame) : saved.viewport)
    }
    options.saveViewport()
  }
  async function exitFullscreen() {
    try {
      if (document.fullscreenElement === app.value) await document.exitFullscreen()
    } catch { /* Removing the authenticated app can already end native fullscreen. */ }
    await restore()
  }
  async function toggleFullscreen() {
    if (changing) return
    changing = true
    try {
      if (fullscreen.value) { await exitFullscreen(); return }
      if (!surface.value || !app.value) return
      options.beforeFullscreen()
      previous = { canvasId: options.getCanvasId(), viewport: { ...options.getViewport() }, width: surface.value.clientWidth, height: surface.value.clientHeight,
        frame: options.mobile() ? canvasFrame(surface.value) : undefined }
      fullscreen.value = true
      // Fullscreen API may be unavailable in embedded browsers. The same layout
      // remains usable as a page fullscreen, with an always-visible exit button.
      if (!options.mobile()) {
        try { await app.value.requestFullscreen?.() } catch { /* page fullscreen */ }
      }
      await settle()
      if (previous && fullscreen.value) await options.setViewport({ ...previous.viewport,
        x: previous.viewport.x + (surface.value.clientWidth - previous.width) / 2,
        y: previous.viewport.y + (surface.value.clientHeight - previous.height) / 2 })
    } finally { changing = false }
  }
  function fullscreenChanged() {
    if (!document.fullscreenElement) void restore()
  }
  function escape(event: KeyboardEvent) {
    if (event.key === 'Escape' && fullscreen.value && !document.fullscreenElement && !options.blocked()) {
      event.preventDefault(); event.stopImmediatePropagation(); void restore()
    }
  }
  onMounted(() => {
    document.addEventListener('fullscreenchange', fullscreenChanged)
    window.addEventListener('keydown', escape, true)
  })
  onBeforeUnmount(() => {
    clearTimeout(saveTimer)
    document.removeEventListener('fullscreenchange', fullscreenChanged)
    window.removeEventListener('keydown', escape, true)
  })
  return { surface, app, fullscreen, wheel, touchStart, touchMove, touchEnd, touchCancel, click, toggleFullscreen, exitFullscreen }
}
