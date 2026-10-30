import { useStorage } from '@vueuse/core'
import { computed, shallowRef } from 'vue'

export const developerMode = useStorage('canvas:developer-mode', false)
export const viewportFit = useStorage<'cover' | 'contain'>('canvas:developer:viewport-fit', 'cover')
export const interactiveWidget = useStorage<'resizes-content' | 'resizes-visual'>('canvas:developer:interactive-widget', 'resizes-content')

export const pendingViewportPolicy = computed(() => ({
  viewportFit: developerMode.value && viewportFit.value === 'contain' ? 'contain' : 'cover',
  interactiveWidget: developerMode.value && interactiveWidget.value === 'resizes-visual' ? 'resizes-visual' : 'resizes-content',
} as const))
export const viewportPolicy = shallowRef<typeof pendingViewportPolicy.value>({ viewportFit: 'cover', interactiveWidget: 'resizes-content' })
export const viewportReloadRequired = computed(() =>
  pendingViewportPolicy.value.viewportFit !== viewportPolicy.value.viewportFit ||
  pendingViewportPolicy.value.interactiveWidget !== viewportPolicy.value.interactiveWidget)

let initialized = false
/** Native keyboard resize policy stays fixed for the lifetime of this page. */
export function initializeViewportPolicy() {
  if (initialized) return
  initialized = true
  const policy = viewportPolicy.value = { ...pendingViewportPolicy.value }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (meta) meta.content = `width=device-width, initial-scale=1.0, viewport-fit=${policy.viewportFit}, interactive-widget=${policy.interactiveWidget}`
}
