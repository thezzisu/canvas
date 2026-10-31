import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./main.ts', import.meta.url))
const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))
function run(args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-cli-'))
  try {
    return spawnSync(process.execPath, ['--import', loader, entry, ...args], {
      cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: directory, CANVAS_DATA_DIR: join(directory, 'data') }, encoding: 'utf8', timeout: 10000,
    })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('help and version need neither an account nor package working directory', () => {
  const help = run(['--help'])
  assert.equal(help.status, 0); assert.match(help.stdout, /serve.*open.*version/u); assert(!help.stdout.includes('setup'))
  assert.match(help.stdout, /HERDR_SOCKET_PATH and HERDR_PANE_ID/u)
  assert.equal(run(['serve', '--help']).status, 0)
  const version = run(['version'])
  assert.equal(version.status, 0); assert.equal(version.stdout.trim(), 'development')
})

test('unsupported commands and absent open arguments fail without starting the server', () => {
  for (const args of [['setup'], ['unknown'], ['open'], ['serve', '--unknown']]) {
    const result = run(args)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Usage: canvas/u)
  }
})

test('open delegates to the bundled Python core without changing the caller working directory', () => {
  const result = run(['open', '.'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /connected herdr pane/u)
  assert(!result.stderr.includes('file not found'))
  const help = run(['open', '--help'])
  assert.equal(help.status, 0); assert.match(help.stdout, /path/u)
  assert.match(help.stdout, /HERDR_SOCKET_PATH and HERDR_PANE_ID/u)
  assert.match(help.stdout, /each invocation/u)
})
