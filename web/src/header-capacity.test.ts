import test from 'node:test'
import assert from 'node:assert/strict'
import { headerShortcuts } from './header-capacity.ts'

test('a five-slot phone header retains keyboard and zoom before adding to a canvas', () => {
  assert.deepEqual([...headerShortcuts(238.66, ['keyboard', 'zoom'], true)], ['remove', 'keyboard', 'zoom'])
  assert.deepEqual([...headerShortcuts(264, ['keyboard', 'zoom'], true)], ['remove', 'keyboard', 'zoom', 'add'])
})
test('very narrow regions keep the menu and restore without overflowing a remove button', () => {
  for (const width of [0, 87, 88, 119, NaN]) assert.equal(headerShortcuts(width, ['copy', 'zoom'], true).size, 0)
  assert.deepEqual([...headerShortcuts(132, ['copy', 'zoom'], true)], ['remove'])
})
test('only currently available shortcuts consume space and retention priority does not reorder display', () => {
  assert.deepEqual([...headerShortcuts(176, ['zoom', 'copy'], true, ['copy', 'zoom'])], ['remove', 'copy'])
  assert.deepEqual([...headerShortcuts(176, ['copy'], false, ['copy', 'zoom'])], ['copy', 'add'])
})
