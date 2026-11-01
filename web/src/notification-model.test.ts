import test from 'node:test'
import assert from 'node:assert/strict'
import { attentionSummary, faviconStatus, isCanvasNotification, notificationKey, notificationTarget } from './notification-model.ts'
import { mergeLiveResources } from './live-resources.ts'
import type { CanvasNotification } from '../../shared/notification.ts'
import type { SourceResource } from './types.ts'

const event: CanvasNotification = { id: 'event', sourceId: 'source', kind: 'done', title: 'Done', paneId: 'pane2', windowId: 'old-window' }
const resources: SourceResource[] = [{ id: 'source', name: 'Source', status: 'online', spaces: [{ id: 'space', name: 'Space', windows: [
  { id: 'window', name: 'Window', status: 'attention', panes: [
    { id: 'pane1', name: '1', status: 'attention', active: true }, { id: 'pane2', name: '2', status: 'done', active: false },
  ] }, { id: 'another', name: 'Another', status: 'done', panes: [] },
] }] }]

test('badge counts native windows once across panes and retains the most urgent state', () => {
  assert.deepEqual(attentionSummary(resources), { count: 2, status: 'attention' })
  assert.deepEqual(attentionSummary([...resources, ...resources]), { count: 2, status: 'attention' })
  assert.deepEqual(attentionSummary([{ ...resources[0]!, error: 'offline' }]), { count: 0, status: undefined })
})
test('notifications target their pane after a move rather than the window aggregate', () => {
  const target = notificationTarget(event, resources)
  assert.equal(target?.window.id, 'window')
  assert.equal(target?.pane?.status, 'done')
  assert.equal(notificationTarget({ ...event, paneId: 'missing' }, resources), undefined)
  assert.equal(notificationTarget({ ...event, sourceId: 'other' }, resources), undefined)
  assert.notEqual(notificationKey(event), notificationKey({ ...event, paneId: 'pane1' }))
})
test('notification frames require known kinds and string identity and content', () => {
  assert(isCanvasNotification(event))
  for (const value of [null, [], { ...event, id: 3 }, { ...event, body: {} }, { ...event, kind: 'working' }]) assert(!isCanvasNotification(value))
})
test('favicon follows working and idle live metadata even when the attention badge is empty', () => {
  for (const status of ['working', 'idle', 'unknown'] as const) {
    const pane = { id: 'pane', name: 'Pane', status, active: true }
    const polled: SourceResource[] = [{ id: 'source', name: 'Source', status: 'online', spaces: [
      { id: 'space', name: 'Space', windows: [{ id: 'window', name: 'Window', status: 'done', panes: [] }] },
    ] }]
    const current = mergeLiveResources(polled, new Map([['source/window', { id: 'window', name: 'Window', status, panes: [pane] }]]))
    assert.equal(faviconStatus(current), status)
    assert.deepEqual(attentionSummary(current), { count: 0, status: undefined })
  }
})
test('favicon uses native urgency across panes, excludes offline sources and restores without windows', () => {
  assert.equal(faviconStatus(resources), 'attention')
  assert.equal(faviconStatus([{ ...resources[0]!, status: 'offline' }]), undefined)
  assert.equal(faviconStatus([{ ...resources[0]!, error: 'offline' }]), undefined)
  assert.equal(faviconStatus([]), undefined)
})
