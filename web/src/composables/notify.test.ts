import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installNotices, notify } from './notify'

test('the same notice again is the same toast; an explicit id is kept', () => {
  const shown: { id?: string | number }[] = []
  installNotices((notice) => shown.push(notice))
  notify.error(new Error('Disk full'))
  notify.error(new Error('Disk full'))
  notify.error(new Error('Disk full'), { description: 'on cctl' })
  notify.info('Copied', { id: 'copy' })
  assert.equal(shown[0]!.id, shown[1]!.id, 'a repeat pulses the toast already showing')
  assert.notEqual(shown[0]!.id, shown[2]!.id)
  assert.equal(shown[3]!.id, 'copy')
})
