<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import { NodeResizer } from '@vue-flow/node-resizer'
import type { DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import type { NoteData, NotePatch } from '../types'
import Icon from './Icon.vue'
import CardLayoutControls from './CardLayoutControls.vue'
import { useLayoutCard } from '../layout-editing'
import { noteText } from '../note-document'
import ContentZoom from './ContentZoom.vue'
import CardHeaderActions from './CardHeaderActions.vue'
import { contentZoomMenu } from '../content-zoom-menu'
import { useContentZoom } from '../content-zoom'
import CardPreview from './CardPreview.vue'
import { noteColor } from '../status'
import { copyText } from '../clipboard'
import { clipboardText, noteClipboard, NOTE_CLIPBOARD_TYPE } from '../note-clipboard'
import { apiContext } from '../api'
import { reportDownloadError } from '../downloads'
import { rejectNoteCardDrop, writeNoteTransfer } from '../note-transfer'
import { cutoutPosition, cutoutWidth } from '../display-cutout'
import { usePointerDismiss } from '../pointer-dismiss'
import { useCardContentFocus } from '../card-content-focus'
import { canvasNoteOwner } from '../note-uploads'

const NoteEditor = defineAsyncComponent(() => import('./NoteEditor.vue'))
const { t } = useI18n()

const props = withDefaults(defineProps<Pick<NodeProps<NoteData>, 'id' | 'data'> & { selected?: boolean }>(), { selected: false })
const layoutRoot = ref<HTMLElement>()
const { editing } = useLayoutCard(layoutRoot)
const zoom = useContentZoom(() => props.data.zoomKey)
const mobilePreview = computed(() => !!props.data.mobile && !props.data.focus)
const noteBody = ref<HTMLElement>()
const noteEditor = ref<InstanceType<typeof NoteEditor>>()
const copyContent = computed(() => noteText(content.value, props.data.attachments))
const { active: contentActive, pointerDown: contentPointerDown } = useCardContentFocus(noteBody, () => mobilePreview.value)
const shortcuts = computed(() => [...(props.data.focus ? ['zoom'] : []), 'copy'])
const menu = computed<DropdownMenuItem[]>(() => [
  ...(props.data.focus ? contentZoomMenu(zoom) : []),
  { slot: 'copy', label: t('panels.note.copy'), icon: 'i-lucide-copy', disabled: !content.value, onSelect: copyNote },
  { label: t('app.uploadFile'), icon: 'i-lucide-upload', disabled: noteEditor.value?.pending, onSelect: () => noteEditor.value?.chooseFiles() },
  { label: t('panels.note.rename'), icon: 'i-lucide-pencil', onSelect: () => { void rename() } },
  { label: t('common.settings'), icon: 'i-lucide-settings', onSelect: () => props.data.onAction('settings', props.id) },
])
const colors = ['yellow', 'blue', 'green', 'pink', 'neutral'] as const
const title = ref(props.data.title)
const content = ref(props.data.content)
const editingTitle = ref(false)
const titleInput = ref<HTMLInputElement>()
const colorOpen = ref(false)
const colorPicker = ref<HTMLElement>()
usePointerDismiss(colorOpen, colorPicker)
const color = computed(() => colors.includes(props.data.color) ? props.data.color : 'yellow')
// Pending fields are merged above remote snapshots by the parent. Fields edited
// in another browser can therefore update here without replacing a local draft.
watch(() => props.data.title, value => { title.value = value })
watch(() => props.data.content, value => { content.value = value })
function emitChange(patch: NotePatch) { props.data.onChange(props.id, patch) }
function flush() { props.data.onFlush() }
function finishTitle() { editingTitle.value = false; flush() }
async function rename() { editingTitle.value = true; await nextTick(); titleInput.value?.focus(); titleInput.value?.select() }
function escapeTitle(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || props.data.focus) return
  event.preventDefault(); event.stopPropagation(); titleInput.value?.blur()
}
function escapeColors(event: KeyboardEvent) {
  if (!colorOpen.value || event.isComposing || event.keyCode === 229) return
  event.preventDefault(); event.stopPropagation(); colorOpen.value = false
}
function setColor(value: typeof colors[number]) { emitChange({ color: value }); colorOpen.value = false; flush() }
function copyNote() {
  try {
    const note = noteClipboard(content.value, props.data.attachments || [], apiContext())
    const formats = note.parts.some(part => typeof part !== 'string') ? { [NOTE_CLIPBOARD_TYPE]: JSON.stringify(note) } : undefined
    void copyText(clipboardText(note), formats)
  } catch (error) { reportDownloadError(error) }
}
function dragNote(event: DragEvent) {
  if (!writeNoteTransfer(event.dataTransfer, copyContent.value)) event.preventDefault()
  event.stopPropagation()
}
</script>

