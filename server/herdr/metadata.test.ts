import test from 'node:test'
import assert from 'node:assert/strict'
import { windowMetadata } from './metadata.ts'
import type { ClientShellSnapshot } from './wire.ts'

test('native agent metadata joins pane IDs and applies the shared status order without losing shell titles', () => {
  const snapshot: ClientShellSnapshot = {
    boot_id: 'boot', revision: 1, focused_workspace_id: 'space', focused_tab_id: 'tab', focused_pane_id: 'busy',
    tabs: [{ tab_id: 'tab', workspace_id: 'space', focused: true, label: 'Window' }],
    panes: ['busy', 'complete', 'shell'].map(id => ({ pane_id: id, tab_id: 'tab', workspace_id: 'space', focused: id === 'busy', right_click_passthrough: false })),
    agents: [{ pane_id: 'complete', agent_status: 'done', agent: 'codex', terminal_title_stripped: '\x00 Finished\x1b ' },
      { pane_id: 'busy', agent_status: 'working', display_agent: 'Claude', terminal_title_stripped: '' },
      { pane_id: 'unrelated', agent_status: 'blocked' }],
  }
  const metadata = windowMetadata(snapshot, 'tab')
  assert.equal(metadata.status, 'done')
  assert.deepEqual(metadata.panes.map(pane => [pane.id, pane.status, pane.terminalTitle]), [
    ['busy', 'working', ''], ['complete', 'done', 'Finished'], ['shell', 'unknown', undefined],
  ])
  assert.equal(metadata.panes[0]!.active, true)
  snapshot.agents = [{ pane_id: 'complete', agent_status: 'blocked' }, { pane_id: 'busy', agent_status: 'done' }]
  assert.equal(windowMetadata(snapshot, 'tab').status, 'attention')
})
