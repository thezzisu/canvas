import test from 'node:test'
import assert from 'node:assert/strict'
import { instanceConfiguration, type CanvasInstance } from './instance-config.ts'

const builtin = { id: 'builtin', name: 'frontend.example', base: 'https://frontend.example/' }
const custom = { id: 'custom', name: 'Personal', base: 'https://backend.example/canvas/' }
const savedBuiltin: CanvasInstance = { ...builtin, builtin: true }

test('local builds discover their same-origin default while retaining explicit selections', () => {
  assert.equal(instanceConfiguration([], '', builtin).active, builtin)
  assert.equal(instanceConfiguration([savedBuiltin, custom], custom.id, builtin).active, custom)
  assert.equal(instanceConfiguration([savedBuiltin], '', builtin).active, savedBuiltin)
})
test('standalone builds have no endpoint and ignore persisted built-in servers', () => {
  const empty = instanceConfiguration([], '')
  assert.deepEqual(empty.instances, [])
  assert.equal(empty.active.base, '')
  const stale = instanceConfiguration([savedBuiltin], savedBuiltin.id)
  assert.deepEqual(stale.instances, [])
  assert.equal(stale.active.base, '')
  const selected = instanceConfiguration([savedBuiltin, custom], savedBuiltin.id)
  assert.deepEqual(selected.instances, [custom])
  assert.equal(selected.active, custom)
})
test('standalone builds keep explicitly added same-origin servers as editable custom entries', () => {
  const manual = { id: 'manual', name: 'My server', base: builtin.base }
  const configured = instanceConfiguration([savedBuiltin, manual, custom], manual.id)
  assert.deepEqual(configured.instances, [manual, custom])
  assert.equal(configured.active, manual)
  assert.equal(configured.active.builtin, undefined)
  assert.deepEqual(instanceConfiguration([], manual.id).active, { id: '', name: '', base: '' })
})
