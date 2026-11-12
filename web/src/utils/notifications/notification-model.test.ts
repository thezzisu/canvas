import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attentionSummary,
  faviconStatus,
  isCanvasNotification,
  notificationCurrent,
  notificationKey,
  notificationPresent,
  notificationTarget,
} from './notification-model.ts'
import { mergeLiveResources } from '../workspace/live-resources.ts'
import type { CanvasNotification } from '../../../../shared/notification.ts'
import type { SourceResource } from '../../api/types.ts'

const event: CanvasNotification = {
  id: 'event',
  sourceId: 'source',
  kind: 'done',
  title: 'Done',
  paneId: 'pane2',
  windowId: 'old-window',
}
const resources: SourceResource[] = [
  {
    id: 'source',
    name: 'Source',
    status: 'online',
    spaces: [
      {
        id: 'space',
        name: 'Space',
        windows: [
          {
            id: 'window',
            name: 'Window',
            status: 'attention',
            panes: [
              { id: 'pane1', name: '1', status: 'attention', active: true },
              { id: 'pane2', name: '2', status: 'done', active: false },
            ],
          },
          { id: 'another', name: 'Another', status: 'done', panes: [] },
        ],
      },
    ],
  },
]

test('badge counts native windows once across panes and retains the most urgent state', () => {
  assert.deepEqual(attentionSummary(resources), { count: 2, status: 'attention' })
  assert.deepEqual(attentionSummary([...resources, ...resources]), {
    count: 2,
    status: 'attention',
  })
  assert.deepEqual(attentionSummary([{ ...resources[0]!, error: 'offline' }]), {
    count: 0,
    status: undefined,
  })
})
test('notifications target their pane after a move rather than the window aggregate', () => {
  const target = notificationTarget(event, resources)
  assert.equal(target?.window.id, 'window')
  assert.equal(target?.pane?.status, 'done')
  assert.equal(notificationTarget({ ...event, paneId: 'missing' }, resources), undefined)
  assert.equal(notificationTarget({ ...event, sourceId: 'other' }, resources), undefined)
  assert.notEqual(notificationKey(event), notificationKey({ ...event, paneId: 'pane1' }))
})
test('displayed completion survives read acknowledgement, but not a new task', () => {
  const completion = { bootId: 'fixture', sequence: 1 },
    done = { ...event, completion }
  for (const status of ['done', 'idle', 'working', 'attention'] as const) {
    const current = structuredClone(resources)
    const pane = current[0]!.spaces[0]!.windows[0]!.panes![1]!
    Object.assign(pane, { status, completion })
    assert.equal(
      notificationPresent(done, current),
      status === 'done' || status === 'idle',
      'Only the same completed task remains actionable',
    )
    assert(
      notificationTarget(done, current),
      'Navigation remains possible while the live target is online',
    )
    assert.equal(
      notificationCurrent(done, current),
      status === 'done' || status === 'idle',
      'New stale events still fail entry/effect validation',
    )
    current[0]!.status = 'offline'
    assert(
      notificationPresent(done, current),
      'A temporary offline snapshot does not destroy the event target',
    )
    assert.equal(notificationTarget(done, current), undefined, 'Offline targets cannot be invoked')
    assert.equal(notificationCurrent(done, current), false)
    current[0]!.spaces = []
    assert(
      notificationPresent(done, current),
      'Unavailable discovery is not confirmed target removal',
    )
    current[0]!.status = 'online'
    assert.equal(
      notificationPresent(done, current),
      false,
      'An online authoritative absence removes the target',
    )
  }
  assert.equal(notificationPresent(done, []), false)
  assert.equal(notificationPresent({ ...done, paneId: 'removed' }, resources), false)
  assert.equal(
    notificationPresent({ ...done, paneId: undefined, windowId: 'removed' }, resources),
    false,
  )
  const newer = structuredClone(resources)
  Object.assign(newer[0]!.spaces[0]!.windows[0]!.panes![1]!, {
    status: 'done',
    completion: { ...completion, sequence: 2 },
  })
  assert.equal(
    notificationPresent(done, newer),
    false,
    'A different completed task cannot keep the prior toast actionable',
  )
})
test('notification frames require known kinds and string identity and content', () => {
  assert(isCanvasNotification(event))
  for (const value of [
    null,
    [],
    { ...event, id: 3 },
    { ...event, body: {} },
    { ...event, kind: 'working' },
  ])
    assert(!isCanvasNotification(value))
})
test('favicon follows working and idle live metadata even when the attention badge is empty', () => {
  for (const status of ['working', 'idle', 'unknown'] as const) {
    const pane = { id: 'pane', name: 'Pane', status, active: true }
    const polled: SourceResource[] = [
      {
        id: 'source',
        name: 'Source',
        status: 'online',
        spaces: [
          {
            id: 'space',
            name: 'Space',
            windows: [{ id: 'window', name: 'Window', status: 'done', panes: [] }],
          },
        ],
      },
    ]
    const current = mergeLiveResources(
      polled,
      new Map([['source/window', { id: 'window', name: 'Window', status, panes: [pane] }]]),
    )
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
