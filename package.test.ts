import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('native npm packaging keeps only the unmodified project LICENSE and preserves runtime bytes', async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'canvas-native-pack-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const sourcePackage = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  const license = await readFile(new URL('./LICENSE', import.meta.url))
  const files = new Map<string, string | Buffer>([
    ['package.json', JSON.stringify({ name: 'canvas-pack-fixture', version: '0.0.0', files: sourcePackage.files })],
    ['LICENSE', license], ['README.md', '# Fixture'], ['dist/cli/main.js', 'console.log("fixture")'],
    ['dist/web/assets/font.woff2', Buffer.from([0, 1, 255])],
    ['dist/web/.vite/license.md', 'Old generated notice'], ['dist/web/licenses/Icon.txt', 'Icon notice'],
    ['dist/web/fonts/licenses/Font-OFL.txt', 'Font notice'],
    ['npm-user.conf', ''], ['npm-global.conf', ''],
  ])
  for (const [name, value] of files) { const target = path.join(fixture, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, value) }
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--userconfig', path.join(fixture, 'npm-user.conf'), '--globalconfig', path.join(fixture, 'npm-global.conf'), '--cache', path.join(fixture, 'cache')], { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.deepEqual(pack.files.map((file: { path: string }) => file.path).sort(), ['LICENSE', 'README.md', 'dist/cli/main.js', 'dist/web/assets/font.woff2', 'package.json'])
  const archive = path.join(fixture, pack.filename)
  assert.deepEqual(execFileSync('tar', ['-xOf', archive, 'package/LICENSE']), license)
  for (const name of ['dist/cli/main.js', 'dist/web/assets/font.woff2']) assert.deepEqual(execFileSync('tar', ['-xOf', archive, `package/${name}`]), Buffer.from(files.get(name)!))
  assert.deepEqual(await readFile(path.join(fixture, 'LICENSE')), license)
})
