import { Extension } from '@tiptap/core'
import { Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { noteDocument, noteOffset, notePosition, serializeNote } from './note-document'

// Tiptap's splitBlock can reject a selection ending at a paragraph boundary.
// Delete first so its native split command resolves the resulting caret.
export const NoteSelectionEnter = Extension.create({
  name: 'noteSelectionEnter',
  addKeyboardShortcuts() {
    return {
      Enter: () =>
        !this.editor.state.selection.empty &&
        this.editor.chain().deleteSelection().splitBlock().run(),
    }
  },
})

export interface NoteRange {
  offset: number
  end: number
  replaced: string
}
export function noteRange(state: EditorState): NoteRange {
  const offset = noteOffset(state.doc, state.selection.from),
    end = noteOffset(state.doc, state.selection.to)
  return { offset, end, replaced: serializeNote(state.doc.toJSON()).slice(offset, end) }
}

/** The attachment a selection covers exactly; Enter previews it as a click does. */
export function selectedAttachment(state: EditorState): string | undefined {
  const { from, to } = state.selection,
    node = state.doc.nodeAt(from)
  return to === from + 1 && node?.type.name === 'noteAttachment' ? node.attrs.id : undefined
}

/**
 * Apply another writer's content by replacing only the span that differs, so the caret,
 * pending upload ranges and their placeholders map through it like through any edit.
 */
export function replaceNoteDocument(state: EditorState, content: string): Transaction {
  const next = state.schema.nodeFromJSON(noteDocument(content)),
    tr = state.tr
  const start = state.doc.content.findDiffStart(next.content)
  if (start === null) return tr
  let { a, b } = state.doc.content.findDiffEnd(next.content)!
  // Repeated text can match both scans; the end moves past the start as ProseMirror's own DOM diff does.
  const overlap = start - Math.min(a, b)
  if (overlap > 0) {
    a += overlap
    b += overlap
  }
  return tr.replace(start, a, next.slice(start, b))
}

/**
 * Keep a pending range on the same content while the editor changes around it. Both ends
 * keep to the text before them, so text typed at the insertion point lands after the
 * pending files, as it would after the final chips.
 */
export function mapNoteRange(range: NoteRange, tr: Transaction) {
  const before = notePosition(tr.before, range.offset),
    end = notePosition(tr.before, range.end)
  range.offset = noteOffset(tr.doc, tr.mapping.map(before, -1))
  range.end = Math.max(range.offset, noteOffset(tr.doc, tr.mapping.map(end, -1)))
}

/**
 * Display-only chips where a pending upload will insert its files. Like the final
 * chips they are drawn before a caret at that point, which types after them.
 */
export function uploadPlaceholder(
  doc: ProseMirrorNode,
  upload: { offset: number; files: readonly string[] } | undefined,
  render: (files: readonly string[]) => HTMLElement,
  destroy: (dom: Node) => void,
) {
  if (!upload?.files.length) return DecorationSet.empty
  const files = upload.files
  return DecorationSet.create(doc, [
    Decoration.widget(notePosition(doc, upload.offset), () => render(files), {
      key: `upload:${JSON.stringify(files)}`,
      side: -1,
      destroy,
    }),
  ])
}

/** Uploads replace their original range without taking a newer caret or selection. */
export function replaceNoteRange(state: EditorState, value: NoteRange & { content: string }) {
  const selected = noteRange(state)
  const unchanged =
    serializeNote(state.doc.toJSON()).slice(value.offset, value.end) === value.replaced
  const from = notePosition(state.doc, value.offset),
    to = unchanged ? notePosition(state.doc, value.end) : from
  const current = unchanged && selected.offset === value.offset && selected.end === value.end
  const selection = current ? state.selection : TextSelection.create(state.doc, from, to)
  const content = state.schema.nodeFromJSON(noteDocument(value.content)).content
  const tr = state.tr
  selection.replace(tr, new Slice(content, 1, 1))
  if (!current) tr.setSelection(state.selection.map(tr.doc, tr.mapping))
  return tr
}
