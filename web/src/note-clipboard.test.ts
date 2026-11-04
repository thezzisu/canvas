import assert from 'node:assert/strict'
import { test } from 'node:test'
import { noteClipboard, clipboardText, parseNoteClipboard, loadNoteClipboard, terminalNoteClipboard } from './note-clipboard'
import { attachmentToken, insertNoteContent, noteDocument, serializeNote } from './note-document'

const id = '11111111-1111-4111-8111-111111111111', instance = { id: '22222222-2222-4222-8222-222222222222', base: 'https://source.example/subpath/' }
const asset = { id, filename: 'image.png', mime: 'image/png', size: 3, createdAt: 0 }
test('selected note clipboard preserves whitespace and attachment positions without credentials', () => {
  const copied = noteClipboard(`First\n${attachmentToken(id)} then ${attachmentToken(id)}\n`, [asset], instance)
  assert.equal(clipboardText(copied), 'First\nimage.png then image.png\n')
  assert.deepEqual(parseNoteClipboard(JSON.stringify(copied)), copied)
  assert.deepEqual(copied.parts[1], { reference: { instance: instance.id, base: instance.base, assetId: id }, filename: 'image.png' })
  assert.throws(() => noteClipboard(attachmentToken(id), [], instance), /fileTransfer.fileMissing/)
})
test('clipboard rejects malformed references, excess files and oversized data', () => {
  for (const value of ['invalid', '{}', '{"parts":[]}', '{"parts":[{"reference":null}]}', JSON.stringify({ parts: [{ reference: { instance: 'missing' }, filename: 'x' }] }), 'x'.repeat(1024 * 1024 + 1)])
    assert.equal(parseNoteClipboard(value), undefined)
  const file = noteClipboard(attachmentToken(id), [asset], instance).parts[0]
  assert(parseNoteClipboard(JSON.stringify({ parts: Array(65).fill(file) })), 'repeated references do not multiply file uploads')
  const unique = Array.from({ length: 65 }, (_, index) => ({ ...file as object, reference: { instance: instance.id, base: instance.base, assetId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` } }))
  assert.equal(parseNoteClipboard(JSON.stringify({ parts: unique })), undefined)
  assert.deepEqual(parseNoteClipboard(JSON.stringify({ parts: ['safe'], token: 'DUMMY_TEST_TOKEN' })), { parts: ['safe'] })
})
test('source assets load once with original bytes and preserve repeated inline occurrences', async () => {
  const copied = noteClipboard(`A ${attachmentToken(id)} B ${attachmentToken(id)} C`, [asset], instance)
  const calls: unknown[] = []
  const result = await loadNoteClipboard(copied, async reference => { calls.push(reference); return new File(['png'], 'image.png', { type: 'image/png' }) })
  assert.equal(calls.length, 1)
  assert.equal(await result.files[0]!.text(), 'png')
  assert.deepEqual(result.parts, ['A ', { file: 0, format: 'path' }, ' B ', { file: 0, format: 'path' }, ' C'])
  await assert.rejects(loadNoteClipboard(copied, async () => { throw new Error('fileTransfer.fileMissing') }), /fileTransfer.fileMissing/)
})
test('pending paste fallback replaces only the unchanged original selection and never splits another capsule', () => {
  assert.equal(insertNoteContent('before old after', { content: attachmentToken(id), offset: 7, end: 10, replaced: 'old' }), `before ${attachmentToken(id)} after`)
  assert.equal(insertNoteContent('before new after', { content: 'paste', offset: 7, end: 10, replaced: 'old' }), 'before pastenew after')
  const original = attachmentToken(id)
  const result = insertNoteContent(original, { content: 'paste', offset: 4, end: 7, replaced: '111' })
  assert.equal(result, `${original}paste`)
  assert.equal(serializeNote(noteDocument(result)), result)
})

test('file-only terminal selections preserve duplicate occurrences as separate file pastes', async () => {
  const note = noteClipboard(`${attachmentToken(id)}${attachmentToken(id)}`, [asset], instance)
  const loaded = await loadNoteClipboard(note, async () => new File(['png'], 'image.png'))
  const paste = terminalNoteClipboard(loaded)
  assert.equal(paste.parts, undefined)
  assert.equal(paste.files.length, 2)
  assert.equal(paste.files[0], paste.files[1], 'load original bytes once; upload each explicit occurrence')
  assert.equal(terminalNoteClipboard({ ...loaded, parts: ['Text ', ...loaded.parts] }).parts?.length, 3)
})
