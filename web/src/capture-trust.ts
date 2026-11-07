import { useSessionStorage } from '@vueuse/core'
import { apiContext } from './api'

/** One approval per native window; it survives reload only in this browser tab. */
const approvals = useSessionStorage<Record<string, string>>('canvas:capture-trust', {}, { writeDefaults: false })
const key = (sourceId: string, windowId: string) => `${apiContext().id}:${sourceId}/${windowId}`
export const captureTrusted = (sourceId: string, windowId: string, id: string) => approvals.value[key(sourceId, windowId)] === id
export function trustCapture(sourceId: string, windowId: string, id: string) { approvals.value = { ...approvals.value, [key(sourceId, windowId)]: id } }
export function forgetCaptureTrust(sourceId: string, windowId: string) {
  const current = key(sourceId, windowId)
  if (!(current in approvals.value)) return
  const next = { ...approvals.value }; delete next[current]; approvals.value = next
}
export function clearCaptureTrust() { approvals.value = {} }
