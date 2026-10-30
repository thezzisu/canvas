import { useStorage } from '@vueuse/core'
import { computed, watch } from 'vue'

export const developerMode = useStorage('canvas:developer-mode', false)
export const viewportFit = useStorage<'cover' | 'contain'>('canvas:developer:viewport-fit', 'cover')
export const interactiveWidget = useStorage<'resizes-content' | 'resizes-visual'>('canvas:developer:interactive-widget', 'resizes-content')

export const viewportPolicy = computed(() => ({
  viewportFit: developerMode.value && viewportFit.value === 'contain' ? 'contain' : 'cover',
  interactiveWidget: developerMode.value && interactiveWidget.value === 'resizes-visual' ? 'resizes-visual' : 'resizes-content',
}))

/** Apply before mounting so saved experiments also govern the initial app layout. */
export function watchViewportPolicy() {
  watch(viewportPolicy, policy => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    if (meta) meta.content = `width=device-width, initial-scale=1.0, viewport-fit=${policy.viewportFit}, interactive-widget=${policy.interactiveWidget}`
  }, { immediate: true })
}
