<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import { NodeResizeControl } from '@vue-flow/node-resizer'
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue'
import type { NoteData, NotePatch } from '../types'
import Icon from './Icon.vue'
import ContentZoom from './ContentZoom.vue'
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
const headerCompact = useCompactHeader(computed(() => props.data.focus ? header.value : undefined))
const compact = computed(() => props.data.focus && headerCompact.value)
const menu = computed(() => [
  ...(compact.value ? [{ label: t('panels.note.copy'), disabled: !content.value, onSelect: copyNote }] : []),
  { label: t('panels.note.rename'), onSelect: () => { void rename() } },
  { label: t('app.addToOtherCanvas'), onSelect: () => props.data.onAction('add', props.id) },
  { label: t('panels.note.remove'), onSelect: () => props.data.onAction('remove', props.id) },
  { label: t('common.settings'), onSelect: () => props.data.onAction('settings', props.id) },
])
const menuContent = { align: 'end' as const, onCloseAutoFocus: (event: Event) => event.preventDefault() }
const menuOpen = ref(false), menuTrigger = ref<HTMLButtonElement>()
usePointerDismiss(menuOpen, menuTrigger)
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
  <template v-if="!data.mobile && !data.focus">
    <NodeResizeControl v-for="position in (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const)" :key="position" :node-id="id" :position="position" :min-width="240" :min-height="160" :max-width="4000" :max-height="3000" @resize-start="data.onLayoutStart" @resize-end="event => data.onResize(id, event.params.width, event.params.height, event.params.x, event.params.y)" />
  </template>
  <article class="note-card" :class="{ 'mobile-card-preview': mobilePreview, 'card-focused': data.focus, 'input-focused': contentActive }" :data-note-id="id" :style="{ '--note-color': noteColor(color), '--content-zoom': data.focus ? zoom / 100 : 1 }" @dragenter.capture="rejectNoteCardDrop" @dragover.capture="rejectNoteCardDrop" @drop.capture="rejectNoteCardDrop">
    <header ref="header" class="note-header drag-handle" :class="{ 'cutout-header': data.focus && data.mobile }" :data-cutout-position="data.focus && data.mobile && cutoutWidth > 0 ? cutoutPosition : undefined" :style="data.focus && data.mobile ? { '--cutout-width': `calc(${cutoutWidth}px / var(--ui-zoom))` } : undefined" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined">
      <div ref="colorPicker" class="note-color-picker nodrag" :class="{ 'cutout-status': data.focus }">
        <button class="note-color-dot" :title="t('panels.note.color')" :aria-label="t('panels.note.color')" :aria-expanded="colorOpen" @click.stop="colorOpen = !colorOpen" @keydown.esc.stop="colorOpen = false" />
        <div v-if="colorOpen" class="note-colors" role="group" :aria-label="t('panels.note.color')" @pointerdown.stop @keydown.esc.stop="colorOpen = false">
          <button v-for="item in colors" :key="item" class="note-color-choice" :style="{ background: noteColor(item) }" :aria-label="t(`panels.note.colors.${item}`)" :title="t(`panels.note.colors.${item}`)" :aria-pressed="color === item" @click="setColor(item)" />
        </div>
      </div>
      <input v-if="editingTitle" ref="titleInput" v-model="title" class="note-title nodrag" :class="{ 'cutout-title': data.focus }" :aria-label="t('panels.note.title')" maxlength="200" @input="emitChange({ title })" @blur="finishTitle" @keydown.enter.stop.prevent="titleInput?.blur()" @keydown.esc.stop.prevent="titleInput?.blur()" />
      <span v-else class="note-title" :class="{ 'cutout-title': data.focus }" :title="title || t('panels.note.name')" @dblclick.stop="rename">{{ title || t('panels.note.name') }}</span>
      <div class="note-actions nodrag" :class="{ 'cutout-actions': data.focus }">
        <button v-if="!data.focus || !compact" type="button" class="note-copy" :class="{ 'note-copy-failed': copied === 'failed' }" :disabled="!content" :draggable="!!content" :title="copied ? t(`terminal.clipboard.${copied}`) : t('panels.note.copyOrDrag')" :aria-label="t('panels.note.copy')" @pointerdown.stop @click.stop="copyNote" @dragstart="dragNote"><Icon :name="copied === 'copied' ? 'check' : 'copy'" :size="13" /></button>
        <template v-if="data.focus">
          <ContentZoom v-model="zoom" :mobile="data.mobile" :label="t('common.contentZoom')" />
          <UDropdownMenu v-model:open="menuOpen" :modal="false" :items="menu" :portal="false" :content="menuContent" :ui="{ content: 'card-action-menu' }">
            <button ref="menuTrigger" type="button" class="note-more" :aria-label="t('common.more')" :title="t('common.more')"><Icon name="more" :size="17" /></button>
          </UDropdownMenu>
          <button type="button" :title="t('common.returnToCanvas')" :aria-label="t('common.returnToCanvas')" @click.stop="data.onAction('unfocus', id)"><Icon name="collapse" :size="17" /></button>
        </template>
        <template v-else>
          <button :title="t('app.addToOtherCanvas')" :aria-label="t('app.addToOtherCanvas')" @click.stop="data.onAction('add', id)"><Icon name="layers" :size="13" /></button>
          <button :title="t('panels.note.rename')" :aria-label="t('panels.note.rename')" @click.stop="rename"><Icon name="edit" :size="13" /></button>
          <button :title="t('common.maximize')" :aria-label="t('common.maximize')" @click.stop="data.onAction('focus', id)"><Icon name="expand" :size="14" /></button>
          <button :title="t('panels.note.remove')" :aria-label="t('panels.note.remove')" @click.stop="data.onAction('remove', id)"><Icon name="close" :size="14" /></button>
        </template>
      </div>
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
