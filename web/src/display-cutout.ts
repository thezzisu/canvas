import { useStorage } from '@vueuse/core'

export type CutoutPosition = 'left' | 'center' | 'right'
export const cutoutPosition = useStorage<CutoutPosition>('canvas:display:cutout-position', 'center')
export const cutoutWidth = useStorage('canvas:display:cutout-width', 0)
