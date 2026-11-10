import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor, Node } from '@tiptap/core'
import { AllSelection, EditorState, NodeSelection, TextSelection, type Selection, type Transaction } from '@tiptap/pm/state'
import { closeHistory, history, undo } from '@tiptap/pm/history'
import { NoteSelectionEnter, mapNoteRange, noteRange, replaceNoteRange, uploadPlaceholder } from './note-editing'
import { attachmentToken, noteDocument, noteOffset, notePosition, serializeNote } from './note-document'

const id = '11111111-1111-4111-8111-111111111111'
const extensions = [
  Node.create({ name: 'doc', topNode: true, content: 'paragraph+' }),
  Node.create({ name: 'paragraph', group: 'block', content: 'inline*' }),
  Node.create({ name: 'text', group: 'inline' }),
  Node.create({ name: 'noteAttachment', inline: true, group: 'inline', atom: true, addAttributes: () => ({ id: { default: id } }) }),
  NoteSelectionEnter,
]
const create = (content: string) => new Editor({ element: null, extensions, content: noteDocument(content) })
const text = (state: EditorState) => serializeNote(state.doc.toJSON())

test('Enter replaces forward, reversed, paragraph-boundary and all selections as one undoable edit', () => {
  for (const content of ['测尺侧\n测测\n超参', '\nalpha\n\nbeta\n', `a${attachmentToken(id)}b\nc`]) {
    const editor = create(content), doc = editor.state.doc
    const positions: number[] = []
    for (let i = 0; i <= doc.content.size; i++) if (doc.resolve(i).parent.inlineContent) positions.push(i)
    const selections: Selection[] = positions.flatMap(from => positions.filter(to => to !== from).map(to => TextSelection.create(doc, from, to)))
    selections.push(new AllSelection(doc))
    const enter = NoteSelectionEnter.config.addKeyboardShortcuts!.call({ editor, name: 'noteSelectionEnter', options: {}, storage: {}, type: null, parent: undefined }).Enter!
    for (const selection of selections) {
      editor.view.updateState(EditorState.create({ doc, selection, plugins: [history()] }))
      const { offset, end } = noteRange(editor.state)
      assert(enter({ editor }))
      assert.equal(text(editor.state), `${content.slice(0, offset)}\n${content.slice(end)}`)
      assert(editor.state.selection.empty)
      assert(undo(editor.state, tr => editor.view.updateState(editor.state.apply(tr))))
      assert.equal(text(editor.state), content)
      assert(editor.state.selection.eq(selection), 'Undo restores the original directional selection')
    }
    editor.view.updateState(EditorState.create({ doc }))
    assert.equal(enter({ editor }), false, 'An empty caret retains the upstream Enter handler')
    assert.equal(text(editor.state), content)
    editor.destroy()
  }
})

test('attachment replacement collapses normal, all and capsule selections at the inserted end', () => {
  const content = `before ${attachmentToken(id)} after\nnext`, editor = create(content), doc = editor.state.doc
  const selections = [TextSelection.create(doc, 1, 8), TextSelection.create(doc, 8, 1), new AllSelection(doc), NodeSelection.create(doc, 8)]
  for (const selection of selections) {
    const state = EditorState.create({ doc, selection, plugins: [history()] }), range = noteRange(state)
    const next = state.apply(closeHistory(replaceNoteRange(state, { ...range, content: `${attachmentToken(id)}\nend` })))
    assert.equal(text(next), `${content.slice(0, range.offset)}${attachmentToken(id)}\nend${content.slice(range.end)}`)
    assert(next.selection.empty)
    assert.equal(noteOffset(next.doc, next.selection.from), range.offset + attachmentToken(id).length + 4)
    assert(undo(next, tr => {
      const undone = next.apply(tr)
      assert.equal(text(undone), content)
      assert(undone.selection.eq(selection))
    }))
  }
  editor.destroy()
})

test('delayed insertion preserves a newer caret or directional selection', () => {
  const editor = create('old middle end'), doc = editor.state.doc
  const initial = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 4) }), range = noteRange(initial)
  for (const selection of [TextSelection.create(doc, 9), TextSelection.create(doc, 15, 12)]) {
    const state = initial.apply(initial.tr.setSelection(selection))
    const tr = replaceNoteRange(state, { ...range, content: attachmentToken(id) })
    const next = state.apply(tr)
    assert.equal(text(next), `${attachmentToken(id)} middle end`)
    assert(next.selection.eq(selection.map(tr.doc, tr.mapping)))
  }
  editor.destroy()
})

