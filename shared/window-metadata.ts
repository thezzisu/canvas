import { isCompletionToken, type CompletionToken } from './completion.ts'
import { statusPriority, type ProgramStatus } from './status.ts'

export interface PaneMetadata {
  terminalId?: string
  id: string
  name: string
  active: boolean
  status: ProgramStatus
  agent?: string
  terminalTitle?: string
  stateSequence?: number
  completion?: CompletionToken
}
export interface WindowMetadata {
  readAuthority?: 'native'
  layout?: string
  bootId?: string
  id: string
  name: string
  status: ProgramStatus
  panes: PaneMetadata[]
}

export function isWindowMetadata(value: unknown): value is WindowMetadata {
  if (!value || typeof value !== 'object') return false
  const window = value as WindowMetadata
  const status = (value: unknown) => typeof value === 'string' && Object.hasOwn(statusPriority, value)
  return (window.readAuthority === undefined || window.readAuthority === 'native') && typeof window.id === 'string' && typeof window.name === 'string' && status(window.status)
    && (window.layout === undefined || typeof window.layout === 'string' && window.layout.length <= 100)
    && Array.isArray(window.panes) && window.panes.every(pane => pane && typeof pane.id === 'string'
      && typeof pane.name === 'string' && typeof pane.active === 'boolean' && status(pane.status)
      && (pane.terminalId === undefined || typeof pane.terminalId === 'string' && pane.terminalId.length > 0 && pane.terminalId.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(pane.terminalId))
      && (pane.agent === undefined || typeof pane.agent === 'string')
      && (pane.terminalTitle === undefined || typeof pane.terminalTitle === 'string')
      && (pane.stateSequence === undefined || Number.isSafeInteger(pane.stateSequence) && pane.stateSequence >= 0)
      && (pane.completion === undefined || isCompletionToken(pane.completion)))
}
