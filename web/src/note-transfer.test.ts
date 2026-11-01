import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTE_TEXT_TYPE, claimNoteDrop, isNoteTransfer, readNoteTransfer, rejectNoteCardDrop, writeNoteTransfer } from './note-transfer.ts'
import { CANVAS_FILE_TYPE } from './file-reference.ts'

function transfer(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return { get types() { return [...values.keys()] }, effectAllowed: 'uninitialized', dropEffect: 'none',
    setData(type: string, value: string) { values.set(type, value) }, getData(type: string) { return values.get(type) || '' } } as unknown as DataTransfer
}
function drag(data: DataTransfer | null, type = 'drop') {
  let stopped = false
  const event = Object.assign(new Event(type, { cancelable: true }), { dataTransfer: data, stopPropagation() { stopped = true } }) as unknown as DragEvent
  return { event, stopped: () => stopped }
}

test('note dragging preserves the complete plain text without a filename, title or appended Enter', () => {
  const data = transfer(), text = '  中文\ncat [input]\n\tlast line '
  assert(writeNoteTransfer(data, text))
  assert.equal(data.effectAllowed, 'copy')
  assert.deepEqual(data.types, [NOTE_TEXT_TYPE, 'text/plain'])
  assert.equal(readNoteTransfer(data), text)
  assert.equal(data.getData('text/plain'), text)
  assert.equal(writeNoteTransfer(transfer(), ''), false)
  assert.equal(writeNoteTransfer(null, text), false)
})

test('note handlers leave ordinary text and file drops unchanged', () => {
  for (const data of [transfer({ 'text/plain': 'external text' }), transfer({ Files: '', [NOTE_TEXT_TYPE]: 'note' })]) {
    const f = drag(data)
    assert.equal(isNoteTransfer(data), false)
    assert.equal(claimNoteDrop(f.event, true), false)
    assert.equal(readNoteTransfer(data), '')
    assert(!f.event.defaultPrevented && !f.stopped())
  }
})

test('note drops advertise copy only to an available target and suppress native fallback when blocked', () => {
  const data = transfer({ [NOTE_TEXT_TYPE]: 'note', 'text/plain': 'note' }), f = drag(data)
  assert(claimNoteDrop(f.event, true))
  assert.equal(data.dropEffect, 'copy')
  assert(f.event.defaultPrevented && f.stopped())
  assert(claimNoteDrop(f.event, false))
  assert.equal(data.dropEffect, 'none')
  assert.equal(data.getData(NOTE_TEXT_TYPE), 'note', 'dropping never mutates the source')
})

test('note cards reject internal note and file transfers before native text insertion', () => {
  const payloads: Record<string, string>[] = [{ [NOTE_TEXT_TYPE]: 'note', 'text/plain': 'note' }, { [CANVAS_FILE_TYPE]: 'file' }, { [NOTE_TEXT_TYPE]: 'note', Files: '' }]
  for (const payload of payloads) {
    const data = transfer(payload)
    for (const type of ['dragenter', 'dragover', 'drop']) {
      data.dropEffect = 'copy'
      const f = drag(data, type)
      assert(rejectNoteCardDrop(f.event))
      assert(f.event.defaultPrevented && f.stopped())
      assert.equal(data.dropEffect, 'none')
      for (const [format, value] of Object.entries(payload)) assert.equal(data.getData(format), value)
    }
  }
})

test('note card rejection leaves external text and file handlers untouched', () => {
  for (const data of [null, transfer({ 'text/plain': 'external text' }), transfer({ 'text/html': '<b>text</b>' }), transfer({ Files: '' })]) {
    const f = drag(data)
    assert.equal(rejectNoteCardDrop(f.event), false)
    assert(!f.event.defaultPrevented && !f.stopped())
  }
})
