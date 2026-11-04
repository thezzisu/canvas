import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachmentToken, noteDocument, noteText, serializeNote } from './note-document'

const id = 'b80dd9e4-5825-4e89-8b5b-4dc8619a2783'
test('notes preserve paragraphs, spaces, trailing lines and inline attachment order', () => {
  const content = `  Prompt\n\nLook at ${attachmentToken(id)} then continue.\n`
  const doc = noteDocument(content)
  assert.equal(serializeNote(doc), content)
  assert.equal(doc.content?.[2]?.content?.[1]?.type, 'noteAttachment')
  assert.deepEqual(doc.content?.[2]?.content?.[1]?.attrs, { id })
  assert.equal(noteText(content, [{ id, filename: 'diagram.png', mime: 'image/png', size: 1, createdAt: 0 }]),
    '  Prompt\n\nLook at diagram.png then continue.\n')
})
test('plain notes and invalid attachment syntax remain literal text', () => {
  for (const text of ['', 'Text <script> & **Markdown**', 'a\nb\n', '\uFFFCmissing\uFFFC'])
    assert.equal(serializeNote(noteDocument(text)), text)
})
test('attachment copy uses a safe filename fallback, never raw internal tokens', () => {
  assert.equal(noteText(`File: ${attachmentToken(id)}`), 'File: [file]')
})

test('upload insertion positions survive paragraphs, hard breaks and atomic token widths', async () => {
  const { Schema } = await import('@tiptap/pm/model')
  const schema = new Schema({ nodes: {
    doc: { content: 'paragraph+' }, paragraph: { content: 'inline*', group: 'block' }, text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline' },
    noteAttachment: { inline: true, group: 'inline', atom: true, attrs: { id: {} } },
  } })
  const { noteOffset, notePosition } = await import('./note-document')
  for (const text of ['', '\n', 'a\n\nb\n', `a${attachmentToken(id)}b\n\nc`]) {
    const doc = schema.nodeFromJSON(noteDocument(text))
    const boundaries = new Set<number>()
    doc.descendants((node, position) => {
      if (node.isText) for (let i = 0; i <= node.nodeSize; i++) boundaries.add(position + i)
      else if (node.isInline) { boundaries.add(position); boundaries.add(position + node.nodeSize) }
      else if (node.type.name === 'paragraph' && !node.content.size) boundaries.add(position + 1)
    })
    for (const position of boundaries) assert.equal(notePosition(doc, noteOffset(doc, position)), position, `${JSON.stringify(text)} at ${position}`)
  }
  const doc = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'noteAttachment', attrs: { id } }, { type: 'text', text: 'b' },
  ] }] })
  for (let position = 1; position < doc.content.size; position++) assert.equal(notePosition(doc, noteOffset(doc, position)), position)
})

test('upload fallback preserves existing capsules after another browser changes the body', async () => {
  const { insertNoteContent } = await import('./note-document')
  const insertNoteAttachment = (content: string, offset: number, id: string) => insertNoteContent(content, { content: attachmentToken(id), offset, end: offset, replaced: '' })
  const next = '29698b01-5c04-4f14-983a-0f4e2a9283f1'
  const content = `Short ${attachmentToken(id)} suffix`
  const inserted = insertNoteAttachment(content, 15, next)
  assert.equal(inserted, `Short ${attachmentToken(id)}${attachmentToken(next)} suffix`)
  assert.equal(serializeNote(noteDocument(inserted)), inserted)
  assert.equal(insertNoteAttachment('short', 10000, next), `short${attachmentToken(next)}`)
})
