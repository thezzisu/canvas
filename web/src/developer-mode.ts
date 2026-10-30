import { useStorage } from '@vueuse/core'

export const developerMode = useStorage('canvas:developer-mode', false)
