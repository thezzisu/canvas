<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useFileDialog } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UEditor from '@nuxt/ui/components/Editor.vue'
import { Extension, Node, type Editor, type EditorOptions, type JSONContent } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { apiContext, segment } from '../api'
import { hasFileTransfer, readFileTransfer } from '../browser-file-input'
import { presentDownload, reportDownloadError } from '../downloads'
import { noteDocument, noteOffset, notePosition, serializeNote } from '../note-document'
import { noteUpload, uploadNoteAttachment } from '../note-uploads'
import type { FileAsset } from '../types'
import NoteAttachment from './NoteAttachment.vue'

const props = defineProps<{ content: string; attachments: FileAsset[]; canvasId: string; noteId: string; readOnly: boolean; insertAttachment: (asset: FileAsset, offset: number) => void }>()
const emit = defineEmits<{ change: [content: string]; flush: [] }>()
const { t } = useI18n()
const input = ref<{ editor?: Editor }>()
const value = shallowRef(noteDocument(props.content))
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
function changed(document: JSONContent) {
  value.value = document
  const content = serializeNote(document)
  if (content !== props.content) emit('change', content)
}
watch(() => props.content, content => {
  if (serializeNote(value.value) !== content) value.value = noteDocument(content)
})
function fail(key: string) { window.dispatchEvent(new CustomEvent('canvas:error', { detail: new Error(t(key)) })) }
function editor() { return input.value?.editor }
const transaction: EditorOptions['onTransaction'] = ({ transaction }) => {
  if (!task.value || !transaction.docChanged) return
  const before = notePosition(transaction.before, task.value.offset)
  task.value.offset = noteOffset(transaction.doc, transaction.mapping.map(before))
}
function insert(asset: FileAsset, offset: number) {
  const current = editor()
  if (!current || current.isDestroyed) return false
  uploaded.value = [...uploaded.value, asset]
  current.chain().command(({ tr }) => { closeHistory(tr); return true })
    .insertContentAt(notePosition(current.state.doc, offset), { type: 'noteAttachment', attrs: { id: asset.id } }).run()
  current.view.dispatch(closeHistory(current.state.tr))
  emit('flush')
  return true
}
watch(task, (current, previous) => {
  if (previous?.insert === insert) previous.insert = undefined
  if (current) current.insert = insert
}, { immediate: true, flush: 'sync' })
function upload(files: File[], position?: number) {
  if (props.readOnly) return
  if (pending.value) { fail('panels.file.uploadBusy'); return }
  if (!files.length || files.length !== 1) { fail('panels.file.singleOnly'); return }
  const file = files[0]!, current = editor()
  if (file.webkitRelativePath) { fail('terminal.upload.foldersUnsupported'); return }
  if (!current) return
  void uploadNoteAttachment(props.canvasId, props.noteId, file,
    noteOffset(current.state.doc, position ?? current.state.selection.from), props.insertAttachment)
}
const fileDialog = useFileDialog({ multiple: false, reset: true })
let selection: { context: ReturnType<typeof apiContext>; canvasId: string; noteId: string } | undefined
function chooseFiles() {
  if (props.readOnly) return
  selection = { context: apiContext(), canvasId: props.canvasId, noteId: props.noteId }
  fileDialog.open()
}
fileDialog.onChange(files => {
  const target = selection; selection = undefined
  if (files?.length && target && !target.context.signal.aborted && target.canvasId === props.canvasId && target.noteId === props.noteId)
    void upload([...files])
})
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
  else void upload(incoming.files, editor()?.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos)
  return true
}
watch(() => [props.canvasId, props.noteId], () => { selection = undefined; uploaded.value = [] })
onBeforeUnmount(() => { if (task.value?.insert === insert) task.value.insert = undefined })
defineExpose({ chooseFiles, pending })
</script>

<template>
  <div class="note-editor-shell" @dragenter="dragOver" @dragover="dragOver">
  <UEditor ref="input" :model-value="value" content-type="json" :starter-kit="false" :image="false" :mention="false" :extensions="[extension, sizeLimit]" :editable="!readOnly" :enable-input-rules="false" :enable-paste-rules="false" :placeholder="t('panels.note.placeholder')" class="note-editor"
    :ui="{ root: 'h-full min-h-0', content: 'h-full min-h-0', base: 'note-editor-content h-full min-h-0 outline-none' }"
    :editor-props="{ attributes: { 'aria-label': t('panels.note.content'), role: 'textbox', 'aria-multiline': 'true' }, handleDrop: (_view, event) => drop(event), handlePaste: (_view, event) => {
      if (!hasFileTransfer(event.clipboardData)) return false
      event.preventDefault(); const incoming = readFileTransfer(event.clipboardData)
      if (incoming.error) fail(incoming.error === 'folders' ? 'terminal.upload.foldersUnsupported' : 'panels.file.unreadableTransfer')
      else void upload(incoming.files)
      return true
    } }"
    :on-transaction="transaction"
    :on-blur="() => emit('flush')" @update:model-value="changed" />
  </div>
  <span v-if="pending" class="note-upload-status" role="status">{{ t('panels.file.adding') }}</span>
</template>

<style scoped>
.note-editor-shell{height:100%;min-height:0}
.note-editor :deep(.note-editor-content){padding:11px 12px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;overscroll-behavior:contain;font-family:var(--content-font-family);font-feature-settings:var(--content-font-features);font-size:inherit;line-height:inherit}
.note-editor :deep(p){margin:0;min-height:1lh}
.note-editor :deep(.is-editor-empty:first-child::before){content:attr(data-placeholder);float:left;height:0;pointer-events:none;color:#75808d}
.note-editor :deep(.ProseMirror-selectednode .note-attachment-button){outline:1px solid var(--accent)}
.note-upload-status{position:absolute;right:12px;bottom:8px;padding:3px 7px;border-radius:4px;background:#20252eef;font-size:11px;color:#aebaca;pointer-events:none}
</style>
