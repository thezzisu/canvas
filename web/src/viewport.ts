import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import type { CanvasViewport } from './mobile-layout'
import { mobileKeyboardFrame, mobileKeyboardVisible } from './mobile-keyboard'
import { developerMode, imeBottomInset } from './developer-mode'

export interface CanvasFrame { layoutWidth: number; width: number; height: number }
function validCanvasFrame(value: unknown): value is CanvasFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as CanvasFrame
  return [frame.layoutWidth, frame.width, frame.height].every(value => Number.isFinite(value) && value > 0)
}
export function preserveCanvasCenter(viewport: CanvasViewport, before: unknown, after: CanvasFrame): CanvasViewport {
  if (!validCanvasFrame(before) || !validCanvasFrame(after) || Math.abs(before.layoutWidth - after.layoutWidth) < 1) return viewport
  return { zoom: viewport.zoom, x: viewport.x + (after.width - before.width) / 2,
    y: viewport.y + (after.height - before.height) / 2 }
}
export function canvasFrame(surface: HTMLElement | undefined): CanvasFrame | undefined {
  if (!surface?.clientWidth || !surface.clientHeight) return undefined
  const app = surface.closest<HTMLElement>('.app-shell')
  const visual = window.visualViewport
  const inset = app ? parseFloat(getComputedStyle(app).getPropertyValue('--mobile-ime-inset')) || 0 : 0
  if (app?.classList.contains('mobile-layout') && visual &&
      (Math.abs(visual.width - window.innerWidth) > 1 || visual.height > window.innerHeight + 1 ||
       Math.abs(app.clientWidth - visual.width) > 1 || Math.abs(app.clientHeight + inset - visual.height) > 1)) return undefined
  return { layoutWidth: window.innerWidth, width: surface.clientWidth,
    // Keyboard occlusion changes the visible height, not the canvas camera.
    height: surface.clientHeight + inset + Math.max(0, window.innerHeight - (window.visualViewport?.height || window.innerHeight)) }
}

export interface ViewportFrame { width: number; height: number; top: number; left: number }
export function viewportFrame(layout: { width: number; height: number }, visual?: {
  width: number; height: number; offsetTop: number; offsetLeft: number
} | null): ViewportFrame {
  const positive = (value: number | undefined, fallback: number) => value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
  const offset = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0
  return { width: positive(visual?.width, layout.width), height: positive(visual?.height, layout.height),
    top: offset(visual?.offsetTop), left: offset(visual?.offsetLeft) }
}

export function insetViewport(frame: ViewportFrame, inset: number): ViewportFrame {
  return { ...frame, height: Math.max(1, frame.height - inset) }
}

/** Keep the app inside the visible viewport, including a persistently open keyboard. */
export function useMobileViewport(mobile: Ref<boolean>) {
  const read = () => viewportFrame({ width: window.innerWidth, height: window.innerHeight }, window.visualViewport)
  const viewport = ref(read())
  const nativeFullscreen = ref(!!document.fullscreenElement)
  // Read in the same event as keyboard recovery releases its held frame. A
  // deferred read would briefly render the stale, keyboard-hidden height.
  const update = () => { viewport.value = read() }
  const fullscreenChanged = () => { nativeFullscreen.value = !!document.fullscreenElement; update() }
  onMounted(() => {
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    document.addEventListener('fullscreenchange', fullscreenChanged)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('resize', update)
    window.removeEventListener('orientationchange', update)
    window.visualViewport?.removeEventListener('resize', update)
    window.visualViewport?.removeEventListener('scroll', update)
    document.removeEventListener('fullscreenchange', fullscreenChanged)
  })
  const style = computed(() => {
    if (!mobile.value) return {}
    const inset = developerMode.value && nativeFullscreen.value && mobileKeyboardVisible.value ? imeBottomInset.value : 0
    const frame = insetViewport(mobileKeyboardFrame.value || viewport.value, inset)
    return { '--mobile-width': `${frame.width}px`, '--mobile-height': `${frame.height}px`,
      '--mobile-ime-inset': `${inset}px`,
      '--mobile-top': `${frame.top}px`, '--mobile-left': `${frame.left}px`,
      '--mobile-safe-top': `max(0px, calc(env(safe-area-inset-top) - ${frame.top}px))`,
      '--mobile-safe-bottom': mobileKeyboardVisible.value ? '0px' : 'env(safe-area-inset-bottom)',
    }
  })
  return { viewport, style }
}
