import type { WindowResource } from '../../api/types'

type WindowTitle = Pick<WindowResource, 'name' | 'panes'>

export function windowTerminalTitle(window: WindowTitle, paneId?: string): string {
  const pane = paneId
    ? window.panes?.find((pane) => pane.id === paneId)
    : window.panes?.find((pane) => pane.active)
  const title = pane?.terminalTitle?.trim() || ''
  return title === window.name.trim() ? '' : title
}

export function windowLabel(window: WindowTitle, paneId?: string): string {
  return [window.name, windowTerminalTitle(window, paneId)].filter(Boolean).join(' ')
}
