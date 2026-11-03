import test from 'node:test'
import assert from 'node:assert/strict'
import type { GraphNode } from '@vue-flow/core'
import { minimapOrder } from './minimap-order.ts'

const node = (id: string, z = 0, type = 'terminal') => ({ id, type, computedPosition: { x: 0, y: 0, z } }) as GraphNode

test('minimap uses native computed elevation across terminal, note and file cards', () => {
  const nodes = [node('selected-terminal', 1000), node('note', 0, 'note'), node('file', 0, 'file'), node('group', -1, 'group')]
  assert.deepEqual(minimapOrder(nodes).map(node => node.id), ['group', 'note', 'file', 'selected-terminal'])
  assert.equal(nodes[0]!.id, 'selected-terminal', 'projection never reorders the source or canvas graph')
  nodes[0]!.computedPosition.z = 0
  nodes[1]!.computedPosition.z = 1000
  assert.deepEqual(minimapOrder(nodes).map(node => node.id), ['group', 'selected-terminal', 'file', 'note'])
})

test('equal-depth cards keep actual graph order and empty graphs remain empty', () => {
  const nodes = [node('file', 5, 'file'), node('terminal', 5), node('note', 5, 'note')]
  assert.deepEqual(minimapOrder(nodes), nodes)
  assert.notEqual(minimapOrder(nodes), nodes)
  assert.deepEqual(minimapOrder([]), [])
})
