import { onBeforeUnmount, onMounted, ref } from 'vue'

export interface MobileCapabilities {
  coarsePointer: boolean
  noHover: boolean
  touchPoints: number
  width: number
  screenWidth: number
  screenHeight: number
}

export function isMobileLayout(capabilities: MobileCapabilities): boolean {
  const { coarsePointer, noHover, touchPoints, width, screenWidth, screenHeight } = capabilities
  return coarsePointer && noHover && touchPoints > 0 && width > 0 && width <= 1366 &&
    Math.min(screenWidth, screenHeight) > 0 && Math.min(screenWidth, screenHeight) <= 900
}

export function useMobileLayout() {
  const coarse = matchMedia('(pointer: coarse)')
  const hover = matchMedia('(hover: none)')
  const read = () => isMobileLayout({ coarsePointer: coarse.matches, noHover: hover.matches,
    touchPoints: navigator.maxTouchPoints, width: window.innerWidth,
    screenWidth: window.screen.width || window.innerWidth, screenHeight: window.screen.height || window.innerHeight })
  const mobile = ref(read())
  const update = () => { mobile.value = read() }
  onMounted(() => {
    coarse.addEventListener('change', update)
    hover.addEventListener('change', update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
  })
  onBeforeUnmount(() => {
    coarse.removeEventListener('change', update)
    hover.removeEventListener('change', update)
    window.removeEventListener('resize', update)
    window.removeEventListener('orientationchange', update)
  })
  return mobile
}

export interface CanvasViewport { x: number; y: number; zoom: number }
export interface TouchPosition { x: number; y: number }
export function touchViewport(viewport: CanvasViewport, start: TouchPosition, current: TouchPosition,
  startDistance: number, currentDistance: number): CanvasViewport {
  const zoom = startDistance > 0 ? Math.max(.08, Math.min(2, viewport.zoom * currentDistance / startDistance)) : viewport.zoom
  const scale = zoom / viewport.zoom
  return { zoom, x: current.x - (start.x - viewport.x) * scale, y: current.y - (start.y - viewport.y) * scale }
}
