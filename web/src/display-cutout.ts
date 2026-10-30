import { useStorage } from '@vueuse/core'
import { onBeforeUnmount, onMounted, ref } from 'vue'

export type CutoutPosition = 'left' | 'center' | 'right'
export const cutoutPosition = useStorage<CutoutPosition>('canvas:display:cutout-position', 'center')
export const cutoutWidth = useStorage('canvas:display:cutout-width', 0)

/** Observe the safe area reported by CSS without guessing the device model. */
export function useDisplayCutout() {
  const hasSafeTop = ref(false)
  let probe: HTMLDivElement | undefined
  let observer: ResizeObserver | undefined
  onMounted(() => {
    probe = document.createElement('div')
    probe.className = 'display-cutout-probe'
    probe.setAttribute('aria-hidden', 'true')
    Object.assign(probe.style, { position: 'fixed', top: '0', left: '0', width: '0', height: 'env(safe-area-inset-top, 0px)',
      visibility: 'hidden', pointerEvents: 'none', overflow: 'hidden' })
    document.body.append(probe)
    const update = () => { hasSafeTop.value = !!probe && probe.getBoundingClientRect().height > 0 }
    observer = new ResizeObserver(update)
    observer.observe(probe)
    update()
  })
  onBeforeUnmount(() => { observer?.disconnect(); probe?.remove() })
  return { hasSafeTop }
}
