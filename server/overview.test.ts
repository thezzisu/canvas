import test from 'node:test'
import assert from 'node:assert/strict'
import { overviewLayoutKey, overviewResources, overviewStatuses } from '../web/src/overview.ts'
import type { SourceResource, WindowResource } from '../web/src/types.ts'

const window = (id: string, status?: WindowResource['status']): WindowResource => ({ id, name: id, status })
const fixture = (): SourceResource[] => [{ id: 'a', name: 'a', status: 'online', spaces: [
  { id: 'first', name: 'first', windows: [window('working-1', 'working'), window('done-1', 'done'), window('working-2', 'working'), window('attention', 'attention'), window('done-2', 'done'), window('idle', 'idle'), window('unknown')] },
  { id: 'second', name: 'second', windows: [window('second-working', 'working'), window('second-done', 'done')] },
  { id: 'empty', name: 'empty', windows: [] },
] }, { id: 'b', name: 'b', status: 'online', spaces: [{ id: 'idle-space', name: 'idle-space', windows: [window('b-idle', 'idle')] }] }]

test('overview status order stays within each space and retains native order for ties', () => {
  const resources = fixture(), original = structuredClone(resources)
  assert.deepEqual(overviewResources(resources, overviewStatuses, 'native')[0]!.spaces[0]!.windows.map(window => window.id), resources[0]!.spaces[0]!.windows.map(window => window.id))
  const sorted = overviewResources(resources, overviewStatuses, 'status')
  assert.deepEqual(sorted[0]!.spaces.map(space => space.id), ['first', 'second'])
  assert.deepEqual(sorted[0]!.spaces[0]!.windows.map(window => window.id), ['attention', 'done-1', 'done-2', 'working-1', 'working-2', 'idle', 'unknown'])
  assert.deepEqual(sorted[0]!.spaces[1]!.windows.map(window => window.id), ['second-done', 'second-working'])
  assert.deepEqual(resources, original)
})

test('overview filtering uses window aggregates, removes empty groups and supports multiple statuses', () => {
  const resources = fixture()
  resources[0]!.spaces[0]!.windows[0]!.panes = [{ id: 'done-pane', name: 'done', status: 'done', active: false }, { id: 'blocked-pane', name: 'blocked', status: 'attention', active: true }]
  resources[0]!.spaces[0]!.windows[0]!.status = 'attention'
  const filtered = overviewResources(resources, ['done', 'unknown'], 'native')
  assert.deepEqual(filtered.map(source => source.id), ['a'])
  assert.deepEqual(filtered[0]!.spaces.map(space => space.id), ['first', 'second'])
  assert.deepEqual(filtered[0]!.spaces[0]!.windows.map(window => window.id), ['done-1', 'done-2', 'unknown'])
  assert.deepEqual(overviewResources(resources, [], 'status'), [])
})

test('status changes alter layout only when filtering or priority ordering changes visible membership/order', () => {
  const resources = fixture(), changed = structuredClone(resources)
  changed[0]!.spaces[0]!.windows[0]!.status = 'done'
  const key = (value: SourceResource[], statuses: readonly WindowResource['status'][], order: 'native' | 'status') => overviewLayoutKey(overviewResources(value, statuses.filter(status => status !== undefined), order))
  assert.equal(key(resources, overviewStatuses, 'native'), key(changed, overviewStatuses, 'native'))
  assert.notEqual(key(resources, overviewStatuses, 'status'), key(changed, overviewStatuses, 'status'))
  assert.notEqual(key(resources, ['done'], 'native'), key(changed, ['done'], 'native'))
  changed[0]!.spaces[0]!.windows[0]!.name = 'renamed'
  assert.equal(key(resources, overviewStatuses, 'native'), key(changed, overviewStatuses, 'native'))
})
