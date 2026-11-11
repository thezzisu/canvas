import test from 'node:test'
import assert from 'node:assert/strict'
import {
  focusedCompletionStatus,
  projectFocusedResources,
  type PaneFocus,
} from './completion-focus.ts'
import { notificationCurrent } from '../notifications/notification-model.ts'
import type { ProgramStatus, SourceResource } from '../api/types.ts'
import type { CanvasNotification } from '../../../shared/notification.ts'

const token = { bootId: 'boot', sequence: 12 }
const focus: PaneFocus = { sourceId: 'source', windowId: 'window', paneId: 'left' }
const resource = (status: ProgramStatus): SourceResource[] => [
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
            status: 'done',
            panes: [
              {
                id: 'left',
                name: 'Left',
                active: true,
                status,
                ...(status === 'done' || status === 'idle' ? { completion: token } : {}),
              },
              {
                id: 'right',
                name: 'Right',
                active: false,
                status: 'done',
                completion: { ...token, sequence: 5 },
              },
            ],
          },
        ],
      },
    ],
  },
]

test('an attended completion holds its previous painted color then becomes idle without a Done frame', () => {
  const working = focusedCompletionStatus(resource('working'), focus)
  assert.equal(working?.status, 'working')
  const received = focusedCompletionStatus(resource('done'), focus, working)
  assert.equal(received?.status, 'working')
  const stale = focusedCompletionStatus(
    resource('done'),
    { ...focus, painted: { ...token, sequence: 11 } },
    received,
  )
  assert.equal(stale?.status, 'working')
  const painted = focusedCompletionStatus(resource('done'), { ...focus, painted: token }, stale)
  assert.equal(painted?.status, 'idle')
  assert.equal(
    focusedCompletionStatus(resource('attention'), { ...focus, painted: token }, painted)?.status,
    'attention',
  )
})

test('pane presentation changes only the attended pane and preserves sibling unread aggregation', () => {
  const source = resource('done')
  const viewed = focusedCompletionStatus(source, { ...focus, painted: token })
  const projected = projectFocusedResources(source, viewed)[0]!.spaces[0]!.windows[0]!
  assert.equal(projected.panes![0]!.status, 'idle')
  assert.equal(projected.panes![1]!.status, 'done')
  assert.equal(projected.status, 'done')
  assert.equal(
    source[0]!.spaces[0]!.windows[0]!.panes![0]!.status,
    'done',
    'raw shared metadata is not mutated',
  )
})

test('paused attention and different panes cannot inherit another pane color or acknowledge stale boots', () => {
  const previous = focusedCompletionStatus(resource('working'), focus)
  assert.equal(focusedCompletionStatus(resource('done'), undefined, previous), undefined)
  assert.equal(
    focusedCompletionStatus(resource('done'), { ...focus, paneId: 'right' }, previous)?.status,
    'done',
  )
  assert.equal(
    focusedCompletionStatus(resource('done'), { ...focus, painted: { ...token, bootId: 'old' } })
      ?.status,
    'done',
  )
  assert.equal(
    focusedCompletionStatus([{ ...resource('done')[0]!, status: 'offline' }], focus),
    undefined,
  )
})

test('completion events remain current after shared read but not after a new task or another completion', () => {
  const event: CanvasNotification = {
    id: 'event',
    sourceId: 'source',
    windowId: 'window',
    paneId: 'left',
    kind: 'done',
    title: 'Done',
    completion: token,
  }
  assert(notificationCurrent(event, resource('done')))
  assert(notificationCurrent(event, resource('idle')))
  assert(!notificationCurrent(event, resource('working')))
  assert(
    !notificationCurrent({ ...event, completion: { ...token, sequence: 11 } }, resource('idle')),
  )
  assert(!notificationCurrent({ ...event, completion: undefined }, resource('done')))
})
