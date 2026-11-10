<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import NoteEditor from './NoteEditor.vue'
import { composerHasContent, composerOwner, editComposer, flushComposer, insertComposerAttachment, useComposer, type ComposerTarget } from '../composers'
import { readStoredHeight, storeHeight, composerHeightBounds } from '../composer-height'

const props = defineProps<{ target: ComposerTarget; canSend: boolean; mobile?: boolean }>()
const emit = defineEmits<{ close: []; send: [composer: string, version: number] }>()
const { t } = useI18n()
const composer = useComposer(() => props.target)
const owner = computed(() => composerOwner(props.target))
const root = ref<HTMLElement>(), editor = ref<InstanceType<typeof NoteEditor>>()
const fraction = ref(readStoredHeight())
const hasText = computed(() => composerHasContent(composer.value.content))
const sending = ref(false)

async function send() {
  if (!props.canSend || !hasText.value || sending.value || editor.value?.pending) return
  // The draft is read-only from flush to dispatch, so no keystroke can follow the sent version.
  sending.value = true
  try {
    const view = await flushComposer(props.target)
    if (view?.id) emit('send', view.id, view.version)
  } catch (error) { window.dispatchEvent(new CustomEvent('canvas:error', { detail: error })) }
  finally { sending.value = false }
}
function keydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); void send() }
  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close') }
}

// Dragging the bottom edge resizes over the terminal; near the bottom it covers it fully.
let drag: { pointer: number; top: number; height: number } | undefined
function resizeStart(event: PointerEvent) {
  const body = root.value?.parentElement
  if (!body || event.button !== 0) return
  const box = body.getBoundingClientRect()
  drag = { pointer: event.pointerId, top: box.top, height: box.height }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  event.preventDefault()
}
function resizeMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointer) return
  fraction.value = composerHeightBounds((event.clientY - drag.top) / drag.height, drag.height).value
}
function resizeEnd(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointer) return
  const bounds = composerHeightBounds((event.clientY - drag.top) / drag.height, drag.height)
  drag = undefined
  if (bounds.collapse) { emit('close'); return }
  fraction.value = bounds.value; storeHeight(bounds.value)
}
function resizeKey(event: KeyboardEvent) {
  const step = event.key === 'ArrowUp' ? -0.05 : event.key === 'ArrowDown' ? 0.05 : 0
  if (!step) return
  event.preventDefault()
  const height = root.value?.parentElement?.clientHeight || 400
  fraction.value = composerHeightBounds(fraction.value + step, height).value; storeHeight(fraction.value)
}
onMounted(() => { void nextTick(() => editor.value?.focus()) })
onBeforeUnmount(() => { void flushComposer(props.target).catch(error => window.dispatchEvent(new CustomEvent('canvas:error', { detail: error }))) })
defineExpose({ send })
</script>

<template>
  <section ref="root" class="terminal-composer nodrag nopan nowheel" :class="{ full: fraction >= 1, mobile }" :style="{ height: `${fraction * 100}%` }" role="region" :aria-label="t('terminal.composer.title')"
    @pointerdown.stop @mousedown.stop @wheel.stop @keydown.capture="keydown">
    <div class="terminal-composer-editor">
      <NoteEditor ref="editor" :content="composer.content" :attachments="composer.attachments" :owner="owner" :scroll-key="owner.key" :can-persist="() => false" :read-only="sending" placeholder=""
        :insert-attachment="value => insertComposerAttachment(target, value)" @change="value => editComposer(target, value)" @flush="flushComposer(target)" />
    </div>
    <div class="terminal-composer-actions">
      <button type="button" class="terminal-composer-action" :title="t('terminal.composer.attach')" :aria-label="t('terminal.composer.attach')" :disabled="editor?.pending" @click="editor?.chooseFiles()"><Icon name="paperclip" :size="16" /></button>
      <button type="button" class="terminal-composer-action terminal-composer-send" :title="t('terminal.composer.send')" :aria-label="t('terminal.composer.send')" :disabled="!canSend || !hasText || sending || editor?.pending" @click="send"><Icon name="send" :size="16" /></button>
    </div>
    <div class="terminal-composer-handle" role="separator" aria-orientation="horizontal" tabindex="0" :aria-label="t('terminal.composer.resize')" :aria-valuenow="Math.round(fraction * 100)" :aria-valuetext="`${Math.round(fraction * 100)}%`" aria-valuemin="0" aria-valuemax="100"
      @pointerdown="resizeStart" @pointermove="resizeMove" @pointerup="resizeEnd" @pointercancel="resizeEnd" @keydown="resizeKey"><span /></div>
  </section>
</template>

<style scoped>
.terminal-composer{position:absolute;z-index:7;top:0;left:0;right:0;display:flex;flex-direction:column;min-height:0;background:#1d2128;border-bottom:1px solid #3a4250;box-shadow:0 6px 18px #0007;color:#d7dce5;font-size:13px;line-height:1.5}
.terminal-composer.full{border-bottom:0;box-shadow:none}
.terminal-composer-editor{flex:1;min-height:0}
.terminal-composer-actions{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 6px 2px}
.terminal-composer-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:5px;background:transparent;color:#9aa6b6;cursor:pointer}
.terminal-composer-action:hover:not(:disabled){background:#ffffff0d;color:#e0e5ec}
.terminal-composer-action:disabled{opacity:.4;cursor:default}
.terminal-composer-action:focus-visible,.terminal-composer-handle:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.terminal-composer-send:not(:disabled){color:var(--accent)}
.terminal-composer-handle{flex:0 0 12px;display:flex;align-items:center;justify-content:center;cursor:ns-resize;touch-action:none}
.terminal-composer-handle span{width:36px;height:4px;border-radius:2px;background:#4a5363}
.mobile .terminal-composer-action{width:44px;height:44px}
.mobile .terminal-composer-handle{flex-basis:20px}
</style>
