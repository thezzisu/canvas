import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { packRelease, isLicenseFile } from './pack.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'canvas-pack-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'), destination = path.join(root, 'output')
  const files = { 'package.json': JSON.stringify({ name: 'canvas-pack-fixture', version: '0.0.0', files: ['dist', 'README.md', 'LICENSE'] }),
    'README.md': '# Fixture\n', LICENSE: 'PROJECT LICENSE\r\nOriginal bytes.\n',
    'dist/web/index.html': '<main>Fixture</main>', 'dist/web/assets/regular.woff2': Buffer.from([0, 1, 255, 8]),
    'dist/web/.vite/license.md': '# Dependency licenses\nCopyright fixture.\n',
    'dist/web/fonts/licenses/Font-OFL.txt': 'OFL original\n', 'dist/web/licenses/Icon.txt': 'Icon original\n' }
  for (const [name, value] of Object.entries(files)) { const file = path.join(source, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value) }
  return { source, destination, files }
}

test('release archive contains one complete license and unchanged runtime bytes without editing source', async t => {
  const f = await fixture(t), [pack] = await packRelease(f), archive = path.join(f.destination, pack.filename)
  assert.deepEqual(pack.files.filter(file => isLicenseFile(file.path)).map(file => file.path), ['LICENSE'])
  const license = execFileSync('tar', ['-xOf', archive, 'package/LICENSE'])
  for (const [name, value] of Object.entries(f.files)) {
    assert.deepEqual(await readFile(path.join(f.source, name)), Buffer.from(value), `${name} source unchanged`)
    if (isLicenseFile(name)) assert(license.includes(Buffer.from(value)), `${name} original license retained`)
    else assert.deepEqual(execFileSync('tar', ['-xOf', archive, `package/${name}`]), Buffer.from(value), `${name} runtime bytes unchanged`)
  }
})

test('missing native license output fails without producing a partial release or editing source', async t => {
  const f = await fixture(t)
  await rm(path.join(f.source, 'dist/web/.vite/license.md'))
  await assert.rejects(packRelease(f), /ENOENT/)
  assert.equal(await readFile(path.join(f.source, 'LICENSE'), 'utf8'), f.files.LICENSE)
  assert.deepEqual(await readdir(f.destination).catch(() => []), [])
})
