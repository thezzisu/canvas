import { aggregateStatus, herdrStatus } from '../../shared/status.ts'
import type { WindowMetadata } from '../../shared/window-metadata.ts'
import type { ClientShellSnapshot } from './wire.ts'

const text = (value: unknown) => typeof value === 'string' ? value : ''

/** Endpoint snapshots carry agent metadata separately from pane geometry. */
export function windowMetadata(snapshot: ClientShellSnapshot, tabId: string): WindowMetadata {
  const tab = snapshot.tabs.find(tab => tab.tab_id === tabId)!
  const agents = new Map((Array.isArray(snapshot.agents) ? snapshot.agents : [])
    .filter((agent): agent is Record<string, unknown> => !!agent && typeof agent === 'object')
    .map(agent => [agent.pane_id, agent]))
  const panes = snapshot.panes.filter(pane => pane.tab_id === tabId).map((pane, index) => {
    const agent = agents.get(pane.pane_id)
    const label = text(agent?.display_agent) || text(agent?.agent)
    return {
      id: pane.pane_id, name: text(pane.label) || label || String(index + 1), active: pane.focused === true,
      status: herdrStatus(agent?.agent_status), ...(label ? { agent: label } : {}),
      ...(agent ? { terminalTitle: Array.from(text(agent.terminal_title_stripped).replace(/[\x00-\x1f\x7f-\x9f]/gu, '').trim()).slice(0, 1024).join('') } : {}),
    }
  })
  return { id: tabId, name: text(tab.label) || tabId, panes,
    status: panes.length ? aggregateStatus(panes.map(pane => pane.status)) : herdrStatus(tab.agent_status) }
}
