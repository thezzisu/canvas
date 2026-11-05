<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useFileDialog } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UEditor from '@nuxt/ui/components/Editor.vue'
import { Extension, Node, type Editor, type EditorOptions } from '@tiptap/core'
import { dropCursor } from '@tiptap/pm/dropcursor'
import type { EditorView } from '@tiptap/pm/view'
import { Plugin } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { Slice } from '@tiptap/pm/model'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { apiContext, segment } from '../api'
import { hasFileTransfer, readFileTransfer } from '../browser-file-input'
import { presentDownload, reportDownloadError } from '../downloads'
import { attachmentToken, noteDocument, noteOffset, notePosition, serializeNote } from '../note-document'
import { NoteSelectionEnter, noteRange, replaceNoteRange, type NoteRange } from '../note-editing'
import { noteUpload, uploadNoteAttachment, pasteNoteAttachments, type NoteInsertion } from '../note-uploads'
import { clipboardText, noteClipboard, readNoteClipboard, NOTE_CLIPBOARD_TYPE } from '../note-clipboard'
import { clearCopiedFile } from '../file-clipboard'
import { beginCopyFeedback } from '../copy-feedback'
import type { FileAsset } from '../types'
import NoteAttachment from './NoteAttachment.vue'
import { useNoteScroll } from '../note-scroll'

