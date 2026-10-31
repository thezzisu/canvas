import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { createFontLoader } from './font-loading.ts'
import { fontChain, type ResolvedFont } from './font-catalog.ts'

class Face {
  status: FontFaceLoadStatus = 'unloaded'
  calls = 0
  constructor(readonly family: string, readonly style: string, readonly weight: string, private complete: () => Promise<void> = async () => {}) {}
  load(): Promise<FontFace> {
    this.calls++
    this.status = 'loading'
    return this.complete().then(() => { this.status = 'loaded'; return this as unknown as FontFace }, error => { this.status = 'error'; throw error })
  }
}
const chain = fontChain({ stack: [{ family: 'Maple Mono NF CN' }, { family: 'Cascadia Code PL' }, { family: 'monospace' }], ligatures: false })
function oneFace(font: ResolvedFont): ResolvedFont {
  return { ...font, bundled: { ...font.bundled!, faces: font.bundled!.faces.slice(0, 1) } }
}
const url = (file: string) => `/assets/${file.replaceAll('/', '-')}-A1b2C3d4.woff2`
const timeoutError = () => new Error('timeout')

test('a failed face retries alone at its immutable URL; successful native styles are reused', async () => {
  const primary = chain[0]!
  // The stylesheet can have an unloaded alias whose shared source remembers a
  // failure from another family. It must not poison the new application.
  const poisoned = new Face(primary.family, 'normal', '400', async () => { throw new Error('old CSS source failed') })
  const fonts = new Set([poisoned]) as unknown as FontFaceSet
  const created: { source: string; face: Face }[] = []
  const loader = createFontLoader({ fonts, url, timeoutError, createFace: (family, source, descriptors) => {
    const face = new Face(family, descriptors.style!, descriptors.weight!, created.length === 1 ? async () => { throw new Error('temporary failure') } : undefined)
    created.push({ source, face })
    return face as unknown as FontFace
  } })
  await assert.rejects(loader.load(primary), /temporary failure/)
  assert.equal(loader.available(primary), false)
  assert.equal(created.length, 4)
  assert.equal(poisoned.calls, 0)
  await loader.load(primary)
  assert.equal(loader.available(primary), true)
  assert.equal(created.length, 5)
  assert.equal(created[4]!.source, `url(${JSON.stringify(url(primary.bundled!.faces[1]!.file))}) format("woff2")`)
  assert(created.every(({ face }) => face.calls === 1))
  await loader.load(primary)
  assert.equal(created.length, 5)
})

test('concurrent calls and a UI timeout retain the in-flight download', async () => {
  const primary = oneFace(chain[0]!)
  const pending = Promise.withResolvers<void>()
  const created: Face[] = []
  const loader = createFontLoader({ fonts: new Set() as unknown as FontFaceSet, url, timeoutError, timeout: 10, createFace: (family, _source, descriptors) => {
    const face = new Face(family, descriptors.style!, descriptors.weight!, () => pending.promise)
    created.push(face)
    return face as unknown as FontFace
  } })
  await assert.rejects(loader.load(primary), /timeout/)
  assert.equal(loader.available(primary), false)
  const retry = loader.load(primary)
  const concurrent = loader.load(primary)
  pending.resolve()
  await Promise.all([retry, concurrent])
  assert.equal(created.length, 1)
  assert.equal(created[0]!.calls, 1)
  assert.equal(loader.available(primary), true)
})

test('primary readiness does not wait for optional families; only a complete native family becomes available', async () => {
  const fallback = Promise.withResolvers<void>()
  const bold = Promise.withResolvers<void>()
  let applied = 0
  const loader = createFontLoader({ fonts: new Set() as unknown as FontFaceSet, url, timeoutError, createFace: (family, _source, descriptors) => {
    const wait = family === chain[1]!.family ? () => fallback.promise
      : descriptors.weight === '700' && descriptors.style === 'normal' ? () => bold.promise : undefined
    return new Face(family, descriptors.style!, descriptors.weight!, wait) as unknown as FontFace
  } })
  let prepared = false
  const prepare = loader.prepare(chain, () => { applied++ }).then(() => { prepared = true })
  await setImmediate()
  assert.equal(prepared, false)
  assert.equal(loader.available(chain[0]!), false)
  bold.resolve()
  await prepare
  assert.equal(loader.available(chain[0]!), true)
  assert.equal(loader.available(chain[1]!), false)
  assert.equal(loader.available(chain[2]!), true)
  assert.equal(applied, 0)
  fallback.resolve()
  await setImmediate()
  assert.equal(loader.available(chain[1]!), true)
  assert.equal(applied, 1)
})

test('an optional failure preserves the usable primary and can recover on the next application', async () => {
  let fail = true
  let ready = 0
  const loader = createFontLoader({ fonts: new Set() as unknown as FontFaceSet, url, timeoutError, createFace: (family, _source, descriptors) =>
    new Face(family, descriptors.style!, descriptors.weight!, async () => {
      if (family === chain[1]!.family && fail) throw new Error('optional failed')
    }) as unknown as FontFace,
  })
  await loader.prepare(chain, () => { ready++ })
  await setImmediate()
  assert.equal(loader.available(chain[0]!), true)
  assert.equal(loader.available(chain[1]!), false)
  assert.equal(ready, 0)
  fail = false
  await loader.prepare(chain, () => { ready++ })
  await setImmediate()
  assert.equal(loader.available(chain[1]!), true)
  assert.equal(ready, 1)
})
