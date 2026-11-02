import { computed, shallowRef } from 'vue'

const surfaces = shallowRef<HTMLElement[]>([])
export const notificationSurface = computed(() => surfaces.value.at(-1))
export const notificationPortal = shallowRef<HTMLElement>()

export function registerNotificationSurface(element: HTMLElement) {
  surfaces.value = [...surfaces.value, element]
  return () => { surfaces.value = surfaces.value.filter(surface => surface !== element) }
}
