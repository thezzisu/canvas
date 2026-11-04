import { shallowRef } from 'vue'

export type CopyFeedbackKind = 'copied' | 'failed' | 'canvas'
export const copyFeedback = shallowRef<{ kind: CopyFeedbackKind; revision: number }>()
let revision = 0

export function notifyCopyFeedback(kind: CopyFeedbackKind) {
  copyFeedback.value = { kind, revision: ++revision }
}
