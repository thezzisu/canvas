import test from 'node:test'
import assert from 'node:assert/strict'
import { filePreview } from './file-preview.ts'
import { BinaryFileError, readTextPreview } from './text-preview.ts'

test('the browser selects native image, audio, video and PDF viewers from file metadata', () => {
  for (const extension of ['svg', 'bmp', 'ico', 'heic', 'heif', 'tiff', 'avif', 'webp'])
    assert.equal(filePreview({ filename: `image.${extension}`, mime: 'application/octet-stream' }), 'image', extension)
  for (const extension of ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac'])
    assert.equal(filePreview({ filename: `audio.${extension}`, mime: 'application/octet-stream' }), 'audio', extension)
  for (const extension of ['mp4', 'webm', 'mov', 'ogv'])
    assert.equal(filePreview({ filename: `video.${extension}`, mime: 'application/octet-stream' }), 'video', extension)
  assert.equal(filePreview({ filename: 'report.pdf' }), 'pdf')
  for (const extension of ['zip', 'docx', 'xlsx', 'exe'])
    assert.equal(filePreview({ filename: `download.${extension}` }), 'file', extension)
  for (const filename of ['README', 'notes.md', 'page.html', 'data.json', 'script.js'])
    assert.equal(filePreview({ filename }), 'text', filename)
})

test('text probing rejects binary data in the browser and always releases its stream', async () => {
  for (const data of [new Uint8Array([0, 1, 2]), new Uint8Array([255, 254, 0])]) {
    let cancelled = false
    const request = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(data) }, cancel() { cancelled = true },
    }))
    await assert.rejects(readTextPreview('/fixture', data.length, new AbortController().signal, request), BinaryFileError)
    assert(cancelled)
  }
})
