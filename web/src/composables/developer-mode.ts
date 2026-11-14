import { useLocalStorage } from '@vueuse/core'
import { computed, shallowRef } from 'vue'

export const developerMode = useLocalStorage('canvas:developer-mode', false)
export const viewportFit = useLocalStorage<'cover' | 'contain'>(
  'canvas:developer:viewport-fit',
  'cover',
)
export type InteractiveWidget = 'resizes-content' | 'resizes-visual' | 'overlays-content'
export const interactiveWidget = useLocalStorage<InteractiveWidget>(
  'canvas:developer:interactive-widget',
  'resizes-content',
)

/** For comparing: a maximized terminal whose row count alone changes is not covered meanwhile. */
const uncoveredRowResize = useLocalStorage('canvas:developer:uncovered-row-resize', false)
export const uncoversRowResize = computed({
  get: () => developerMode.value && uncoveredRowResize.value,
  set: (value) => (uncoveredRowResize.value = value),
})

export const pendingViewportPolicy = computed(
  () =>
    ({
      viewportFit: developerMode.value && viewportFit.value === 'contain' ? 'contain' : 'cover',
      interactiveWidget:
        developerMode.value &&
        (interactiveWidget.value === 'resizes-visual' ||
          interactiveWidget.value === 'overlays-content')
          ? interactiveWidget.value
          : 'resizes-content',
    }) as const,
)
export const viewportPolicy = shallowRef<typeof pendingViewportPolicy.value>({
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
})
export const viewportReloadRequired = computed(
  () =>
    pendingViewportPolicy.value.viewportFit !== viewportPolicy.value.viewportFit ||
    pendingViewportPolicy.value.interactiveWidget !== viewportPolicy.value.interactiveWidget,
)

let initialized = false
/** Native keyboard resize policy stays fixed for the lifetime of this page. */
export function initializeViewportPolicy() {
  if (initialized) return
  initialized = true
  const policy = (viewportPolicy.value = { ...pendingViewportPolicy.value })
  document.documentElement.dataset.interactiveWidget = policy.interactiveWidget
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (meta)
    meta.content = `width=device-width, initial-scale=1.0, viewport-fit=${policy.viewportFit}, interactive-widget=${policy.interactiveWidget}`
}
