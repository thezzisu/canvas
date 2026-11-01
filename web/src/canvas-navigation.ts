import { t } from './i18n'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { terminalConsumesWheel } from './terminals'
import { touchViewport, type TouchPosition } from './mobile-layout'
import { canvasFrame, preserveCanvasCenter, type CanvasFrame } from './viewport'
import { PageWheelGesture, swipePage, pageDragOffset, PAGE_GESTURE_IDLE_MS, type PageDirection } from './overview-paging'
import { WheelOwner } from './wheel-owner'

type Viewport = { x: number; y: number; zoom: number }
export function useCanvasNavigation(options: {
  getCanvasId(): string
  getViewport(): Viewport
  setViewport(viewport: Viewport): Promise<unknown>
  saveViewport(): void
  blocked(): boolean
  beforeFullscreen(): void
  onError(reason: unknown): void
  mobile(): boolean
  onNavigate?(): void
  paging?: { enabled(): boolean; canMove(direction: PageDirection): boolean; move(direction: PageDirection): void; recenter(animate?: boolean): Promise<unknown> }
}) {
  const surface = ref<HTMLElement>()
  const app = ref<HTMLElement>()
  const fullscreen = ref(false)
  let previous: { canvasId: string; viewport: Viewport; width: number; height: number; frame?: CanvasFrame } | undefined
  let changing = false
  let gesture: { count: number; viewport: Viewport; point: TouchPosition; distance: number; paged: boolean; multi: boolean; latest: TouchPosition; axis?: 'x' | 'y' } | undefined
  const pageWheel = new PageWheelGesture()
  const wheelOwner = new WheelOwner<HTMLElement>()
  let moved = false
  let suppressClickUntil = 0
  let lastTouch: TouchPosition | undefined

  let preview: { base: Viewport; x: number; y: number } | undefined
  let previewFrame = 0
  let pageSettle: ReturnType<typeof setTimeout> | undefined

  // Invalidate delayed writes before any external camera change. Keep a consumed
  // wheel gesture consumed, so its momentum cannot advance the next window.
  function resetPagingFeedback() {
    const active = !!preview
    clearTimeout(pageSettle); pageSettle = undefined
    cancelAnimationFrame(previewFrame); previewFrame = 0
    preview = undefined
    if (pageWheel.pending) pageWheel.block()
    if (gesture?.paged) gesture.multi = true
    return active
  }
  function cancelFeedback(animate = true) {
    if (resetPagingFeedback() && options.paging?.enabled()) void options.paging.recenter(animate)
  }
  function flushPreview() {
    cancelAnimationFrame(previewFrame); previewFrame = 0
    if (!preview || !options.paging?.enabled() || options.blocked()) return
    void options.setViewport({ ...preview.base, x: preview.base.x + preview.x, y: preview.base.y + preview.y })
  }
  function previewPage(x: number, y: number) {
    if (!surface.value || !options.paging?.enabled()) return
    const horizontal = Math.abs(x) > Math.abs(y)
    const direction = horizontal ? x > 0 ? 'right' : 'left' : y > 0 ? 'down' : 'up'
    const offset = pageDragOffset(x, y, horizontal ? surface.value.clientWidth : surface.value.clientHeight, !options.paging.canMove(direction))
    preview ??= { base: { ...options.getViewport() }, x: 0, y: 0 }
    Object.assign(preview, offset)
    if (!previewFrame) previewFrame = requestAnimationFrame(flushPreview)
  }
  function finishPage(direction?: PageDirection) {
    flushPreview()
    resetPagingFeedback()
    if (direction && options.paging?.canMove(direction)) options.paging.move(direction)
    else if (options.paging?.enabled()) void options.paging.recenter(true)
  }
  watch([options.getCanvasId, () => options.paging?.enabled(), options.blocked], () => {
    wheelOwner.reset()
    cancelFeedback(false)
    if (!options.paging?.enabled()) { pageWheel.reset(); gesture = undefined }
  }, { flush: 'sync' })

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
    if (!gesture && !target?.closest('.terminal-preview-button, .overview-create') &&
        target?.closest('button, a, input, select, .file-preview, .canvas-toolbar, .vue-flow__minimap')) return
    if (!gesture) {
      moved = false
      if (options.paging?.enabled()) {
        // Freeze any returning camera where the finger actually landed.
        const base = { ...options.getViewport() }
        resetPagingFeedback()
        void options.setViewport(base)
        preview = { base, x: 0, y: 0 }
      }
    }
    const position = touchPosition(event.touches)
    if (gesture?.paged) {
      if (position.count > 1) { gesture.multi = true; moved = true; suppressClickUntil = performance.now() + 500; cancelFeedback() }
      return
    }
    gesture = { ...position, viewport: { ...options.getViewport() }, paged: !!options.paging?.enabled(), multi: position.count > 1, latest: position.point }
    if (gesture.count > 1) { moved = true; suppressClickUntil = performance.now() + 500; if (gesture.paged) cancelFeedback() }
  }
  function touchMove(event: TouchEvent) {
    if (!gesture || !options.mobile() || options.blocked() || !surface.value || !event.touches.length) return
    const current = touchPosition(event.touches)
    if (gesture.paged) {
      gesture.latest = current.point
      gesture.multi ||= current.count > 1
      const dx = gesture.point.x - current.point.x, dy = gesture.point.y - current.point.y
      if (!gesture.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 8) gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (gesture.multi) cancelFeedback()
      else previewPage(gesture.axis === 'y' ? 0 : dx, gesture.axis === 'x' ? 0 : dy)
      if (Math.hypot(current.point.x - gesture.point.x, current.point.y - gesture.point.y) >= 6 || gesture.multi) {
        moved = true
        suppressClickUntil = performance.now() + 500
        event.preventDefault(); event.stopPropagation()
      }
      return
    }
    if (current.count !== gesture.count) {
      gesture = { ...gesture, ...current, viewport: { ...options.getViewport() } }
      return
    }
    if (!moved && current.count === 1 && Math.hypot(current.point.x - gesture.point.x, current.point.y - gesture.point.y) < 6) return
    moved = true
    suppressClickUntil = performance.now() + 500
    event.preventDefault()
    event.stopPropagation()
    options.onNavigate?.()
    void options.setViewport(touchViewport(gesture.viewport, gesture.point, current.point, gesture.distance, current.distance))
  }
  function touchEnd(event: TouchEvent) {
    if (!gesture) return
    const paged = gesture.paged
    if (paged && event.touches.length) return
    if (moved) {
      suppressClickUntil = performance.now() + 500
      const ended = event.changedTouches[0]
      if (ended) lastTouch = { x: ended.clientX, y: ended.clientY }
    }
    if (paged) {
      const direction = !gesture.multi && swipePage(gesture.axis === 'y' ? 0 : gesture.latest.x - gesture.point.x,
        gesture.axis === 'x' ? 0 : gesture.latest.y - gesture.point.y)
      gesture = undefined
      if (preview && options.paging?.enabled() && !options.blocked()) finishPage(direction || undefined)
      return
    }
    gesture = event.touches.length && surface.value
      ? { ...gesture, ...touchPosition(event.touches), viewport: { ...options.getViewport() } } : undefined
  }
  function touchCancel() {
    if (gesture && moved && !gesture.paged) options.saveViewport()
    gesture = undefined
    cancelFeedback()
  }
  function click(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : undefined
    if (!target?.closest('.terminal-preview-button, .overview-create') && target?.closest('button, a, input, select, .canvas-toolbar')) return
    if (options.mobile() && event.detail > 0 && lastTouch && performance.now() < suppressClickUntil &&
        Math.hypot(event.clientX - lastTouch.x, event.clientY - lastTouch.y) < 24) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }

  function wheel(event: WheelEvent) {
    if (options.blocked() || !surface.value) { cancelFeedback(false); return }
    const target = event.target instanceof Element ? event.target : undefined
    if (target?.closest('.vue-flow__minimap, .canvas-toolbar')) return
    const body = target?.closest<HTMLElement>('.card-content')
    const active = !event.ctrlKey && body && (body.classList.contains('terminal-host')
      ? terminalConsumesWheel(event)
      : body.dataset.contentActive === 'true' && body.contains(document.activeElement) && document.hasFocus())
    const owner = wheelOwner.resolve(active ? body : null, performance.now(), event.ctrlKey)
    if (owner) {
      cancelFeedback()
      // Keep native scrolling within this body; never transfer its tail elsewhere.
      if (owner !== body || !active) { event.preventDefault(); event.stopPropagation() }
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const box = surface.value.getBoundingClientRect()
    const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? box.height : 1
    if (options.paging?.enabled()) {
      // Pinch is deliberately inert in paging mode, including its wheel tail.
      if (event.ctrlKey) { cancelFeedback(); pageWheel.block(performance.now()); return }
      const now = performance.now()
      if (pageWheel.isIdle(now)) {
        flushPreview()
        pageWheel.reset()
        resetPagingFeedback()
      }
      const horizontal = event.shiftKey && !event.deltaX
      const direction = pageWheel.consume((horizontal ? event.deltaY : event.deltaX) * unit,
        (horizontal ? 0 : event.deltaY) * unit, now)
      if (direction || pageWheel.pending) {
        const offset = pageWheel.displacement
        previewPage(offset.x, offset.y)
        if (direction) finishPage(direction)
        else {
          clearTimeout(pageSettle)
          pageSettle = setTimeout(() => { pageWheel.reset(); cancelFeedback() }, PAGE_GESTURE_IDLE_MS)
        }
      }
      return
    }
    pageWheel.reset()
    options.onNavigate?.()
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
  }

  async function settle() {
    await nextTick()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
  async function restore() {
    if (!fullscreen.value) return
    options.onNavigate?.()
    const saved = previous
    previous = undefined
    resetPagingFeedback()
    fullscreen.value = false
    await settle()
    if (options.paging?.enabled()) await options.paging.recenter()
    else if (saved?.canvasId === options.getCanvasId()) {
      const frame = canvasFrame(surface.value)
      await options.setViewport(options.mobile() && frame ? preserveCanvasCenter(saved.viewport, saved.frame, frame) : saved.viewport)
    }
    options.saveViewport()
  }
  async function exitFullscreen() {
    try {
      if (document.fullscreenElement === document.documentElement) await document.exitFullscreen()
    } catch { /* The browser may already have left fullscreen. */ }
    await restore()
  }
  async function toggleFullscreen() {
    if (changing) return
    changing = true
    try {
      if (fullscreen.value) { await exitFullscreen(); return }
      if (!surface.value || !app.value) return
      cancelFeedback(false)
      options.beforeFullscreen()
      previous = { canvasId: options.getCanvasId(), viewport: { ...options.getViewport() }, width: surface.value.clientWidth, height: surface.value.clientHeight,
        frame: options.mobile() ? canvasFrame(surface.value) : undefined }
      fullscreen.value = true
      // Fullscreen the document so the app can still follow the visual viewport:
      // browsers force non-root fullscreen elements to fill the layout viewport.
      // Invoke before yielding to retain the original tap's user activation.
      try {
        await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })
        if (document.fullscreenElement !== document.documentElement) throw new Error('Fullscreen unavailable')
      } catch { options.onError(t('app.fullscreenDenied')) }
      if (!fullscreen.value || !app.value) { await exitFullscreen(); return }
      await settle()
      if (fullscreen.value && options.paging?.enabled()) await options.paging.recenter()
      else if (previous && fullscreen.value) await options.setViewport({ ...previous.viewport,
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
  function interacted() {
    wheelOwner.reset()
    cancelFeedback()
    pageWheel.reset()
  }
  function pointerDown(event: PointerEvent) {
    const active = document.activeElement
    const body = active instanceof HTMLElement ? active.closest('.card-content') : null
    const preservesFocus = event.target instanceof Element && event.target.closest('[data-preserve-content-focus]')
    if (!options.mobile() && !preservesFocus && body && active instanceof HTMLElement && event.target instanceof Node && !body.contains(event.target)) active.blur()
    interacted()
  }
  function blurPaging() { wheelOwner.reset(); cancelFeedback(false) }
  onMounted(() => {
    document.addEventListener('fullscreenchange', fullscreenChanged)
    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('focusin', interacted, true)
    document.addEventListener('keydown', interacted, true)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', blurPaging)
  })
  onBeforeUnmount(() => {
    resetPagingFeedback()
    document.removeEventListener('fullscreenchange', fullscreenChanged)
    document.removeEventListener('pointerdown', pointerDown, true)
    document.removeEventListener('focusin', interacted, true)
    document.removeEventListener('keydown', interacted, true)
    window.removeEventListener('keydown', escape, true)
    window.removeEventListener('blur', blurPaging)
  })
  return { surface, app, fullscreen, resetPagingFeedback, wheel, touchStart, touchMove, touchEnd, touchCancel, click, toggleFullscreen, exitFullscreen }
}
