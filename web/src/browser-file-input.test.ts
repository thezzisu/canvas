import test from 'node:test'
import assert from 'node:assert/strict'
import { hasFileTransfer, readFileTransfer } from './browser-file-input.ts'

function transfer(files: File[], items: Array<{ file?: File | null; directory?: boolean }> = []) {
  return { files, types: ['Files'], items: items.map(item => ({ kind: 'file', getAsFile: () => item.file ?? null,
    webkitGetAsEntry: () => item.directory ? { isDirectory: true } : { isDirectory: false } })) } as unknown as DataTransfer
}
test('file inputs preserve the complete browser selection and fall back to data items', () => {
  const first = new File(['one'], 'one.txt'), second = new File(['two'], 'two.txt')
  for (const data of [transfer([first, second]), transfer([], [{ file: first }, { file: second }])]) {
    assert(hasFileTransfer(data))
    assert.deepEqual(readFileTransfer(data), { files: [first, second] })
  }
  assert.deepEqual(readFileTransfer(null), { files: [] })
})
test('directory and partially unreadable selections are rejected without uploading a subset', () => {
  const file = new File(['keep'], 'one.txt')
  assert.deepEqual(readFileTransfer(transfer([file], [{ file }, { directory: true }])), { files: [], error: 'folders' })
  assert.deepEqual(readFileTransfer(transfer([], [{ file }, { file: null }])), { files: [], error: 'unreadable' })
  assert.deepEqual(readFileTransfer(transfer([file], [{ file }, { file: null }])), { files: [], error: 'unreadable' })
  assert.deepEqual(readFileTransfer(transfer([], [])), { files: [], error: 'unreadable' })
  const inaccessible = transfer([], [{ file }])
  Object.defineProperty(inaccessible.items[0], 'getAsFile', { value() { throw new Error('Unavailable') } })
  assert.deepEqual(readFileTransfer(inaccessible), { files: [], error: 'unreadable' })
  const relative = new File(['data'], 'child.txt')
  Object.defineProperty(relative, 'webkitRelativePath', { value: 'folder/child.txt' })
  assert.deepEqual(readFileTransfer(transfer([relative])), { files: [], error: 'folders' })
})
test('unnamed clipboard images retain bytes with the existing useful default filename', async () => {
  const image = new File([new Uint8Array([1, 2, 3])], '', { type: 'image/png' })
  const result = readFileTransfer(transfer([], [{ file: image }]))
  assert.equal(result.error, undefined)
  assert.equal(result.files[0]?.name, 'clipboard.png')
  assert.deepEqual(new Uint8Array(await result.files[0]!.arrayBuffer()), new Uint8Array([1, 2, 3]))
})
