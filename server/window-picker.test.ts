import test from 'node:test'
import assert from 'node:assert/strict'
import { pickerChecked, pickerGroups, updatePickerSelection } from '../web/src/window-picker.ts'

test('window picker retains configured connection order and excludes added windows from group selection after space moves', () => {
  const sources = [{ id: 'b', name: 'Second machine', transport: 'local' as const }, { id: 'a', name: 'First machine', transport: 'local' as const }]
  const resources = [{ id: 'a', name: 'First machine', status: 'connected', spaces: [{ id: 'space', name: 'Work', windows: [{ id: 'w', name: 'Agent' }] }] },
    { id: 'b', name: 'Second machine', status: 'connected', spaces: [{ id: 'moved', name: 'Work', windows: [{ id: 'existing', name: 'Editor' }, { id: 'new', name: 'Agent' }] }] }]
  const groups = pickerGroups(sources, resources, '', new Set(['b/existing']))
  assert.deepEqual(groups.map(group => group.id), ['b', 'a'])
  assert.deepEqual(groups[0]!.eligible, ['b/moved/new'])
  assert.equal(groups[0]!.spaces[0]!.windows[0]!.added, true)
  assert.deepEqual(pickerGroups(sources, resources, 'editor', new Set(['b/existing']))[0]!.eligible, [])
  assert.equal(pickerGroups(sources, resources, 'first machine', new Set()).length, 1)
})

test('tri-state bulk selection modifies only eligible visible keys and preserves other selections', () => {
  const keys = ['first', 'second']
  assert.equal(pickerChecked(keys, new Set()), false)
  assert.equal(pickerChecked(keys, new Set(['first'])), 'indeterminate')
  assert.equal(pickerChecked(keys, new Set(keys)), true)
  assert.equal(pickerChecked([], new Set(['first'])), false)
  assert.deepEqual(updatePickerSelection(['outside', 'first'], keys, true), ['outside', 'first', 'second'])
  assert.deepEqual(updatePickerSelection(['outside', 'first'], keys, false), ['outside'])
})
