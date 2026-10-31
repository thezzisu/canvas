import { useElementSize, useEventListener, useStorage } from '@vueuse/core'
import { onBeforeUnmount, onMounted, ref, watchEffect, type Ref } from 'vue'
import { compactHeader } from './header-capacity'

export type CutoutPosition = 'left' | 'center' | 'right'
export const cutoutPosition = useStorage<CutoutPosition>('canvas:display:cutout-position', 'center')
export const cutoutWidth = useStorage('canvas:display:cutout-width', 0)

export function useCompactHeader(header: Ref<HTMLElement | undefined>) {
  const { width } = useElementSize(header, { width: 0, height: 44 }, { box: 'border-box' })
  const fullscreenElement = ref(document.fullscreenElement)
  useEventListener(document, 'fullscreenchange', () => { fullscreenElement.value = document.fullscreenElement })
  const compact = ref(true)
  watchEffect(() => {
    void fullscreenElement.value
    const gap = cutoutWidth.value, position = cutoutPosition.value
    const avoided = header.value?.matches('.cutout-preview') || header.value?.dataset.cutoutPosition && header.value.closest('.canvas-fullscreen.has-display-cutout')
    compact.value = compactHeader(width.value, avoided ? gap : 0, position)
  }, { flush: 'post' })
  return compact
}

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
