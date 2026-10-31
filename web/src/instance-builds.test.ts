import test from 'node:test'
import assert from 'node:assert/strict'
import { instanceBuild, observeInstanceBuild, staleInstanceBuild, forgetInstanceBuild } from './instance-builds.ts'
import { buildLabel, isBuildInfo } from '../../shared/build-info.ts'

test('observed versions remain attached to the responding instance and address', () => {
  const one = { id: 'one', base: 'https://one.example/canvas/' }, two = { id: 'two', base: 'https://two.example/' }
  const build = { version: '1.2.3', revision: 'a'.repeat(40), dirty: false }
  observeInstanceBuild(one, build)
  assert.deepEqual(instanceBuild(one)?.build, build)
  assert.equal(instanceBuild(two), undefined)
  assert.equal(instanceBuild({ ...one, base: two.base }), undefined)
  staleInstanceBuild(one)
  assert.equal(instanceBuild(one)?.fresh, false)
  assert.equal(instanceBuild(one)?.build.revision, build.revision)
  observeInstanceBuild(one, { ...build, revision: 'b'.repeat(40) })
  assert.equal(instanceBuild(one)?.fresh, true)
  forgetInstanceBuild(one.id)
  assert.equal(instanceBuild(one), undefined)
})

test('missing or invalid version metadata is omitted without fabricating a server revision', () => {
  const instance = { id: 'invalid', base: 'https://canvas.example/' }
  const valid = { version: '0.1.0', revision: null, dirty: false }
  for (const value of [undefined, null, {}, { ...valid, revision: 'frontend-version' }, { ...valid, dirty: 'false' }, { ...valid, version: '' }]) {
    observeInstanceBuild(instance, valid)
    observeInstanceBuild(instance, value)
    assert.equal(instanceBuild(instance), undefined)
    assert.equal(isBuildInfo(value), false)
  }
  assert.equal(buildLabel(valid), '0.1.0')
  assert.equal(buildLabel({ ...valid, revision: 'a'.repeat(40), dirty: true }), '0.1.0 · aaaaaaa *')
})
