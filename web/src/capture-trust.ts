import { useSessionStorage } from '@vueuse/core'

/** A capture is a short-lived capability; approvals survive reload only in this browser tab. */
const approvals = useSessionStorage<Record<string, boolean>>('canvas:capture-trust', {})
export const captureTrusted = (id: string) => approvals.value[id] === true
export function trustCapture(id: string) { approvals.value = { ...approvals.value, [id]: true } }
export function clearCaptureTrust() { approvals.value = {} }
