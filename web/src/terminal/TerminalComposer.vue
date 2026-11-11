<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../components/Icon.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import NoteEditor from '../notes/NoteEditor.vue'
import SaveStatus from '../components/SaveStatus.vue'
import {
  composerHasContent,
  sentFiles,
  composerOwner,
  editComposer,
  flushComposer,
  insertComposerAttachment,
  saveComposer,
  useComposer,
  type ComposerTarget,
} from './composers'
import { readStoredHeight, storeHeight, composerHeightBounds } from './composer-height'
import { useCardContentFocus } from '../canvas/card-content-focus'

const props = defineProps<{
  target: ComposerTarget
  canSend: boolean
  mobile?: boolean
  error?: string
  holdKeyboard?: () => ((returned: boolean) => void) | undefined
  holdInput?: () => (() => void) | undefined
}>()
const emit = defineEmits<{
  close: []
  send: [composer: string, version: number, files: string[]]
  edited: []
  keyboard: [editor?: HTMLElement]
}>()
const { t } = useI18n()
const composer = useComposer(() => props.target)
const owner = computed(() => composerOwner(props.target))
const root = ref<HTMLElement>(),
  editor = ref<InstanceType<typeof NoteEditor>>()
const fraction = ref(readStoredHeight())
// The composer is card content: while focused it owns wheel and keyboard input like a note body.
const { active: contentActive } = useCardContentFocus(root, () => false)
const hasText = computed(() => composerHasContent(composer.value.content))
const sending = ref(false)
// On mobile the terminal keyboard controller moves the system IME into the editor in place;
// a tap on the editor asks for it again after it was refused.
function claimKeyboard() {
  const element = editor.value?.element()
  if (props.mobile && element) emit('keyboard', element)
}
// Keep the editor focused, and so the IME open, when tapping composer buttons.
function keepFocus(event: PointerEvent) {
  if (props.mobile) event.preventDefault()
}

async function send() {
  if (!props.canSend || !hasText.value || sending.value || editor.value?.pending) return
  // Terminal keystrokes wait from here until dispatch, where the delivery holds them until its paste.
  const release = props.holdInput?.()
  // Return the IME before the draft turns read-only so it never closes under the editor.
  if (props.mobile) emit('keyboard')
  // The draft is read-only from flush to dispatch, so no keystroke can follow the sent version.
  sending.value = true
  try {
    const view = await flushComposer(props.target)
    if (view?.id) emit('send', view.id, view.version, sentFiles(view.content, view.attachments))
  } catch (error) {
    window.dispatchEvent(new CustomEvent('canvas:error', { detail: error }))
  } finally {
    sending.value = false
    release?.()
  }
  // A send that did not collapse the composer, or was refused at once, takes the IME back.
  await nextTick()
  claimKeyboard()
}
function keydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    event.stopPropagation()
    void send()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
  }
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
  if (bounds.collapse) {
    emit('close')
    return
  }
  fraction.value = bounds.value
  storeHeight(bounds.value)
}
function resizeKey(event: KeyboardEvent) {
  const step = event.key === 'ArrowUp' ? -0.05 : event.key === 'ArrowDown' ? 0.05 : 0
  if (!step) return
  event.preventDefault()
  const height = root.value?.parentElement?.clientHeight || 400
  fraction.value = composerHeightBounds(fraction.value + step, height).value
  storeHeight(fraction.value)
}
onMounted(() => {
  void nextTick(() => {
    claimKeyboard()
    editor.value?.focus()
  })
})
onBeforeUnmount(() => saveComposer(props.target))
defineExpose({ send })
</script>

<template>
  <section
    ref="root"
    class="terminal-composer card-content nodrag nopan nowheel"
    :data-content-active="contentActive"
    :class="{ full: fraction >= 1, mobile }"
    :style="{ height: `${fraction * 100}%` }"
    role="region"
    :aria-label="t('terminal.composer.title')"
    @pointerdown.stop
    @mousedown.stop
    @keydown.capture="keydown"
  >
    <div class="terminal-composer-editor" @click="!sending && claimKeyboard()">
      <NoteEditor
        ref="editor"
        :content="composer.content"
        :attachments="composer.attachments"
        :owner="owner"
        :scroll-key="owner.key"
        :can-persist="() => false"
        :read-only="sending"
        placeholder=""
        :hold-keyboard="holdKeyboard"
        :insert-attachment="(value) => insertComposerAttachment(target, value)"
        @change="
          (value) => {
            editComposer(target, value)
            emit('edited')
          }
        "
        @flush="saveComposer(target)"
      />
    </div>
    <p v-if="error" class="terminal-composer-error" role="alert">{{ error }}</p>
    <div class="terminal-composer-actions">
      <UButton
        color="neutral"
        variant="ghost"
        :size="mobile ? 'lg' : 'sm'"
        square
        class="me-auto"
        :title="t('terminal.composer.attach')"
        :aria-label="t('terminal.composer.attach')"
        :disabled="editor?.pending"
        @pointerdown="keepFocus"
        @click="editor?.chooseFiles()"
        ><Icon name="paperclip" :size="16"
      /></UButton>
      <SaveStatus :owner="owner.key" :size="mobile ? 'lg' : 'sm'" />
      <UButton
        color="primary"
        variant="ghost"
        :size="mobile ? 'lg' : 'sm'"
        square
        class="terminal-composer-send"
        :title="t('terminal.composer.send')"
        :aria-label="t('terminal.composer.send')"
        :disabled="!canSend || !hasText || editor?.pending"
        :loading="sending"
        @pointerdown="keepFocus"
        @click="send"
        ><Icon name="send" :size="16"
      /></UButton>
    </div>
    <div
      class="terminal-composer-handle"
      role="separator"
      aria-orientation="horizontal"
      tabindex="0"
      :aria-label="t('terminal.composer.resize')"
      :aria-valuenow="Math.round(fraction * 100)"
      :aria-valuetext="`${Math.round(fraction * 100)}%`"
      aria-valuemin="0"
      aria-valuemax="100"
      @pointerdown="resizeStart"
      @pointermove="resizeMove"
      @pointerup="resizeEnd"
      @pointercancel="resizeEnd"
      @keydown="resizeKey"
    >
      <span />
    </div>
  </section>
</template>

<style scoped>
.terminal-composer {
  position: absolute;
  z-index: 7;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #1d2128;
  border-bottom: 1px solid #3a4250;
  box-shadow: 0 6px 18px #0007;
  color: #d7dce5;
  font-size: 13px;
  line-height: 1.5;
}
.terminal-composer.full {
  border-bottom: 0;
  box-shadow: none;
}
.terminal-composer-editor {
  position: relative;
  flex: 1;
  min-height: 0;
}
.terminal-composer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 2px;
}
.terminal-composer-error {
  margin: 0;
  padding: 0 12px 4px;
  color: var(--ui-error);
  font-size: 12px;
}
.terminal-composer-handle:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}
.terminal-composer-handle {
  flex: 0 0 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  touch-action: none;
}
.terminal-composer-handle span {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: #4a5363;
}
.mobile .terminal-composer-actions :deep(button) {
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
}
.mobile .terminal-composer-handle {
  flex-basis: 20px;
}
</style>
