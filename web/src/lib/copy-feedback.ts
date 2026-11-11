import { t } from '../app/i18n'
import { notify } from './notify'

export type CopyFeedbackKind = 'copied' | 'cut' | 'failed'
let revision = 0

/** Only the most recent copy gesture may report its asynchronous result. */
export function beginCopyFeedback() {
  const operation = ++revision
  return (kind: CopyFeedbackKind) => {
    if (operation !== revision) return
    const title = t(`terminal.clipboard.${kind}`)
    if (kind === 'failed') notify.error(title, { id: 'copy' })
    else notify.brief(title, { id: 'copy' })
  }
}