<template>
  <NodeResizer v-if="!data.mobile && !data.focus" :node-id="id" :min-width="240" :min-height="160" :max-width="4000" :max-height="3000" @resize-start="event => data.onResizeStart(id, event.params)" @resize-end="event => data.onResize(id, event.params.width, event.params.height, event.params.x, event.params.y)" />
  <article ref="layoutRoot" class="note-card" :class="{ 'mobile-card-preview': mobilePreview, 'card-focused': data.focus, 'input-focused': contentActive }" :data-note-id="id" :style="{ '--note-color': noteColor(color), '--content-zoom': data.focus ? zoom / 100 : 1 }" @dragenter.capture="rejectNoteCardDrop" @dragover.capture="rejectNoteCardDrop" @drop.capture="rejectNoteCardDrop">
    <header class="note-header drag-handle" :class="{ 'cutout-header': data.focus && data.mobile }" :data-cutout-position="data.focus && data.mobile && cutoutWidth > 0 ? cutoutPosition : undefined" :style="data.focus && data.mobile ? { '--cutout-width': `calc(${cutoutWidth}px / var(--ui-zoom))` } : undefined" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined">
      <div ref="colorPicker" class="note-color-picker nodrag" :class="{ 'cutout-status': data.focus }">
        <button class="note-color-dot" :title="t('panels.note.color')" :aria-label="t('panels.note.color')" :aria-expanded="colorOpen" @click.stop="colorOpen = !colorOpen" @keydown.esc="escapeColors" />
        <div v-if="colorOpen" class="note-colors" role="group" :aria-label="t('panels.note.color')" @pointerdown.stop @keydown.esc="escapeColors">
          <button v-for="item in colors" :key="item" class="note-color-choice" :style="{ background: noteColor(item) }" :aria-label="t(`panels.note.colors.${item}`)" :title="t(`panels.note.colors.${item}`)" :aria-pressed="color === item" @click="setColor(item)" />
        </div>
      </div>
      <input v-if="editingTitle" ref="titleInput" v-model="title" class="note-title nodrag" :class="{ 'cutout-title': data.focus }" :aria-label="t('panels.note.title')" maxlength="200" @input="emitChange({ title })" @blur="finishTitle" @keydown.enter.stop.prevent="titleInput?.blur()" @keydown.esc="escapeTitle" />
      <span v-else class="note-title" :class="{ 'cutout-title': data.focus }" :title="title || t('panels.note.name')" @dblclick.stop="rename">{{ title || t('panels.note.name') }}</span>
      <CardHeaderActions class="note-actions" :class="{ 'cutout-actions': data.mobile && data.focus }" :items="menu" :expanded="!!data.focus" removable :mobile="!!data.mobile && !!data.focus" :shortcuts="shortcuts" :priority="['copy', 'zoom']" :add-label="t('app.addToOtherCanvas')" :remove-label="t('panels.note.remove')"
        @add="data.onAction('add', id)" @toggle="data.onAction(data.focus ? 'unfocus' : 'focus', id)" @remove="data.onAction('remove', id)">
        <template #zoom><ContentZoom v-model="zoom" :mobile="data.mobile" :label="t('common.contentZoom')" /></template>
        <template #copy><button type="button" class="card-header-action note-copy" :disabled="!content" :draggable="!!content" :title="t('panels.note.copyOrDrag')" :aria-label="t('panels.note.copy')" @pointerdown.stop @click="copyNote" @dragstart="dragNote"><Icon name="copy" :size="15" /></button></template>
      </CardHeaderActions>
    </header>
    <div ref="noteBody" class="note-content card-content nodrag nowheel" :data-content-active="contentActive" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined" @pointerdown.stop="contentPointerDown" @wheel.stop @dblclick.stop>
      <NoteEditor ref="noteEditor" :content="content" :attachments="data.attachments || []" :owner="canvasNoteOwner(data.canvasId, id)" :scroll-key="data.scrollKey" :can-persist="data.canPersistView" :read-only="mobilePreview" :insert-attachment="data.onAttachment" @change="value => { content = value; emitChange({ content: value }) }" @flush="flush" />
    </div>
    <CardPreview v-if="mobilePreview && !editing" :label="t('common.openCard', { name: title || t('panels.note.name') })" @open="data.onAction('focus', id)" />
  </article>
  <CardLayoutControls :id="id" :label="title || t('panels.note.name')" :kind="'note'" :width="data.width" :height="data.height" />
</template>

<style scoped>
.note-content{position:relative;padding:0;overflow:hidden;-webkit-tap-highlight-color:transparent}.note-copy[draggable=true]{cursor:grab}.note-copy[draggable=true]:active{cursor:grabbing}
.note-content:has(.note-file-dropcursor){box-shadow:inset 0 0 0 2px var(--accent)}
.note-copy:disabled{cursor:default}
</style>
