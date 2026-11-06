import { shallowRef } from 'vue'

export type CopyFeedbackKind = 'copied' | 'cut' | 'failed' | 'canvas'
export const copyFeedback = shallowRef<{ kind: CopyFeedbackKind; revision: number }>()
let revision = 0

/** Only the most recent copy gesture may report its asynchronous result. */
export function beginCopyFeedback() {
  const operation = ++revision
  return (kind: CopyFeedbackKind) => {
    if (operation === revision) copyFeedback.value = { kind, revision: operation }
  }
}
