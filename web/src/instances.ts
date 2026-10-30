import { computed } from 'vue'
import { useStorage } from '@vueuse/core'
import { normalizeApiBase } from './instance-url'

export interface CanvasInstance { id: string; name: string; base: string }
function identity() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128
  const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
const initialBase = normalizeApiBase(import.meta.env.VITE_CANVAS_API_BASE || new URL(import.meta.env.BASE_URL, location.href).href)
export const instances = useStorage<CanvasInstance[]>('canvas:instances', [{ id: identity(), name: new URL(initialBase).host, base: initialBase }])
export const activeInstanceId = useStorage('canvas:active-instance', instances.value[0]!.id, sessionStorage)
export const activeInstance = computed(() => instances.value.find(instance => instance.id === activeInstanceId.value) || instances.value[0]!)
export const tokenKey = (id: string) => `canvas:session:${id}`

export function selectInstance(id: string) {
  if (instances.value.some(instance => instance.id === id)) activeInstanceId.value = id
}
export function saveInstance(value: { id?: string; name: string; base: string }): CanvasInstance {
  const base = normalizeApiBase(value.base), name = value.name.trim()
  if (!name) throw new Error('instances.nameRequired')
  if (instances.value.some(instance => instance.id !== value.id && instance.base === base)) throw new Error('instances.duplicate')
  const previous = instances.value.find(instance => instance.id === value.id)
  const result = { id: previous?.id || identity(), name, base }
  if (previous && previous.base !== base) sessionStorage.removeItem(tokenKey(previous.id))
  instances.value = previous ? instances.value.map(instance => instance.id === result.id ? result : instance) : [...instances.value, result]
  selectInstance(result.id)
  return result
}
export function removeInstance(id: string) {
  if (instances.value.length < 2) return
  sessionStorage.removeItem(tokenKey(id))
  instances.value = instances.value.filter(instance => instance.id !== id)
  if (activeInstanceId.value === id) activeInstanceId.value = instances.value[0]!.id
}