const props = defineProps<{ content: string; attachments: FileAsset[]; canvasId: string; noteId: string; scrollKey: string; readOnly: boolean; insertAttachment: (value: NoteInsertion) => void }>()
const emit = defineEmits<{ change: [content: string]; flush: [] }>()
const { t } = useI18n()
const input = ref<{ editor?: Editor }>()
// The editor owns its document. Its initial value is fixed: echoing editor output
// back through v-model can replace the DOM under an active IME composition.
const initial = noteDocument(props.content)
const shell = ref<HTMLElement>()
useNoteScroll(shell, '.note-editor-content', () => props.scrollKey)
const uploaded = shallowRef<FileAsset[]>([])
const assets = computed(() => [...props.attachments, ...uploaded.value.filter(asset => !props.attachments.some(item => item.id === asset.id))])
const task = computed(() => noteUpload(props.noteId))
const pending = computed(() => !!task.value)
const extension = Node.create({
  name: 'noteAttachment', inline: true, group: 'inline', atom: true, selectable: true,
  addOptions: () => ({ assets: () => assets.value, preview: (asset: FileAsset) => {
    if (asset) void presentDownload({ ...asset, url: `/api/files/${segment(asset.id)}` }).catch(reportDownloadError)
  } }),
  addAttributes: () => ({ id: { default: null } }),
  parseHTML: () => [],
  renderText: ({ node }) => assets.value.find(asset => asset.id === node.attrs.id)?.filename ?? '[file]',
  renderHTML: ({ node }) => ['span', { 'data-note-attachment': node.attrs.id }, '[file]'],
  addNodeView: () => VueNodeViewRenderer(NoteAttachment),
})
const sizeLimit = Extension.create({
  name: 'noteSizeLimit',
  addProseMirrorPlugins: () => [new Plugin({ filterTransaction(transaction) {
    if (!transaction.docChanged || serializeNote(transaction.doc.toJSON()).length <= 200_000) return true
    queueMicrotask(() => fail('panels.note.tooLong'))
    return false
  } })],
})
const fileDropCursor = Extension.create({
  name: 'noteFileDropCursor',
  addProseMirrorPlugins: () => [dropCursor({ color: 'var(--accent)', width: 2, class: 'note-file-dropcursor' })],
  extendNodeSchema: () => ({ disableDropCursor: (_view: EditorView, _position: unknown, event: DragEvent) =>
    props.readOnly || pending.value || !hasFileTransfer(event.dataTransfer) }),
})
// Contents this editor produced recently; a delayed copy of one is an echo, not a peer edit.
const produced: string[] = []
// The last content both the editor and its owner agreed on.
let synced = props.content
function emitContent(content: string) {
  produced.push(content); if (produced.length > 32) produced.shift()
  synced = content
  emit('change', content)
}
function changed() {
  const current = editor()
  // A composition is one edit: neither save nor publish its intermediate preedit.
  if (!current || current.isDestroyed || current.view.composing) return
  const content = serializeNote(current.getJSON())
  if (content !== props.content) emitContent(content)
}
function synchronize() {
  const current = editor(), content = props.content
  // Applying a peer edit replaces the DOM; never do so under an active composition.
  if (!current || current.isDestroyed || current.view.composing) return
  const local = serializeNote(current.getJSON())
  if (content === local) { produced.length = 0; synced = content; return }
  if (produced.includes(content)) return
  const position = current.state.selection.from
  current.commands.setContent(noteDocument(content), { emitUpdate: false })
  current.commands.setTextSelection(Math.min(position, current.state.doc.content.size))
  synced = content
}
watch(() => props.content, synchronize)
// ProseMirror finishes a composition shortly after compositionend. A composition
// that changed nothing yields to a peer edit received meanwhile.
function compositionEnded() {
  setTimeout(() => {
    const current = editor()
    if (!current || current.isDestroyed || current.view.composing) return
    if (serializeNote(current.getJSON()) === synced) synchronize(); else changed()
  }, 30)
  return false
}
function fail(key: string) { window.dispatchEvent(new CustomEvent('canvas:error', { detail: new Error(t(key)) })) }
function editor() { return input.value?.editor }
const transaction: EditorOptions['onTransaction'] = ({ transaction }) => {
  if (!transaction.docChanged) return
  for (const range of [task.value, selection?.range]) {
    if (!range) continue
    const before = notePosition(transaction.before, range.offset), end = notePosition(transaction.before, range.end)
    range.offset = noteOffset(transaction.doc, transaction.mapping.map(before))
    range.end = Math.max(range.offset, noteOffset(transaction.doc, transaction.mapping.map(end, -1)))
  }
}
function insert(value: NoteInsertion) {
  const current = editor()
  if (!current || current.isDestroyed) return false
  uploaded.value = [...uploaded.value, ...value.assets]
  const tr = replaceNoteRange(current.state, value)
  closeHistory(tr); current.view.dispatch(tr)
  current.view.dispatch(closeHistory(current.state.tr))
  return true
}
watch(task, (current, previous) => {
  if (previous?.insert === insert) previous.insert = undefined
  if (current) current.insert = insert
}, { immediate: true, flush: 'sync' })
function upload(files: File[], range?: NoteRange) {
  if (props.readOnly) return
  if (pending.value) { fail('panels.file.uploadBusy'); return }
  if (!files.length || files.length !== 1) { fail('panels.file.singleOnly'); return }
  const file = files[0]!, current = editor()
  if (file.webkitRelativePath) { fail('terminal.upload.foldersUnsupported'); return }
  if (!current) return
  void uploadNoteAttachment(props.canvasId, props.noteId, file, range ?? noteRange(current.state), props.insertAttachment)
}
function copy(event: ClipboardEvent, cut = false) {
  const current = editor(), data = event.clipboardData
  if (!current || !data || current.state.selection.empty || props.readOnly) return false
  clearCopiedFile()
  const { from, to } = current.state.selection
  const content = current.state.doc.textBetween(from, to, '\n', node => node.type.name === 'noteAttachment' ? attachmentToken(node.attrs.id) : '\n')
  try {
    const note = noteClipboard(content, assets.value, apiContext())
    data.setData('text/plain', clipboardText(note))
    if (note.parts.some(part => typeof part !== 'string')) data.setData(NOTE_CLIPBOARD_TYPE, JSON.stringify(note))
    event.preventDefault()
    if (cut) current.commands.deleteSelection()
    beginCopyFeedback()('copied')
  } catch (error) { event.preventDefault(); reportDownloadError(error) }
  return true
}
function paste(event: ClipboardEvent) {
  const data = event.clipboardData
  if (data?.types.includes(NOTE_CLIPBOARD_TYPE)) {
    event.preventDefault()
    const note = readNoteClipboard(data), current = editor()
    if (!note || !current) { fail('fileTransfer.failed'); return true }
    if (props.readOnly) return true
    if (pending.value) { fail('panels.file.uploadBusy'); return true }
    const { offset, end, replaced } = noteRange(current.state)
    const length = note.parts.reduce((size, part) => size + (typeof part === 'string' ? part.length : 38), 0)
    if (serializeNote(current.state.doc.toJSON()).length - (end - offset) + length > 200_000) { fail('panels.note.tooLong'); return true }
    void pasteNoteAttachments(props.canvasId, props.noteId, note, offset, end, replaced,
      value => { if (!insert(value)) props.insertAttachment(value) }, assets.value)
    return true
  }
  if (!hasFileTransfer(data)) {
    const text = data?.getData('text/plain'), current = editor()
    if (!text || !current || props.readOnly) return false
    event.preventDefault()
    // Notes store plain paragraphs. Use clipboard text rather than importing
    // HTML block spacing or the rich editor's double-newline serialization.
    const content = current.schema.nodeFromJSON(noteDocument(text.replace(/\r\n?/g, '\n'))).content
    const tr = current.state.tr.replaceSelection(new Slice(content, 1, 1)).scrollIntoView()
      .setMeta('paste', true).setMeta('uiEvent', 'paste')
    current.view.dispatch(closeHistory(tr))
    current.view.dispatch(closeHistory(current.state.tr))
    return true
  }
  event.preventDefault()
  const incoming = readFileTransfer(data)
  if (incoming.error) fail(incoming.error === 'folders' ? 'terminal.upload.foldersUnsupported' : 'panels.file.unreadableTransfer')
  else void upload(incoming.files)
  return true
}
const fileDialog = useFileDialog({ multiple: false, reset: true })
let selection: { context: ReturnType<typeof apiContext>; canvasId: string; noteId: string; range: NoteRange } | undefined
function chooseFiles() {
  const current = editor()
  if (props.readOnly || !current) return
  selection = { context: apiContext(), canvasId: props.canvasId, noteId: props.noteId, range: noteRange(current.state) }
  fileDialog.open()
}
fileDialog.onChange(files => {
  if (!files?.length) return
  const target = selection; selection = undefined
  if (target && !target.context.signal.aborted && target.canvasId === props.canvasId && target.noteId === props.noteId)
    void upload([...files], target.range)
})
fileDialog.onCancel(() => { selection = undefined })
function dragOver(event: DragEvent) {
  if (!hasFileTransfer(event.dataTransfer)) return
  event.preventDefault(); event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = props.readOnly || pending.value ? 'none' : 'copy'
}
function drop(event: DragEvent) {
  if (!hasFileTransfer(event.dataTransfer)) return false
  event.preventDefault(); event.stopPropagation()
  const incoming = readFileTransfer(event.dataTransfer)
  if (incoming.error) fail(incoming.error === 'folders' ? 'terminal.upload.foldersUnsupported' : 'panels.file.unreadableTransfer')
  else {
    const current = editor()
    if (current) {
      const position = current.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? current.state.doc.content.size - 1
      const offset = noteOffset(current.state.doc, position)
      void upload(incoming.files, { offset, end: offset, replaced: '' })
    }
  }
  return true
}
watch(() => [props.canvasId, props.noteId], () => { selection = undefined; uploaded.value = [] })
onBeforeUnmount(() => { if (task.value?.insert === insert) task.value.insert = undefined })
defineExpose({ chooseFiles, pending })
</script>

