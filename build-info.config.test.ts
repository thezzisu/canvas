import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBuildInfo, serverBuildModule } from './build-info.config.ts'

test('build identity is deterministic and emitted server metadata needs no checkout at runtime', async t => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-build-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  writeFileSync(join(root, 'package.json'), '{"version":"2.3.4"}\n')
  git('init'); git('add', 'package.json'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
  const info = readBuildInfo(root)
  assert.deepEqual(info, { version: '2.3.4', revision: git('rev-parse', 'HEAD'), dirty: false })
  assert.equal(serverBuildModule(readBuildInfo(root)), serverBuildModule(info))
  writeFileSync(join(root, 'changed.txt'), 'synthetic build input')
  assert.equal(readBuildInfo(root).dirty, true)
  const module = serverBuildModule(info)
  rmSync(join(root, '.git'), { recursive: true })
  const runtime = await import(`data:text/javascript,${encodeURIComponent(module)}`)
  assert.deepEqual(runtime.buildInfo, info)
  assert(Object.isFrozen(runtime.buildInfo))
  assert.deepEqual(readBuildInfo(root), { version: '2.3.4', revision: null, dirty: false })
})
