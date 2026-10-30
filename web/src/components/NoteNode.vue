<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import { NodeResizeControl } from '@vue-flow/node-resizer'
import type { NoteData, NotePatch } from '../types'
import Icon from './Icon.vue'
import { noteColor } from '../status'

const { t } = useI18n()

const props = defineProps<Pick<NodeProps<NoteData>, 'id' | 'data' | 'selected'>>()
const colors = ['yellow', 'blue', 'green', 'pink', 'neutral'] as const
const title = ref(props.data.title)
const content = ref(props.data.content)
const editingTitle = ref(false)
const titleInput = ref<HTMLInputElement>()
const colorOpen = ref(false)
const colorPicker = ref<HTMLElement>()
const color = computed(() => colors.includes(props.data.color) ? props.data.color : 'yellow')
// Pending fields are merged above remote snapshots by the parent. Fields edited
// in another browser can therefore update here without replacing a local draft.
watch(() => props.data.title, value => { title.value = value })
watch(() => props.data.content, value => { content.value = value })
function emitChange(patch: NotePatch) { props.data.onChange(props.id, patch) }
function flush() { props.data.onFlush() }
function finishTitle() { editingTitle.value = false; flush() }
async function rename() { editingTitle.value = true; await nextTick(); titleInput.value?.focus(); titleInput.value?.select() }
function toggleMinimize() { emitChange({ minimized: !props.data.minimized }); flush() }
function setColor(value: typeof colors[number]) { emitChange({ color: value }); colorOpen.value = false; flush() }
function outsideColor(event: PointerEvent) { if (!colorPicker.value?.contains(event.target as HTMLElement)) colorOpen.value = false }
onMounted(() => document.addEventListener('pointerdown', outsideColor))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outsideColor))
</script>

<template>
  <template v-if="selected && !data.minimized">
    <NodeResizeControl v-for="position in (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const)" :key="position" :node-id="id" :position="position" :min-width="240" :min-height="160" :max-width="4000" :max-height="3000" @resize-start="data.onLayoutStart" @resize-end="event => data.onResize(id, event.params.width, event.params.height, event.params.x, event.params.y)" />
  </template>
  <article class="note-card" :data-note-id="id" :style="{ '--note-color': noteColor(color) }">
    <header class="note-header drag-handle">
      <div ref="colorPicker" class="note-color-picker nodrag">
        <button class="note-color-dot" :title="t('panels.note.color')" :aria-label="t('panels.note.color')" :aria-expanded="colorOpen" @click.stop="colorOpen = !colorOpen" @keydown.esc.stop="colorOpen = false" />
        <div v-if="colorOpen" class="note-colors" role="group" :aria-label="t('panels.note.color')" @pointerdown.stop @keydown.esc.stop="colorOpen = false">
          <button v-for="item in colors" :key="item" class="note-color-choice" :style="{ background: noteColor(item) }" :aria-label="t(`panels.note.colors.${item}`)" :title="t(`panels.note.colors.${item}`)" :aria-pressed="color === item" @click="setColor(item)" />
        </div>
      </div>
      <input v-if="editingTitle" ref="titleInput" v-model="title" class="note-title nodrag" :aria-label="t('panels.note.title')" maxlength="200" @input="emitChange({ title })" @blur="finishTitle" @keydown.enter.stop.prevent="titleInput?.blur()" @keydown.esc.stop.prevent="titleInput?.blur()" />
      <span v-else class="note-title" :title="title || t('panels.note.name')" @dblclick.stop="rename">{{ title || t('panels.note.name') }}</span>
      <div class="note-actions nodrag">
        <button :title="t('panels.note.rename')" :aria-label="t('panels.note.rename')" @click.stop="rename"><Icon name="edit" :size="13" /></button>
        <button :title="t(data.minimized ? 'panels.note.expand' : 'panels.note.collapse')" :aria-label="t(data.minimized ? 'panels.note.expand' : 'panels.note.collapse')" @click.stop="toggleMinimize"><Icon :name="data.minimized ? 'expand' : 'minus'" :size="14" /></button>
        <button :title="t('panels.note.remove')" :aria-label="t('panels.note.remove')" @click.stop="data.onAction('remove', id)"><Icon name="close" :size="14" /></button>
      </div>
    </header>
    <textarea v-if="!data.minimized" v-model="content" class="note-content nodrag nowheel" :aria-label="t('panels.note.content')" :placeholder="t('panels.note.placeholder')" maxlength="200000" @input="emitChange({ content })" @blur="flush" @pointerdown.stop @wheel.stop @dblclick.stop />
  </article>
</template>
