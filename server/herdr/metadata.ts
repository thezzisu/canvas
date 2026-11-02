import { aggregateStatus, herdrStatus } from '../../shared/status.ts'
import type { WindowMetadata } from '../../shared/window-metadata.ts'
import type { ClientShellSnapshot } from './wire.ts'

const text = (value: unknown) => typeof value === 'string' ? value : ''

/** Endpoint snapshots carry agent metadata separately from pane geometry. */
export function windowMetadata(snapshot: ClientShellSnapshot, tabId: string, completions?: ReadonlyMap<string, number>): WindowMetadata {
  const tab = snapshot.tabs.find(tab => tab.tab_id === tabId)!
  const agents = new Map((Array.isArray(snapshot.agents) ? snapshot.agents : [])
    .filter((agent): agent is Record<string, unknown> => !!agent && typeof agent === 'object')
    .map(agent => [agent.pane_id, agent]))
  const panes = snapshot.panes.filter(pane => pane.tab_id === tabId).map((pane, index) => {
    const agent = agents.get(pane.pane_id)
    const label = text(agent?.display_agent) || text(agent?.agent)
    const sequence = Number.isSafeInteger(agent?.state_change_seq) && (agent!.state_change_seq as number) >= 0 ? agent!.state_change_seq as number : undefined
    const status = herdrStatus(agent?.agent_status)
    const completed = sequence !== undefined && (status === 'done' || status === 'idle' && completions?.get(pane.pane_id) === sequence)
    return {
      id: pane.pane_id, name: text(pane.label) || label || String(index + 1), active: pane.focused === true,
      status: completed ? 'done' as const : status, ...(sequence === undefined ? {} : { stateSequence: sequence }),
      ...(completed ? { completion: { bootId: snapshot.boot_id, sequence: sequence! } } : {}), ...(label ? { agent: label } : {}),
      ...(agent ? { terminalTitle: Array.from(text(agent.terminal_title_stripped).replace(/[\x00-\x1f\x7f-\x9f]/gu, '').trim()).slice(0, 1024).join('') } : {}),
    }
  })
  return { bootId: snapshot.boot_id, id: tabId, name: text(tab.label) || tabId, panes,
    status: panes.length ? aggregateStatus(panes.map(pane => pane.status)) : herdrStatus(tab.agent_status) }
}
