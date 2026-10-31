import { computed, watch } from 'vue'
import { useStorage } from '@vueuse/core'
import { normalizeApiBase, parseInstanceLink } from './instance-url'
import { formatCanvasLocation, parseCanvasLocation } from './canvas-location'
import { removeSessionToken } from './instance-session'
import { instanceConfiguration, type CanvasInstance } from './instance-config'
import { clearInstanceFileViews } from './file-view'
import { forgetInstanceBuild } from './instance-builds'

export type { CanvasInstance } from './instance-config'
function identity() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128
  const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
export const sameOriginBase = normalizeApiBase(new URL(import.meta.env.BASE_URL, location.href).href)
const builtinServer = import.meta.env.VITE_CANVAS_BUILTIN_SERVER !== 'false'
const sameOriginInstance: CanvasInstance | undefined = builtinServer ? { id: identity(), name: new URL(sameOriginBase).host, base: sameOriginBase, builtin: true } : undefined
const savedInstances = useStorage<CanvasInstance[]>('canvas:instances', [])
export const activeInstanceId = useStorage('canvas:active-instance', instanceConfiguration(savedInstances.value, '', sameOriginInstance).active.id, localStorage, { listenToStorageChanges: false })
const configuration = computed(() => instanceConfiguration(savedInstances.value, activeInstanceId.value, sameOriginInstance))
export const instances = computed({ get: () => configuration.value.instances, set: (value: CanvasInstance[]) => { savedInstances.value = value } })
export const activeInstance = computed(() => configuration.value.active)
export const hasActiveInstance = computed(() => !!activeInstance.value.base)
watch(activeInstance, instance => { activeInstanceId.value = instance.id }, { immediate: true, flush: 'sync' })

export function selectInstance(id: string) {
  if (instances.value.some(instance => instance.id === id)) activeInstanceId.value = id
}
export function rememberInstance() {
  if (hasActiveInstance.value) savedInstances.value = instances.value
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
  if (previous?.builtin && previous.base !== base) throw new Error('instances.readOnly')
  const result: CanvasInstance = { ...previous, id: previous?.id || identity(), name, base }
  if (previous && previous.base !== base) { removeSessionToken(previous.id); clearInstanceFileViews(previous.id); forgetInstanceBuild(previous.id) }
  instances.value = previous ? instances.value.map(instance => instance.id === result.id ? result : instance) : [...instances.value, result]
  selectInstance(result.id)
  return result
}
export function removeInstance(id: string) {
  if (instances.value.find(instance => instance.id === id)?.builtin) return
  removeSessionToken(id)
  clearInstanceFileViews(id)
  forgetInstanceBuild(id)
  instances.value = instances.value.filter(instance => instance.id !== id)
  if (activeInstanceId.value === id) activeInstanceId.value = instances.value[0]?.id || sameOriginInstance?.id || ''
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
