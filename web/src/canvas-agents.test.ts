import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canvasAgents } from './canvas-agents'
import type { Canvas, PaneResource, SourceResource } from './types'

const pane = (id: string, status: PaneResource['status'], agent?: string): PaneResource => ({
  id,
  name: id,
  active: false,
  status,
  ...(agent ? { agent } : {}),
})
const resources: SourceResource[] = [
  {
    id: 'a',
    name: 'A',
    status: 'online',
    spaces: [
      {
        id: 's',
        name: 'Space',
        windows: [
          {
            id: 'w',
            name: 'Work',
            panes: [
              pane('one', 'working', 'codex'),
              pane('two', 'done', 'codex'),
              pane('shell', 'unknown'),
            ],
          },
          { id: 'other', name: 'Other', panes: [pane('attention', 'attention', 'claude')] },
        ],
      },
    ],
  },
]
const selected: Canvas = {
  id: 'canvas',
  name: 'Canvas',
  nodes: [
    ...['first', 'duplicate'].map((id) => ({
      id,
      type: 'terminal' as const,
      sourceId: 'a',
      spaceId: 'old-space',
      windowId: 'w',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    })),
    {
      id: 'note',
      type: 'note',
      title: 'Note',
      content: '',
      color: 'blue',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    },
  ],
}

test('canvas agents follow linked native windows and retain distinct same-name agents without duplicate references', () => {
  const result = canvasAgents(selected, resources)
  assert.deepEqual(
    result.map((item) => item.pane.id),
    ['one', 'two'],
  )
  assert(result.every((item) => item.context === 'A / Space' && item.available))
  assert.equal(canvasAgents({ ...selected, nodes: [] }, resources).length, 0)
  assert.deepEqual(
    canvasAgents(undefined, resources).map((item) => item.pane.id),
    ['one', 'two', 'attention'],
  )
})

test('offline agents retain identity but do not report a stale running or done state', () => {
  const result = canvasAgents(selected, [
    { ...resources[0]!, status: 'offline', error: 'Unavailable' },
  ])
  assert.equal(result.length, 2)
  assert(result.every((item) => !item.available && item.status === 'unknown'))
})

test('agent labels include unknown states, explicit agent states need no label, and unknown shells are omitted', () => {
  const input: SourceResource[] = [
    {
      id: 'a',
      name: 'A',
      status: 'online',
      spaces: [
        {
          id: 's',
          name: 'Space',
          windows: [
            {
              id: 'w',
              name: 'Work',
              panes: [
                pane('labelled', 'unknown', 'codex'),
                pane('explicit', 'idle'),
                pane('shell', 'unknown'),
              ],
            },
          ],
        },
      ],
    },
  ]
  assert.deepEqual(
    canvasAgents(undefined, input).map((item) => item.pane.id),
    ['labelled', 'explicit'],
  )
  input[0]!.spaces[0]!.windows[0]!.panes![1]!.status = 'done'
  assert.equal(
    canvasAgents(undefined, input)[1]!.status,
    'done',
    'Current displayed read/status projection remains authoritative',
  )
  assert.deepEqual(
    canvasAgents(undefined, input).map((item) => item.pane.id),
    ['labelled', 'explicit'],
    'Status changes cannot move a row under the pointer',
  )
})

test('window and pane IDs are scoped to their connection and existing data is never mutated', () => {
  const duplicate = { ...resources[0]!, id: 'b', name: 'B' }
  const before = JSON.stringify(resources)
  const result = canvasAgents(undefined, [...resources, duplicate, resources[0]!])
  assert.equal(result.length, 6)
  assert.equal(new Set(result.map((item) => item.key)).size, 6)
  assert.equal(JSON.stringify(resources), before)
})

test('status sorting uses each agent pane and preserves native order for equal priorities', () => {
  const before = JSON.stringify(resources)
  const peer = { ...resources[0]!, id: 'b', name: 'B' }
  const result = canvasAgents(undefined, [peer, ...resources], 'status')
  assert.deepEqual(
    result.map((agent) => `${agent.sourceId}/${agent.pane.id}`),
    ['b/attention', 'a/attention', 'b/two', 'a/two', 'b/one', 'a/one'],
  )
  assert.deepEqual(
    canvasAgents(selected, resources, 'status').map((agent) => agent.pane.id),
    ['two', 'one'],
  )
  assert.deepEqual(
    canvasAgents(undefined, resources, 'native').map((agent) => agent.pane.id),
    ['one', 'two', 'attention'],
  )
  assert.equal(JSON.stringify(resources), before)
})

test('offline agents sort by their displayed unknown state without disappearing', () => {
  const offline = { ...resources[0]!, id: 'offline', status: 'offline' as const }
  const result = canvasAgents(undefined, [offline, ...resources], 'status')
  assert.deepEqual(
    result.map((agent) => `${agent.sourceId}/${agent.pane.id}`),
    ['a/attention', 'a/two', 'a/one', 'offline/one', 'offline/two', 'offline/attention'],
  )
  assert(result.slice(3).every((agent) => !agent.available && agent.status === 'unknown'))
})