<template>
  <div ref="shell" class="note-editor-shell" @dragenter="dragOver" @dragover="dragOver">
  <UEditor ref="input" :model-value="initial" content-type="json" :starter-kit="false" :image="false" :mention="false" :extensions="[extension, sizeLimit, NoteSelectionEnter, fileDropCursor]" :editable="!readOnly" :enable-input-rules="false" :enable-paste-rules="false" :placeholder="t('panels.note.placeholder')" class="note-editor"
    :ui="{ root: 'h-full min-h-0', content: 'h-full min-h-0', base: 'note-editor-content h-full min-h-0 outline-none' }"
    :editor-props="{ attributes: { 'aria-label': t('panels.note.content'), role: 'textbox', 'aria-multiline': 'true' },
      handleDOMEvents: { copy: (_view, event) => copy(event), cut: (_view, event) => copy(event, true), compositionend: compositionEnded },
      handleDrop: (_view, event) => drop(event), handlePaste: (_view, event) => paste(event) }"
    :on-transaction="transaction"
    :on-blur="() => emit('flush')" @update:model-value="changed" />
  </div>
  <span v-if="task?.uploading" class="note-upload-status" role="status">{{ t('panels.file.adding') }}</span>
</template>

<style scoped>
.note-editor-shell{position:relative;height:100%;min-height:0}
.note-editor :deep(.note-editor-content){padding:11px 12px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;overscroll-behavior:contain;font-family:var(--content-font-family);font-feature-settings:var(--content-font-features);font-size:inherit;line-height:inherit}
.note-editor :deep(p){margin:0;min-height:1lh}
.note-editor :deep(.is-editor-empty:first-child::before){content:attr(data-placeholder);float:left;height:0;pointer-events:none;color:#75808d}
.note-editor :deep(.ProseMirror-selectednode .note-attachment-button){outline:1px solid var(--accent)}
.note-upload-status{position:absolute;right:12px;bottom:8px;padding:3px 7px;border-radius:4px;background:#20252eef;font-size:11px;color:#aebaca;pointer-events:none}
</style>
