import type { PaneResource, ProgramStatus } from './types'

const labels: Record<ProgramStatus, string> = {
  error: '错误',
  attention: '待处理',
  working: '运行中',
  done: '已完成',
  idle: '空闲',
  unknown: '未报告状态',
}

export const statusColors: Record<ProgramStatus, string> = {
  error: '#de7272',
  attention: '#d8a756',
  working: '#6a9fe2',
  done: '#79b88c',
  idle: '#7b9c88',
  unknown: '#4c545f',
}

export function statusLabel(status?: ProgramStatus) { return labels[status || 'unknown'] }
export function statusColor(status?: ProgramStatus) { return statusColors[status || 'unknown'] }
export function paneLabel(pane: PaneResource) {
  return [...new Set([pane.id, pane.name, pane.agent, statusLabel(pane.status), pane.progress === undefined ? '' : `${pane.progress}%`].filter(Boolean))].join(' · ')
}

export function paneShortId(pane: PaneResource) { return pane.id.split(':').at(-1) || pane.id }
