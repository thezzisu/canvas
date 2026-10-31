import { computed } from 'vue'
import { createSharedComposable, useMediaQuery, useStorage } from '@vueuse/core'

export type InputMode = 'auto' | 'touch' | 'keyboard'
export const inputMode = useStorage<InputMode>('canvas:input-mode', 'auto', undefined, {
  serializer: {
    read: value => value === 'touch' || value === 'keyboard' ? value : 'auto',
    write: value => value,
  },
})

export interface MobileCapabilities {
  coarsePointer: boolean
  noHover: boolean
  touchPoints: number
  userAgent?: string
  platform?: string
  userAgentData?: { mobile?: boolean; platform?: string }
}

export function isMobileLayout(capabilities: MobileCapabilities, mode: InputMode = 'auto'): boolean {
  if (mode === 'touch') return true
  if (mode === 'keyboard') return false
  const { touchPoints, userAgent = '', platform, userAgentData } = capabilities
  if (!(touchPoints > 0)) return false
  // These browser hints identify common phone/tablet environments, not whether
  // a physical keyboard is present. Explicit input mode always takes priority.
  const mobileDevice = userAgentData?.mobile === true || /^(Android|iOS)$/i.test(userAgentData?.platform || '') ||
    /Android|iPhone|iPad|iPod/i.test(userAgent) || platform === 'MacIntel' && touchPoints > 1 && !userAgentData?.platform
  return mobileDevice || capabilities.coarsePointer && capabilities.noHover
}

export const useMobileLayout = createSharedComposable(() => {
  const coarse = useMediaQuery('(pointer: coarse)')
  const noHover = useMediaQuery('(hover: none)')
  const device = navigator as Navigator & Pick<MobileCapabilities, 'userAgentData'>
  return computed(() => isMobileLayout({ coarsePointer: coarse.value, noHover: noHover.value,
    touchPoints: device.maxTouchPoints, userAgent: device.userAgent, platform: device.platform,
    userAgentData: device.userAgentData }, inputMode.value))
})

export interface CanvasViewport { x: number; y: number; zoom: number }
export interface TouchPosition { x: number; y: number }
export function touchViewport(viewport: CanvasViewport, start: TouchPosition, current: TouchPosition,
  startDistance: number, currentDistance: number): CanvasViewport {
  const zoom = startDistance > 0 ? Math.max(.08, Math.min(2, viewport.zoom * currentDistance / startDistance)) : viewport.zoom
  const scale = zoom / viewport.zoom
  return { zoom, x: current.x - (start.x - viewport.x) * scale, y: current.y - (start.y - viewport.y) * scale }
}
