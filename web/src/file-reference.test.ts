import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CANVAS_FILE_TYPE, parseFileReference, readFileReference, readReferencedFile, writeFileReference, type FileSourceAccess } from './file-reference.ts'

const source = { base: 'https://source.example/prefix/', token: 'DUMMY_SOURCE_TOKEN' }
const reference = { instance: '11111111-1111-4111-8111-111111111111', base: source.base, assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
function response(body: BlobPart = new Uint8Array([0, 255, 10, 13])) {
  return new Response(body as BodyInit, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "inline; filename*=UTF-8''%E5%9B%BE%E7%89%87.bin" } })
}

test('file drag payload binds the saved source identity without a token or fake plain text', () => {
  const values = new Map<string, string>()
  const data = { types: [CANVAS_FILE_TYPE], effectAllowed: 'none', setData: (key: string, value: string) => values.set(key, value), getData: (key: string) => values.get(key) || '' } as unknown as DataTransfer
  assert(writeFileReference(data, reference))
  assert.deepEqual([...values.keys()], [CANVAS_FILE_TYPE])
  assert.deepEqual(readFileReference(data), reference)
  assert.equal(data.effectAllowed, 'copy')
  assert.equal(parseFileReference('{"instance":"https://unknown.example","assetId":"../file"}'), undefined)
  assert.deepEqual(parseFileReference(JSON.stringify({ ...reference, url: 'https://ignored.example' })), reference)
})

test('explicit cross-instance reads use only source credentials and preserve bytes, filename and MIME', async () => {
  const requested: Array<{ url: string; init: RequestInit }> = []
  const file = await readReferencedFile(reference, id => id === reference.instance ? source : undefined, new AbortController().signal,
    async (url, init) => { requested.push({ url: String(url), init: init! }); return response() })
  assert.equal(requested.length, 1)
  assert.equal(requested[0]!.url, `${source.base}api/files/${reference.assetId}`)
  assert.deepEqual(requested[0]!.init.headers, { Authorization: `Bearer ${source.token}` })
  assert.equal(requested[0]!.init.credentials, 'omit')
  assert.equal(requested[0]!.init.redirect, 'error')
  assert.equal(file.name, '图片.bin')
  assert.equal(file.type, 'application/octet-stream')
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([0, 255, 10, 13]))
})

test('unknown or signed-out sources fail without probing or falling back to the current instance', async () => {
  let calls = 0
  const request = async () => { calls++; return response() }
  for (const access of [undefined, { ...source, token: '' }]) {
    await assert.rejects(readReferencedFile(reference, () => access, new AbortController().signal, request), /fileTransfer\.(sourceMissing|loginRequired)/)
  }
  assert.equal(calls, 0)
  await assert.rejects(readReferencedFile(reference, () => ({ ...source, base: 'https://edited.example/' }), new AbortController().signal, request), /fileTransfer.sourceChanged/)
  assert.equal(calls, 0, 'editing a copied source cannot redirect its stored reference to another backend')
  for (const [status, reason] of [[401, 'loginRequired'], [403, 'loginRequired'], [404, 'fileMissing'], [500, 'failed']] as const) {
    await assert.rejects(readReferencedFile(reference, () => source, new AbortController().signal, async () => new Response(null, { status })), new RegExp(`fileTransfer.${reason}`))
  }
})

test('source edits, logout and a target switch discard file bytes before upload', async () => {
  for (const next of [undefined, { ...source, base: 'https://other.example/' }, { ...source, token: 'changed' }]) {
    let access: FileSourceAccess | undefined = source
    await assert.rejects(readReferencedFile(reference, () => access, new AbortController().signal, async () => {
      const result = response(); result.blob = async () => { access = next; return new Blob(['original']) }; return result
    }), /fileTransfer.sourceChanged/)
  }
  const controller = new AbortController()
  await assert.rejects(readReferencedFile(reference, () => source, controller.signal, async () => { controller.abort(); return response() }), { name: 'AbortError' })
})
