import { t } from './i18n'
import type { NoteColor, PaneResource, ProgramStatus } from './types'

// Herdr’s default Catppuccin Mocha status palette.
export const statusColors: Record<ProgramStatus, string> = {
  error: '#f38ba8',
  attention: '#f38ba8',
  working: '#f9e2af',
  done: '#94e2d5',
  idle: '#a6e3a1',
  unknown: '#6c7086',
}

export const noteColors: Record<NoteColor, string> = {
  yellow: '#d6b565', blue: '#76a8dd', green: '#78b39a', pink: '#cd91af', neutral: '#919aa9',
}
export function noteColor(color: NoteColor) { return noteColors[color] || noteColors.yellow }

export function statusLabel(status?: ProgramStatus) { return t(`terminal.status.${status || 'unknown'}`) }
export function statusColor(status?: ProgramStatus) { return statusColors[status || 'unknown'] }
export function paneLabel(pane: PaneResource) {
  return [...new Set([paneName(pane), pane.agent, statusLabel(pane.status)].filter(Boolean))].join(' · ')
}

export function paneShortId(pane: PaneResource) { return pane.id.split(':').at(-1) || pane.id }
export function paneName(pane: PaneResource) {
  const name = pane.name.trim()
  return name && !/^\d+$/.test(name) ? name : t('terminal.pane', { name: name || paneShortId(pane) })
}
