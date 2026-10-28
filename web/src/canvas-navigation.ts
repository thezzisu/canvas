import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { terminalConsumesWheel } from './terminals'

type Viewport = { x: number; y: number; zoom: number }
export function useCanvasNavigation(options: {
  getCanvasId(): string
  getViewport(): Viewport
  setViewport(viewport: Viewport): Promise<unknown>
  saveViewport(): void
  blocked(): boolean
  beforeFullscreen(): void
}) {
  const surface = ref<HTMLElement>()
  const app = ref<HTMLElement>()
  const fullscreen = ref(false)
  let previous: { canvasId: string; viewport: Viewport; width: number; height: number } | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let changing = false

  function wheel(event: WheelEvent) {
    if (options.blocked() || !surface.value) return
    // Editors retain ordinary text scrolling; pinch remains a canvas gesture.
    if (!event.ctrlKey && (event.target as HTMLElement)?.closest('.note-content, .vue-flow__minimap, .canvas-toolbar')) return
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
    if (saved?.canvasId === options.getCanvasId()) await options.setViewport(saved.viewport)
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
      previous = { canvasId: options.getCanvasId(), viewport: { ...options.getViewport() }, width: surface.value.clientWidth, height: surface.value.clientHeight }
      fullscreen.value = true
      // Fullscreen API may be unavailable in embedded browsers. The same layout
      // remains usable as a page fullscreen, with an always-visible exit button.
      try { await app.value.requestFullscreen?.() } catch { /* page fullscreen */ }
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
  return { surface, app, fullscreen, wheel, toggleFullscreen, exitFullscreen }
}
