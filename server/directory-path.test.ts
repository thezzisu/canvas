import { test } from 'node:test'
import assert from 'node:assert/strict'
import { directoryPath } from './directory-path.ts'

test('directory paths remain absolute, bounded, normalized source paths', () => {
  for (const path of [
    'project',
    '../project',
    '/tmp/\ncontrol',
    '/tmp/\0bad',
    '/tmp/\ud800bad',
    '/' + 'a'.repeat(8192),
  ])
    assert.throws(() => directoryPath(path))
  assert.equal(directoryPath('/workspace/dev/../project//'), '/workspace/project/')
  assert.equal(
    directoryPath("/workspace/开发/项目 #?/100% 'final'"),
    "/workspace/开发/项目 #?/100% 'final'",
  )
})
