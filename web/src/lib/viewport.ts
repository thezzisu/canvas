import { computed, ref, type Ref } from 'vue'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import type { CanvasViewport } from './mobile-layout'
import { systemKeyboardVisible } from '../terminal/mobile-keyboard'
import { viewportPolicy } from '../app/developer-mode'
import { logicalViewportFrame, readViewportFrame, viewportProbe } from './viewport-frame'
import { uiZoom } from '../app/ui-scale'
export { viewportFrame } from './viewport-frame'

export interface CanvasFrame {
  layoutWidth: number
  width: number
  height: number
}
function validCanvasFrame(value: unknown): value is CanvasFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as CanvasFrame
  return [frame.layoutWidth, frame.width, frame.height].every(
    (value) => Number.isFinite(value) && value > 0,
  )
}
export function preserveCanvasCenter(
  viewport: CanvasViewport,
  before: unknown,
  after: CanvasFrame,
): CanvasViewport {
  if (
    !validCanvasFrame(before) ||
    !validCanvasFrame(after) ||
    Math.abs(before.layoutWidth - after.layoutWidth) < 1
  )
    return viewport
  return {
    zoom: viewport.zoom,
    x: viewport.x + (after.width - before.width) / 2,
    y: viewport.y + (after.height - before.height) / 2,
  }
}
export function canvasFrame(surface: HTMLElement | undefined): CanvasFrame | undefined {
  if (!surface?.clientWidth || !surface.clientHeight) return undefined
  return {
    layoutWidth: window.innerWidth,
    width: surface.clientWidth,
    height: surface.clientHeight,
  }
}

/** Keep the app inside the visible viewport, including a persistently open keyboard. */
export function useMobileViewport(mobile: Ref<boolean>) {
  const measured = ref(readViewportFrame())
  const viewport = computed(() => logicalViewportFrame(measured.value, uiZoom.value))
  const update = () => {
    const next = readViewportFrame(),
      previous = measured.value
    if (
      next.width !== previous.width ||
      next.height !== previous.height ||
      next.top !== previous.top ||
      next.left !== previous.left
    )
      measured.value = next
  }
  useResizeObserver(viewportProbe(), update)
  useEventListener(window, ['resize', 'orientationchange'], update)
  useEventListener(window.visualViewport, ['resize', 'scroll'], update)
  useEventListener(document, 'fullscreenchange', update)
  const style = computed(() => {
    if (!mobile.value) return {}
    const frame = viewport.value
    // CSS owns content-resize and keyboard-inset geometry. Only an explicit visual policy
    // overrides the CSS viewport dimensions.
    const override = viewportPolicy.value.interactiveWidget === 'resizes-visual'
    return {
      ...(override
        ? {
            '--mobile-width': `${frame.width}px`,
            '--mobile-height': `${frame.height}px`,
            '--mobile-top': `${frame.top}px`,
            '--mobile-left': `${frame.left}px`,
          }
        : {}),
      '--mobile-safe-top': override
        ? `max(0px, calc((env(safe-area-inset-top) - ${measured.value.top}px) / var(--ui-zoom)))`
        : 'var(--ui-safe-top)',
      // An IME covers the bottom safe area.
      '--mobile-safe-bottom': systemKeyboardVisible.value ? '0px' : 'var(--ui-safe-bottom)',
    }
  })
  return { viewport, style }
}
