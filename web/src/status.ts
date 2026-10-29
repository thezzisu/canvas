import type { PaneResource, ProgramStatus } from './types'

const labels: Record<ProgramStatus, string> = {
  error: '错误',
  attention: '待处理',
  working: '运行中',
  done: '已完成',
  idle: '空闲',
  unknown: '未报告状态',
}

// Herdr’s default Catppuccin Mocha status palette.
export const statusColors: Record<ProgramStatus, string> = {
  error: '#f38ba8',
  attention: '#f38ba8',
  working: '#f9e2af',
  done: '#94e2d5',
  idle: '#a6e3a1',
  unknown: '#6c7086',
}

export function statusLabel(status?: ProgramStatus) { return labels[status || 'unknown'] }
export function statusColor(status?: ProgramStatus) { return statusColors[status || 'unknown'] }
export function paneLabel(pane: PaneResource) {
  return [...new Set([paneName(pane), pane.agent, statusLabel(pane.status)].filter(Boolean))].join(' · ')
}

export function paneShortId(pane: PaneResource) { return pane.id.split(':').at(-1) || pane.id }
export function paneName(pane: PaneResource) {
  const name = pane.name.trim()
  return name && !/^\d+$/.test(name) ? name : `Pane ${name || paneShortId(pane)}`
}
