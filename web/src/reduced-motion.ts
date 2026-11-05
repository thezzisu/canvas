import { computed } from 'vue'
import { createSharedComposable, usePreferredReducedMotion } from '@vueuse/core'

export const useReducedMotion = createSharedComposable(() => {
  const preference = usePreferredReducedMotion()
  return computed(() => preference.value === 'reduce')
})
