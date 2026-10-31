import { statusPriority, type ProgramStatus } from './status.ts'

export interface PaneMetadata {
  id: string
  name: string
  active: boolean
  status: ProgramStatus
  agent?: string
  terminalTitle?: string
}
export interface WindowMetadata {
  id: string
  name: string
  status: ProgramStatus
  panes: PaneMetadata[]
}

export function isWindowMetadata(value: unknown): value is WindowMetadata {
  if (!value || typeof value !== 'object') return false
  const window = value as WindowMetadata
  const status = (value: unknown) => typeof value === 'string' && Object.hasOwn(statusPriority, value)
  return typeof window.id === 'string' && typeof window.name === 'string' && status(window.status)
    && Array.isArray(window.panes) && window.panes.every(pane => pane && typeof pane.id === 'string'
      && typeof pane.name === 'string' && typeof pane.active === 'boolean' && status(pane.status)
      && (pane.agent === undefined || typeof pane.agent === 'string')
      && (pane.terminalTitle === undefined || typeof pane.terminalTitle === 'string'))
}
