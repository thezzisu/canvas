import { computed, watch } from 'vue'
import { useStorage } from '@vueuse/core'
import { normalizeApiBase, parseInstanceLink } from './instance-url'
import { formatCanvasLocation, parseCanvasLocation } from './canvas-location'
import { removeSessionToken } from './instance-session'

export interface CanvasInstance { id: string; name: string; base: string; builtin?: true }
function identity() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128
  const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
export const sameOriginBase = normalizeApiBase(new URL(import.meta.env.BASE_URL, location.href).href)
const sameOriginInstance = { id: identity(), name: new URL(sameOriginBase).host, base: sameOriginBase }
export const instances = useStorage<CanvasInstance[]>('canvas:instances', [])
export const activeInstanceId = useStorage('canvas:active-instance', instances.value[0]?.id || sameOriginInstance.id, sessionStorage)
export const activeInstance = computed(() => instances.value.find(instance => instance.id === activeInstanceId.value) || instances.value[0] || sameOriginInstance)
watch(activeInstance, instance => { activeInstanceId.value = instance.id }, { immediate: true, flush: 'sync' })

export function selectInstance(id: string) {
  if (instances.value.some(instance => instance.id === id)) activeInstanceId.value = id
}
export function rememberInstance() {
  const current = activeInstance.value
  const instance: CanvasInstance = current.base === sameOriginBase ? { ...current, name: sameOriginInstance.name, builtin: true } : current
  instances.value = instances.value.some(value => value.id === instance.id)
    ? instances.value.map(value => value.id === instance.id ? instance : value) : [...instances.value, instance]
}
export function importInstance(value: { base: string; name?: string }): CanvasInstance {
  const base = normalizeApiBase(value.base)
  const existing = instances.value.find(instance => instance.base === base)
  if (existing) { selectInstance(existing.id); return existing }
  return saveInstance({ base, name: value.name?.trim() || new URL(base).host })
}
export function saveInstance(value: { id?: string; name: string; base: string }): CanvasInstance {
  const base = normalizeApiBase(value.base), name = value.name.trim()
  if (!name) throw new Error('instances.nameRequired')
  if (instances.value.some(instance => instance.id !== value.id && instance.base === base)) throw new Error('instances.duplicate')
  const previous = instances.value.find(instance => instance.id === value.id)
  if (previous?.builtin) throw new Error('instances.readOnly')
  const result = { id: previous?.id || identity(), name, base }
  if (previous && previous.base !== base) removeSessionToken(previous.id)
  instances.value = previous ? instances.value.map(instance => instance.id === result.id ? result : instance) : [...instances.value, result]
  selectInstance(result.id)
  return result
}
export function removeInstance(id: string) {
  if (instances.value.find(instance => instance.id === id)?.builtin) return
  removeSessionToken(id)
  instances.value = instances.value.filter(instance => instance.id !== id)
  if (activeInstanceId.value === id) activeInstanceId.value = instances.value[0]?.id || sameOriginInstance.id
}

const link = parseInstanceLink(location.href)
export const invalidInstanceLink = !!link?.invalid
if (link) {
  if (link.server) {
    const instance = importInstance(link.server)
    const previous = parseCanvasLocation(link.url.hash)
    if (previous && previous.instance !== instance.id) link.url.hash = formatCanvasLocation({ instance: instance.id, canvas: 'overview' })
  }
  history.replaceState(history.state, '', `${link.url.pathname}${link.url.search}${link.url.hash}`)
}
