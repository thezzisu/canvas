import { Extension } from '@tiptap/core'
import { Slice } from '@tiptap/pm/model'
import { TextSelection, type EditorState } from '@tiptap/pm/state'
import { noteDocument, noteOffset, notePosition, serializeNote } from './note-document'

// Tiptap's splitBlock can reject a selection ending at a paragraph boundary.
// Delete first so its native split command resolves the resulting caret.
export const NoteSelectionEnter = Extension.create({
  name: 'noteSelectionEnter',
  addKeyboardShortcuts() {
    return { Enter: () => !this.editor.state.selection.empty && this.editor.chain().deleteSelection().splitBlock().run() }
  },
})

export interface NoteRange { offset: number; end: number; replaced: string }
export function noteRange(state: EditorState): NoteRange {
  const offset = noteOffset(state.doc, state.selection.from), end = noteOffset(state.doc, state.selection.to)
  return { offset, end, replaced: serializeNote(state.doc.toJSON()).slice(offset, end) }
}

/** Uploads replace their original range without taking a newer caret or selection. */
export function replaceNoteRange(state: EditorState, value: NoteRange & { content: string }) {
  const selected = noteRange(state)
  const unchanged = serializeNote(state.doc.toJSON()).slice(value.offset, value.end) === value.replaced
  const from = notePosition(state.doc, value.offset), to = unchanged ? notePosition(state.doc, value.end) : from
  const current = unchanged && selected.offset === value.offset && selected.end === value.end
  const selection = current ? state.selection : TextSelection.create(state.doc, from, to)
  const content = state.schema.nodeFromJSON(noteDocument(value.content)).content
  const tr = state.tr
  selection.replace(tr, new Slice(content, 1, 1))
  if (!current) tr.setSelection(state.selection.map(tr.doc, tr.mapping))
  return tr
}
