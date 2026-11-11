import test from 'node:test'
import assert from 'node:assert/strict'
import { windowLabel, windowTerminalTitle } from './window-title.ts'

const window = {
  name: '3',
  panes: [
    { id: 'first', name: '1', active: false, status: 'idle' as const, terminalTitle: 'Other task' },
    {
      id: 'active',
      name: '2',
      active: true,
      status: 'working' as const,
      terminalTitle: '分析 Canvas | metaops',
    },
  ],
}

test('window labels use the active pane and preserve the native tab name', () => {
  assert.equal(windowLabel(window), '3 分析 Canvas | metaops')
  assert.equal(window.name, '3')
  assert.equal(windowTerminalTitle(window, 'first'), 'Other task')
})

test('an explicit missing pane or untitled active pane never borrows another pane title', () => {
  assert.equal(windowTerminalTitle(window, 'missing'), '')
  assert.equal(
    windowTerminalTitle({
      ...window,
      panes: window.panes.map((pane) => ({
        ...pane,
        terminalTitle: pane.active ? '' : pane.terminalTitle,
      })),
    }),
    '',
  )
  assert.equal(
    windowTerminalTitle({
      ...window,
      panes: window.panes.map((pane) => ({ ...pane, active: false })),
    }),
    '',
  )
})

test('duplicate, empty and absent terminal titles leave a single native name', () => {
  for (const terminalTitle of ['3', ' 3 ', '  ', undefined]) {
    assert.equal(windowLabel({ ...window, panes: [{ ...window.panes[1]!, terminalTitle }] }), '3')
  }
  assert.equal(windowLabel({ name: 'Shell' }), 'Shell')
})
