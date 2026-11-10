import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import manifest from 'material-icon-theme/dist/material-icons.json' with { type: 'json' }
import { fileIconResolver } from './file-icon.ts'

const resolve = fileIconResolver(manifest)

test('file names take precedence over extensions and match case-insensitively', () => {
  assert.equal(resolve('package.json'), manifest.fileNames['package.json'])
  assert.equal(resolve('PACKAGE.JSON'), manifest.fileNames['package.json'])
  assert.equal(resolve('Dockerfile'), manifest.fileNames.dockerfile)
  assert.equal(resolve('pkgbuild'), manifest.fileNames.PKGBUILD)
  assert.equal(resolve('src/web/.gitignore'), manifest.fileNames['.gitignore'])
})

test('the longest matching extension wins before shorter ones', () => {
  assert.equal(resolve('types.d.ts'), manifest.fileExtensions['d.ts'])
  assert.notEqual(resolve('types.d.ts'), resolve('main.ts'))
  assert.equal(resolve('main.ts'), manifest.fileExtensions.ts)
  assert.equal(resolve('Photo.PNG'), manifest.fileExtensions.png)
  assert.equal(resolve('grammar.yaml-tmlanguage'), manifest.fileExtensions['YAML-tmLanguage'])
})

test('unknown and extensionless names fall back to the default file icon', () => {
  for (const name of ['', 'README-notes', 'archive.unknownext', 'trailing.']) assert.equal(resolve(name), manifest.file)
})

test('every resolvable icon ships an SVG outside the excluded folder and light variants', () => {
  for (const icon of new Set([manifest.file, ...Object.values(manifest.fileNames), ...Object.values(manifest.fileExtensions)])) {
    const file = (manifest.iconDefinitions as Record<string, { iconPath: string }>)[icon].iconPath.split('/').at(-1)!
    assert(existsSync(new URL(`../../node_modules/material-icon-theme/icons/${file}`, import.meta.url)), file)
    assert(!file.startsWith('folder') && !file.includes('_light.'), file)
  }
})
