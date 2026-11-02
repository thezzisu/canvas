<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import { NodeResizer } from '@vue-flow/node-resizer'
import type { DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import type { NoteData, NotePatch } from '../types'
import Icon from './Icon.vue'
import ContentZoom from './ContentZoom.vue'
import CardHeaderActions from './CardHeaderActions.vue'
import { contentZoomMenu } from '../content-zoom-menu'
import { useContentZoom } from '../content-zoom'
import CardPreview from './CardPreview.vue'
import { noteColor } from '../status'
import { copyText } from '../clipboard'
import { rejectNoteCardDrop, writeNoteTransfer } from '../note-transfer'
import { cutoutPosition, cutoutWidth, useCompactHeader } from '../display-cutout'
import { usePointerDismiss } from '../pointer-dismiss'
import { useCardContentFocus } from '../card-content-focus'

const { t } = useI18n()

const props = withDefaults(defineProps<Pick<NodeProps<NoteData>, 'id' | 'data'> & { selected?: boolean }>(), { selected: false })
const zoom = useContentZoom(() => props.data.zoomKey)
const mobilePreview = computed(() => !!props.data.mobile && !props.data.focus)
const noteBody = ref<HTMLElement>()
const { active: contentActive, pointerDown: contentPointerDown } = useCardContentFocus(noteBody, () => mobilePreview.value)
const header = ref<HTMLElement>()
const headerCompact = useCompactHeader(computed(() => props.data.mobile && props.data.focus ? header.value : undefined), undefined, 6)
const compact = computed(() => !!props.data.mobile && props.data.focus && headerCompact.value)
const menu = computed<DropdownMenuItem[]>(() => [
  ...(compact.value ? [...contentZoomMenu(zoom),
    { label: t('panels.note.copy'), icon: 'i-lucide-copy', disabled: !content.value, onSelect: copyNote },
    { label: t('app.addToOtherCanvas'), icon: 'i-lucide-layers', onSelect: () => props.data.onAction('add', props.id) },
  ] : []),
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
const copied = ref<'' | 'copied' | 'failed'>('')
let copyTimer: ReturnType<typeof setTimeout> | undefined
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
function copyResult(value: 'copied' | 'failed') {
  clearTimeout(copyTimer); copied.value = value
  copyTimer = setTimeout(() => { copied.value = '' }, 2200)
}
function copyNote() {
  if (copyText(content.value, () => copyResult('failed'))) copyResult('copied')
}
function dragNote(event: DragEvent) {
  if (!writeNoteTransfer(event.dataTransfer, content.value)) event.preventDefault()
  event.stopPropagation()
}
onBeforeUnmount(() => clearTimeout(copyTimer))
</script>

<template>
  <NodeResizer v-if="!data.mobile && !data.focus" :node-id="id" :min-width="240" :min-height="160" :max-width="4000" :max-height="3000" @resize-start="data.onLayoutStart" @resize-end="event => data.onResize(id, event.params.width, event.params.height, event.params.x, event.params.y)" />
  <article class="note-card" :class="{ 'mobile-card-preview': mobilePreview, 'card-focused': data.focus, 'input-focused': contentActive }" :data-note-id="id" :style="{ '--note-color': noteColor(color), '--content-zoom': data.focus ? zoom / 100 : 1 }" @dragenter.capture="rejectNoteCardDrop" @dragover.capture="rejectNoteCardDrop" @drop.capture="rejectNoteCardDrop">
    <header ref="header" class="note-header drag-handle" :class="{ 'cutout-header': data.focus && data.mobile }" :data-cutout-position="data.focus && data.mobile && cutoutWidth > 0 ? cutoutPosition : undefined" :style="data.focus && data.mobile ? { '--cutout-width': `calc(${cutoutWidth}px / var(--ui-zoom))`, '--cutout-controls': '264px' } : undefined" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined">
      <div ref="colorPicker" class="note-color-picker nodrag" :class="{ 'cutout-status': data.focus }">
        <button class="note-color-dot" :title="t('panels.note.color')" :aria-label="t('panels.note.color')" :aria-expanded="colorOpen" @click.stop="colorOpen = !colorOpen" @keydown.esc="escapeColors" />
        <div v-if="colorOpen" class="note-colors" role="group" :aria-label="t('panels.note.color')" @pointerdown.stop @keydown.esc="escapeColors">
          <button v-for="item in colors" :key="item" class="note-color-choice" :style="{ background: noteColor(item) }" :aria-label="t(`panels.note.colors.${item}`)" :title="t(`panels.note.colors.${item}`)" :aria-pressed="color === item" @click="setColor(item)" />
        </div>
      </div>
      <input v-if="editingTitle" ref="titleInput" v-model="title" class="note-title nodrag" :class="{ 'cutout-title': data.focus }" :aria-label="t('panels.note.title')" maxlength="200" @input="emitChange({ title })" @blur="finishTitle" @keydown.enter.stop.prevent="titleInput?.blur()" @keydown.esc="escapeTitle" />
      <span v-else class="note-title" :class="{ 'cutout-title': data.focus }" :title="title || t('panels.note.name')" @dblclick.stop="rename">{{ title || t('panels.note.name') }}</span>
      <CardHeaderActions class="note-actions" :class="{ 'cutout-actions': data.mobile && data.focus }" :items="menu" :expanded="!!data.focus" removable :compact="compact" :add-label="t('app.addToOtherCanvas')" :remove-label="t('panels.note.remove')"
        @add="data.onAction('add', id)" @toggle="data.onAction(data.focus ? 'unfocus' : 'focus', id)" @remove="data.onAction('remove', id)">
        <ContentZoom v-if="data.focus" v-model="zoom" :mobile="data.mobile" :label="t('common.contentZoom')" />
        <button type="button" class="card-header-action note-copy" :class="{ 'note-copy-failed': copied === 'failed' }" :disabled="!content" :draggable="!!content" :title="copied ? t(`terminal.clipboard.${copied}`) : t('panels.note.copyOrDrag')" :aria-label="t('panels.note.copy')" @pointerdown.stop @click="copyNote" @dragstart="dragNote"><Icon :name="copied === 'copied' ? 'check' : 'copy'" :size="15" /></button>
      </CardHeaderActions>
      <span class="sr-only" role="status">{{ copied ? t(`terminal.clipboard.${copied}`) : '' }}</span>
    </header>
    <textarea ref="noteBody" v-model="content" class="note-content card-content nodrag nowheel" :data-content-active="contentActive" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined" :readonly="mobilePreview" :tabindex="mobilePreview ? -1 : undefined" :aria-label="t('panels.note.content')" :placeholder="t('panels.note.placeholder')" maxlength="200000" @input="emitChange({ content })" @blur="flush" @pointerdown.stop="contentPointerDown" @wheel.stop @dblclick.stop />
    <CardPreview v-if="mobilePreview" :label="t('common.openCard', { name: title || t('panels.note.name') })" @open="data.onAction('focus', id)" />
  </article>
</template>

<style scoped>
.note-copy[draggable=true]{cursor:grab}.note-copy[draggable=true]:active{cursor:grabbing}
.note-copy:disabled{cursor:default}.note-actions .note-copy-failed{color:#dfaaa5}
</style>
