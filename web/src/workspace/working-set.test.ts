import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workingSet } from './working-set'
import type { PaneResource, SourceResource } from '../api/types'

const pane = (id: string, status: PaneResource['status'], agent?: string): PaneResource => ({
  id,
  name: id,
  active: false,
  status,
  ...(agent ? { agent } : {}),
})
const source = (
  id: string,
  windows: SourceResource['spaces'][number]['windows'],
  status = 'online',
): SourceResource => ({
  id,
  name: id.toUpperCase(),
  status,
  spaces: [{ id: 's', name: 'Space', windows }],
})
// Reads far older than the recent window unless a test says otherwise.
const ids = (resources: SourceResource[], reads: Record<string, number>, now = 3_600_000) =>
  workingSet(resources, reads, now).map((entry) => `${entry.windowId}/${entry.pane.id}`)

test('entries list each agent pane of read windows, latest read window first and panes in native order', () => {
  const resources = [
    source('a', [
      {
        id: 'old',
        name: 'Old',
        panes: [
          pane('one', 'working', 'codex'),
          pane('shell', 'unknown'),
          pane('two', 'attention', 'claude'),
        ],
      },
      { id: 'never', name: 'Never', panes: [pane('agent', 'attention', 'codex')] },
      { id: 'new', name: 'New', panes: [pane('three', 'done'), pane('four', 'working', 'pi')] },
    ]),
  ]
  assert.deepEqual(ids(resources, { 'a/old': 1, 'a/new': 2 }), [
    'new/three',
    'new/four',
    'old/one',
    'old/two',
  ])
  assert.deepEqual(ids(resources, { 'a/old': 3, 'a/new': 2 }), [
    'old/one',
    'old/two',
    'new/three',
    'new/four',
  ])
  assert.deepEqual(ids(resources, {}), [], 'never-read windows are not part of the working set')
})

test('windows of offline or failing connections are left out and reads are scoped to their connection', () => {
  const windows = [{ id: 'w', name: 'W', panes: [pane('p', 'working', 'codex')] }]
  const resources = [
    source('a', windows, 'offline'),
    { ...source('b', windows), error: 'Discovery failed' },
    source('c', windows),
  ]
  assert.deepEqual(
    workingSet(resources, { 'a/w': 3, 'b/w': 2, 'c/w': 1 }).map((entry) => entry.sourceId),
    ['c'],
  )
})

test('trailing idle and unknown agents are dropped while settled agents between active ones remain', () => {
  const resources = [
    source('a', [
      {
        id: 'first',
        name: 'First',
        panes: [
          pane('idle-head', 'idle'),
          pane('done', 'done', 'codex'),
          pane('idle-tail', 'idle'),
        ],
      },
      {
        id: 'second',
        name: 'Second',
        panes: [pane('unknown', 'unknown', 'claude'), pane('working', 'working', 'pi')],
      },
      {
        id: 'third',
        name: 'Third',
        panes: [pane('idle', 'idle'), pane('labelled', 'unknown', 'codex')],
      },
    ]),
  ]
  assert.deepEqual(ids(resources, { 'a/first': 3, 'a/second': 2, 'a/third': 1 }), [
    'first/idle-head',
    'first/done',
    'first/idle-tail',
    'second/unknown',
    'second/working',
  ])
  assert.deepEqual(
    ids(resources, { 'a/third': 1 }),
    [],
    'only settled agents leave an empty working set',
  )
})

test('a settled tail stays while it was read within the last fifteen minutes', () => {
  const resources = [
    source('a', [
      { id: 'active', name: 'Active', panes: [pane('agent', 'working', 'codex')] },
      { id: 'recent', name: 'Recent', panes: [pane('idle', 'idle', 'claude')] },
      { id: 'stale', name: 'Stale', panes: [pane('idle', 'idle', 'pi')] },
    ]),
  ]
  const now = 100 * 60_000,
    minute = 60_000
  const reads = {
    'a/active': now - 30 * minute,
    'a/recent': now - 40 * minute,
    'a/stale': now - 50 * minute,
  }
  assert.deepEqual(
    ids(resources, reads, now),
    ['active/agent'],
    'stale settled windows after the last active one are trimmed',
  )
  assert.deepEqual(
    ids(resources, { ...reads, 'a/recent': now - 14 * minute }, now),
    ['recent/idle', 'active/agent'],
    'a recently read settled window stays',
  )
  assert.deepEqual(
    ids(resources, { 'a/recent': now - 14 * minute, 'a/stale': now - 16 * minute }, now),
    ['recent/idle'],
    'recency alone keeps an all-idle head',
  )
})
