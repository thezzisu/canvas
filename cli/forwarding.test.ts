import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./canvas', import.meta.url))
function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'canvas-forward-')), bin = join(root, 'helper'), npm = join(root, 'npm')
  mkdirSync(bin); mkdirSync(npm)
  const installed = join(bin, 'canvas'); copyFileSync(helper, installed)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const run = (args: string[], extra = {}) => spawnSync('python3', [installed, ...args], {
    cwd: root, encoding: 'utf8', timeout: 5000, env: { PATH: `${bin}:${npm}:/usr/bin:/bin`, HOME: root, ...extra },
  })
  function packageEntry(name = '@thezzisu/canvas', binValue = 'dist/cli/main.js') {
    const packageRoot = join(root, 'package'), entry = join(packageRoot, 'dist/cli/main.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, bin: { canvas: binValue } }))
    writeFileSync(entry, '#!/usr/bin/env python3\nimport json,os,sys\nprint(json.dumps({"args":sys.argv[1:],"cwd":os.getcwd()}))\nsys.exit(7)\n', { mode: 0o755 })
    symlinkSync(entry, join(npm, 'canvas'))
    return entry
  }
  return { root, bin, npm, installed, run, packageEntry }
}

test('a helper preceding a later npm CLI forwards all arguments and cwd without shell interpretation', t => {
  const f = fixture(t); f.packageEntry()
  const args = ['serve', 'literal spaces', '$(not-a-command)', '中文']
  const result = f.run(args)
  assert.equal(result.status, 7)
  assert.deepEqual(JSON.parse(result.stdout), { args, cwd: f.root })
})

test('direct bundled-core mode cannot forward back into the npm CLI', t => {
  const f = fixture(t); f.packageEntry()
  const result = f.run(['open', '.'], { CANVAS_HELPER_DIRECT: '1' })
  assert.equal(result.status, 1); assert.match(result.stderr, /connected herdr pane/u); assert.equal(result.stdout, '')
})

test('unrelated same-name tools are never executed to detect the product', t => {
  const f = fixture(t)
  writeFileSync(join(f.npm, 'canvas'), '#!/bin/sh\necho SHOULD_NOT_EXECUTE\n', { mode: 0o755 })
  const result = f.run(['--help'])
  assert.equal(result.status, 0); assert(!result.stdout.includes('SHOULD_NOT_EXECUTE')); assert.match(result.stdout, /Open a file/u)
})

test('package name and bin target must both identify this CLI', t => {
  for (const [name, bin] of [['another-canvas', 'dist/cli/main.js'], ['@thezzisu/canvas', 'unrelated.js']]) {
    const f = fixture(t); f.packageEntry(name, bin)
    const result = f.run(['--help']); assert.equal(result.status, 0); assert.match(result.stdout, /Open a file/u)
  }
})

test('symbolic and hard links to the helper cannot cause recursive forwarding', t => {
  const f = fixture(t), hard = join(f.root, 'hard'), symbolic = join(f.root, 'symbolic')
  mkdirSync(hard); mkdirSync(symbolic); linkSync(f.installed, join(hard, 'canvas')); symlinkSync(f.installed, join(symbolic, 'canvas'))
  f.packageEntry()
  const result = f.run(['version'], { PATH: `${hard}:${symbolic}:${f.bin}:${f.npm}:/usr/bin:/bin` })
  assert.equal(result.status, 7); assert.deepEqual(JSON.parse(result.stdout).args, ['version'])
  assert.deepEqual(readFileSync(f.installed), readFileSync(helper))
})