test('a changed original range is never removed by delayed attachment completion', () => {
  const editor = create('new middle'), state = editor.state
  const range = { offset: 0, end: 3, replaced: 'old', content: attachmentToken(id) }
  const next = state.apply(replaceNoteRange(state, range))
  assert.equal(text(next), `${attachmentToken(id)}new middle`)
  assert(next.selection.empty)
  editor.destroy()
})

test('drop insertion leaves an unrelated selection selected after mapping', () => {
  const editor = create('first\nselected\nlast'), doc = editor.state.doc
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, notePosition(doc, 6), notePosition(doc, 14)) })
  const tr = replaceNoteRange(state, { offset: 2, end: 2, replaced: '', content: attachmentToken(id) })
  const next = state.apply(tr)
  assert.equal(text(next), `fi${attachmentToken(id)}rst\nselected\nlast`)
  assert(next.selection.eq(state.selection.map(tr.doc, tr.mapping)))
  assert.equal(next.doc.textBetween(next.selection.from, next.selection.to), 'selected')
  editor.destroy()
})

test('pending ranges follow typing, deletion and peer replacement around their insertion point', () => {
  const editor = create(`ab${attachmentToken(id)}\ncd`), doc = editor.state.doc
  const range = { offset: 2, end: 2, replaced: '' }
  const apply = (state: EditorState, tr: Transaction) => { mapNoteRange(range, tr); return state.apply(tr) }
  let state = EditorState.create({ doc })
  state = apply(state, state.tr.insertText('X', 1))
  assert.deepEqual(range, { offset: 3, end: 3, replaced: '' }, 'Text before the point moves it')
  state = apply(state, state.tr.insertText('Y', notePosition(state.doc, 3)))
  assert.equal(range.offset, 4, 'Text typed at the point stays in front of the insertion')
  state = apply(state, state.tr.insertText('Z', state.doc.content.size - 1))
  assert.equal(range.offset, 4, 'Text after the point leaves it')
  state = apply(state, state.tr.delete(3, 6))
  assert.equal(text(state), 'Xa\ncdZ')
  assert.equal(range.offset, 2, 'Deleting across the point collapses it to the deletion')
  state = apply(state, state.tr.replaceWith(0, state.doc.content.size, state.schema.nodeFromJSON(noteDocument('peer')).content))
  assert.equal(range.offset, 4, 'A replaced document keeps the insertion at its end')
  editor.destroy()
})

test('upload placeholders are display-only widgets at the mapped insertion point', () => {
  const editor = create(`one ${attachmentToken(id)}\ntwo`), rendered: (readonly string[])[] = []
  const render = (files: readonly string[]) => { rendered.push(files); return {} as HTMLElement }
  let state = EditorState.create({ doc: editor.state.doc })
  const upload = { offset: 4, end: 4, replaced: '', files: [] as string[] }
  assert.equal(uploadPlaceholder(state.doc, undefined, render, () => {}).find().length, 0)
  assert.equal(uploadPlaceholder(state.doc, upload, render, () => {}).find().length, 0, 'Nothing shows before filenames are known')
  upload.files = ['a.png', 'b.txt']
  const widgets = () => uploadPlaceholder(state.doc, upload, render, () => {}).find()
  assert.equal(widgets().length, 1)
  assert.equal(widgets()[0]!.from, notePosition(state.doc, 4))
  assert(widgets()[0]!.spec.side > 0, 'The caret at the point is drawn before the placeholder')
  for (const [position, typed] of [[1, 'A'], [() => notePosition(state.doc, upload.offset), 'B'], [() => state.doc.content.size - 1, 'C']] as const) {
    const tr = state.tr.insertText(typed, typeof position === 'number' ? position : position())
    mapNoteRange(upload, tr); state = state.apply(tr)
  }
  assert.equal(text(state), `Aone B${attachmentToken(id)}\ntwoC`, 'The placeholder never enters the document')
  const at = widgets()[0]!.from
  assert.equal(at, notePosition(state.doc, upload.offset))
  const next = state.apply(replaceNoteRange(state, { ...upload, content: attachmentToken(id) }))
  assert.equal(next.doc.nodeAt(at)?.type.name, 'noteAttachment', 'Completion inserts exactly where the placeholder was')
  assert.equal(text(next), `Aone B${attachmentToken(id)}${attachmentToken(id)}\ntwoC`)
  assert.deepEqual(rendered, [], 'Widgets render only in a view')
  editor.destroy()
})
