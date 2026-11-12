<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRafFn, useResizeObserver } from '@vueuse/core'
import type { TerminalModifiers } from './terminal-input'
import type { TerminalTouchMode } from './terminal-touch'
import type { TouchpadControl } from '../lib/touchpad-gesture'
import CanvasGlyph from '../components/CanvasGlyph.vue'
import UModal from '../components/CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import { useReducedMotion } from '../lib/reduced-motion'

const { t } = useI18n()
const reducedMotion = useReducedMotion()

type TouchMode = TerminalTouchMode
interface Keycap {
  key: string
  label: string
  symbol?: string
  span?: number
}
const props = defineProps<{
  sessionKey: string
  disabled?: boolean
  keyboardMode: 'system' | 'builtin'
  keyboardOpen: boolean
  /** The composer owns input: helper keys and the keyboard switch stay in place, disabled. */
  composing?: boolean
  /** The bottom keyboard area shared with the system IME; `deck` shows the built-in keys in it. */
  dockHeight: number
  deck?: boolean
  modifiers: TerminalModifiers
  touchMode: TouchMode
  readText(signal: AbortSignal): Promise<string>
  copyText(text?: string): Promise<boolean>
  prepareFiles(): { complete(files: File[]): void; dispose(): void } | undefined
}>()
const emit = defineEmits<{
  key: [key: string, modifiers?: Partial<TerminalModifiers>]
  modifiers: [value: TerminalModifiers]
  mode: [value: TouchMode]
  composer: []
  reading: [active: boolean]
  pointer: [action: TouchpadControl]
  switchKeyboard: []
  naturalHeight: [height: number]
}>()
const deckElement = ref<HTMLElement>(),
  actions = ref<HTMLElement>(),
  safeArea = ref<HTMLElement>()
const switchLabel = computed(() =>
  t(
    props.keyboardMode === 'system'
      ? 'terminal.keyboard.switchToBuiltin'
      : 'terminal.keyboard.switchToSystem',
  ),
)
const hasDock = computed(() => props.dockHeight > 0)
// Disabled buttons still receive pointer events; presses check this as well.
const inactive = computed(() => props.disabled || props.composing)
const caps = ref(false)
const sheet = ref<'select'>()
const snapshot = ref('')
const loadingText = ref(false),
  textFailed = ref(false)
let textRequest: AbortController | undefined
let pendingFiles: ReturnType<typeof props.prepareFiles>
const selected = ref(false)
const textArea = ref<HTMLTextAreaElement>()
const fileInput = ref<HTMLInputElement>()
let held:
  | {
      pointer: number
      target: HTMLElement
      key: string
      modifiers: TerminalModifiers
      x: number
      y: number
      deferred: boolean
      sent: boolean
    }
  | undefined
let repeatDelay: ReturnType<typeof setTimeout> | undefined
let repeatTimer: ReturnType<typeof setInterval> | undefined
let previousMode: TouchMode = 'scroll'
const arrows = computed<Keycap[]>(() => [
  { key: 'ArrowLeft', label: t('terminal.keyboard.arrowLeft'), symbol: '←' },
  { key: 'ArrowDown', label: t('terminal.keyboard.arrowDown'), symbol: '↓' },
  { key: 'ArrowUp', label: t('terminal.keyboard.arrowUp'), symbol: '↑' },
  { key: 'ArrowRight', label: t('terminal.keyboard.arrowRight'), symbol: '→' },
])
const keys = computed<Keycap[]>(() => [
  { key: 'Escape', label: 'Esc' },
  { key: 'Tab', label: 'Tab' },
  { key: 'Control', label: 'Ctrl' },
  ...arrows.value,
])
const modifierKeys: Record<string, keyof TerminalModifiers> = {
  Shift: 'shift',
  ShiftRight: 'shift',
  Control: 'ctrl',
  ControlRight: 'ctrl',
  Alt: 'alt',
  AltRight: 'alt',
  Meta: 'meta',
}
const shiftedSymbols: Record<string, string> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
}
const characters = (text: string): Keycap[] =>
  [...text].map((key) => ({ key, label: /[a-z]/.test(key) ? key.toUpperCase() : key }))
const deckRows = computed(() => [
  {
    name: t('terminal.keyboard.functions'),
    class: 'mobile-key-functions',
    keys: Array.from({ length: 12 }, (_, index) => ({
      key: `F${index + 1}`,
      label: `F${index + 1}`,
    })) as Keycap[],
  },
  {
    name: t('terminal.keyboard.numbers'),
    class: 'mobile-key-standard',
    keys: [...characters('`1234567890-='), { key: 'Backspace', label: 'Backspace', symbol: '⌫' }],
  },
  {
    name: 'QWERTY',
    class: 'mobile-key-standard',
    keys: [{ key: 'Tab', label: 'Tab', symbol: '⇥' }, ...characters('qwertyuiop[]\\')],
  },
  {
    name: 'ASDF',
    class: 'mobile-key-standard',
    keys: [
      { key: 'CapsLock', label: 'Caps Lock', symbol: 'Caps' },
      ...characters("asdfghjkl;'"),
      { key: 'Enter', label: 'Enter', symbol: '↵', span: 2 },
    ],
  },
  {
    name: 'ZXCV',
    class: 'mobile-key-standard',
    keys: [
      { key: 'Shift', label: 'Shift', symbol: '⇧', span: 2 },
      ...characters('zxcvbnm,./'),
      { key: 'ShiftRight', label: t('terminal.keyboard.rightShift'), symbol: '⇧', span: 2 },
    ],
  },
  {
    name: t('terminal.keyboard.modifiers'),
    class: 'mobile-key-standard mobile-key-bottom',
    keys: [
      { key: 'Control', label: 'Ctrl' },
      { key: 'Meta', label: 'Meta', symbol: '⊞' },
      { key: 'Alt', label: 'Alt' },
      { key: ' ', label: 'Space', symbol: '', span: 3 },
      { key: 'AltRight', label: t('terminal.keyboard.rightAlt'), symbol: 'Alt' },
      { key: 'ControlRight', label: t('terminal.keyboard.rightCtrl'), symbol: 'Ctrl' },
      { key: 'PageUp', label: 'Page Up', symbol: 'Pg↑' },
      { key: 'PageDown', label: 'Page Down', symbol: 'Pg↓' },
      { key: 'Home', label: 'Home', symbol: '↤' },
      { key: 'End', label: 'End', symbol: '↦' },
      { key: 'Insert', label: 'Insert', symbol: 'Ins' },
      { key: 'Delete', label: 'Delete', symbol: 'Del' },
    ],
  },
])
const modifierPresses = ref(
  new Map<
    number,
    {
      key: keyof TerminalModifiers
      previous: boolean
      value: boolean
      used: boolean
      target: HTMLElement
    }
  >(),
)
const pointerPress = ref<{
  id: number
  target: HTMLElement
  button: 'left' | 'middle'
  x: number
  y: number
  startX: number
  startY: number
  moved: boolean
}>()
const pointerScroll = useRafFn(
  ({ delta }) => {
    const press = pointerPress.value
    if (!press || press.button !== 'middle' || props.disabled) {
      pointerScroll.pause()
      return
    }
    const x = press.x - press.startX,
      y = press.y - press.startY,
      distance = Math.hypot(x, y)
    if (distance <= 6) {
      pointerScroll.pause()
      return
    }
    // Deflection controls velocity, not distance travelled. Avoid catch-up after a stalled frame.
    const scale = (((Math.min(distance - 6, 74) * 4) / distance) * Math.min(delta, 100)) / 1000
    if (scale) emit('pointer', { type: 'scroll', x: x * scale, y: y * scale })
  },
  { immediate: false },
)
function releasePointer(cancelled = false) {
  pointerScroll.pause()
  const press = pointerPress.value
  if (!press) return
  pointerPress.value = undefined
  if (press.button === 'left') emit('pointer', { type: 'left', pressed: false, cancelled })
  else if (!cancelled && !press.moved) emit('pointer', { type: 'click', button: 'middle' })
  if (press.target.hasPointerCapture(press.id)) press.target.releasePointerCapture(press.id)
}
function pointerDown(event: PointerEvent, button: 'left' | 'middle') {
  if (event.button !== 0) return
  event.preventDefault()
  if (props.disabled || pointerPress.value) return
  const target = event.currentTarget as HTMLElement
  pointerPress.value = {
    id: event.pointerId,
    target,
    button,
    x: event.clientX,
    y: event.clientY,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  }
  target.setPointerCapture(event.pointerId)
  if (button === 'left') emit('pointer', { type: 'left', pressed: true })
}
function pointerMove(event: PointerEvent) {
  const press = pointerPress.value
  if (!press || press.id !== event.pointerId || press.button !== 'middle') return
  press.x = event.clientX
  press.y = event.clientY
  if (Math.hypot(press.x - press.startX, press.y - press.startY) <= 6) {
    pointerScroll.pause()
    return
  }
  press.moved = true
  pointerScroll.resume()
}
function pointerUp(event: PointerEvent, cancelled = false) {
  if (pointerPress.value?.id === event.pointerId) releasePointer(cancelled)
}
const activeModifiers = computed(() => {
  const value = { ...props.modifiers }
  for (const press of modifierPresses.value.values()) value[press.key] = press.value
  return value
})
function releaseModifier(id: number, cancelled = false) {
  const press = modifierPresses.value.get(id)
  if (!press) return false
  modifierPresses.value.delete(id)
  if (press.target.hasPointerCapture(id)) press.target.releasePointerCapture(id)
  if (cancelled && !press.used)
    emit('modifiers', { ...props.modifiers, [press.key]: press.previous })
  return true
}
function cancelPress(event?: Event) {
  if (!(event instanceof PointerEvent) || event.pointerId === pointerPress.value?.id)
    releasePointer(true)
  if (event instanceof PointerEvent) {
    releaseModifier(event.pointerId, true)
    if (held?.pointer === event.pointerId) stopRepeat()
  } else {
    for (const id of [...modifierPresses.value.keys()]) releaseModifier(id, true)
    stopRepeat()
  }
}

function keyLabel(key: Keycap) {
  if (key.symbol !== undefined) return key.symbol
  if (/^[a-z]$/.test(key.key))
    return caps.value !== !!activeModifiers.value.shift ? key.key.toUpperCase() : key.key
  return activeModifiers.value.shift ? shiftedSymbols[key.key] || key.label : key.label
}
function keyPressed(key: string) {
  if (key === 'CapsLock') return caps.value
  const modifier = modifierKeys[key]
  return modifier ? activeModifiers.value[modifier] : undefined
}
function stopRepeat() {
  clearTimeout(repeatDelay)
  clearInterval(repeatTimer)
  const press = held
  held = undefined
  if (press?.target.hasPointerCapture(press.pointer))
    press.target.releasePointerCapture(press.pointer)
}
function send(key: string, modifiers?: Partial<TerminalModifiers>) {
  if (inactive.value) return
  if (key === 'CapsLock') {
    caps.value = !caps.value
    return
  }
  const modifier = modifierKeys[key]
  if (modifier) {
    emit('modifiers', { ...props.modifiers, [modifier]: !props.modifiers[modifier] })
    return
  }
  for (const press of modifierPresses.value.values()) press.used = true
  emit('key', key, modifiers)
}
function press(event: PointerEvent, key: string) {
  if (event.button !== 0 || inactive.value) return
  event.preventDefault()
  event.stopPropagation()
  stopRepeat()
  const target = event.currentTarget as HTMLElement
  const modifier = modifierKeys[key]
  if (modifier) {
    const previous = activeModifiers.value[modifier]
    modifierPresses.value.set(event.pointerId, {
      key: modifier,
      previous,
      value: !previous,
      used: false,
      target,
    })
    target.setPointerCapture(event.pointerId)
    emit('modifiers', { ...props.modifiers, [modifier]: !previous })
    return
  }
  if (!event.isPrimary && !modifierPresses.value.size) return
  const chord = { ...activeModifiers.value }
  // A touch may become a scroll. Commit only on release or a stationary hold.
  const deferred = event.pointerType === 'touch'
  const value = caps.value && /^[a-z]$/.test(key) ? key.toUpperCase() : key
  held = {
    pointer: event.pointerId,
    target,
    key: value,
    modifiers: chord,
    x: event.clientX,
    y: event.clientY,
    deferred,
    sent: !deferred,
  }
  target.setPointerCapture(event.pointerId)
  if (!deferred) send(value, chord)
  if (!(
    key.length === 1 ||
    key.startsWith('Arrow') ||
    ['Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)
  ))
    return
  repeatDelay = setTimeout(() => {
    if (!held) return
    if (!held.sent) {
      held.sent = true
      send(held.key, held.modifiers)
    }
    repeatTimer = setInterval(() => {
      if (held) send(held.key, held.modifiers)
    }, 80)
  }, 400)
}
function movePress(event: PointerEvent) {
  const modifier = modifierPresses.value.get(event.pointerId)
  if (modifier) {
    const box = modifier.target.getBoundingClientRect()
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      releaseModifier(event.pointerId, true)
    return
  }
  if (!held || event.pointerId !== held.pointer) return
  const bounds = held.target.getBoundingClientRect()
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom ||
    (held.deferred && Math.hypot(event.clientX - held.x, event.clientY - held.y) > 6)
  )
    stopRepeat()
}
function releasePress(event: PointerEvent) {
  if (releaseModifier(event.pointerId)) return
  const press = held
  if (!press || press.pointer !== event.pointerId) return
  if (
    press.deferred &&
    !press.sent &&
    Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 6
  )
    send(press.key, press.modifiers)
  stopRepeat()
}
function keyboardClick(event: MouseEvent, key: string) {
  if (event.detail === 0)
    send(caps.value && /^[a-z]$/.test(key) ? key.toUpperCase() : key, { ...activeModifiers.value })
}
function switchKeyboard() {
  cancelPress()
  emit('switchKeyboard')
}
function chooseMode(mode: TouchMode) {
  releasePointer(true)
  emit('mode', mode)
}
function closeSheet() {
  if (!sheet.value) return
  textRequest?.abort()
  textRequest = undefined
  sheet.value = undefined
  selected.value = false
  emit('mode', previousMode === 'select' ? 'scroll' : previousMode)
  emit('reading', false)
}
async function loadText() {
  textRequest?.abort()
  const request = (textRequest = new AbortController())
  snapshot.value = ''
  selected.value = false
  loadingText.value = true
  textFailed.value = false
  try {
    const text = await props.readText(request.signal)
    if (request.signal.aborted) return
    snapshot.value = text
  } catch {
    if (!request.signal.aborted) textFailed.value = true
  } finally {
    if (textRequest === request) {
      loadingText.value = false
      await nextTick()
      if (!request.signal.aborted) textArea.value?.focus({ preventScroll: true })
    }
  }
}
function openSelection() {
  stopRepeat()
  previousMode = props.touchMode
  emit('reading', true)
  emit('mode', 'select')
  textRequest?.abort()
  textRequest = undefined
  snapshot.value = ''
  loadingText.value = false
  textFailed.value = false
  selected.value = false
  sheet.value = 'select'
  void loadText()
}
function updateSelection() {
  const area = textArea.value
  selected.value = !!area && area.selectionStart !== area.selectionEnd
}
async function copy(all: boolean) {
  const area = textArea.value
  const text = all
    ? snapshot.value
    : area?.value.slice(area.selectionStart, area.selectionEnd) || ''
  if (!text) return
  await props.copyText(text)
}
function pickFiles() {
  pendingFiles?.dispose()
  pendingFiles = props.prepareFiles()
  if (!pendingFiles) return
  fileInput.value?.click()
}
function filesChanged(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files || [])]
  input.value = ''
  const accept = pendingFiles
  pendingFiles = undefined
  accept?.complete(files)
}
function filesCancelled() {
  const accept = pendingFiles
  pendingFiles = undefined
  accept?.complete([])
}
function escape() {
  if (sheet.value) closeSheet()
  else send('Escape')
  stopRepeat()
}
function reset(clearFileSelection = true) {
  cancelPress()
  caps.value = false
  if (clearFileSelection) {
    pendingFiles?.dispose()
    pendingFiles = undefined
  }
  emit('reading', false)
  closeSheet()
  emit('modifiers', { shift: false, ctrl: false, alt: false, meta: false })
}
// The dock's own height: the tools and every key row at the size the deck width gives it. It
// never follows a system keyboard.
function measureHeight() {
  const deck = deckElement.value
  if (!deck || !actions.value) return
  const style = getComputedStyle(deck),
    rows = [...deck.children]
  const keys =
    rows.reduce((sum, row) => sum + parseFloat(getComputedStyle(row).height), 0) +
    parseFloat(style.rowGap) * Math.max(0, rows.length - 1)
  emit(
    'naturalHeight',
    Math.ceil(
      keys +
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom) +
        actions.value.offsetHeight +
        (safeArea.value?.offsetHeight || 0) +
        1,
    ),
  )
}
// Keep leaving flex items at their painted position while the remaining items move.
function pinLeavingTool(element: Element) {
  const button = element as HTMLElement
  Object.assign(button.style, {
    left: `${button.offsetLeft}px`,
    top: `${button.offsetTop}px`,
    width: `${button.offsetWidth}px`,
  })
}
function unpinTool(element: Element) {
  const button = element as HTMLElement
  button.style.removeProperty('left')
  button.style.removeProperty('top')
  button.style.removeProperty('width')
}
function visibilityChanged() {
  if (document.hidden) cancelPress()
}
watch(
  () => props.sessionKey,
  () => reset(),
)
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) reset(false)
  },
)
watch(
  () => props.touchMode,
  () => releasePointer(true),
)
watch(
  () => [props.keyboardOpen, props.keyboardMode],
  () => {
    cancelPress()
    if (!props.keyboardOpen) closeSheet()
  },
)
useResizeObserver([actions, safeArea], measureHeight)
onMounted(() => {
  window.addEventListener('blur', cancelPress)
  document.addEventListener('visibilitychange', visibilityChanged)
})
onBeforeUnmount(() => {
  textRequest?.abort()
  pendingFiles?.dispose()
  pendingFiles = undefined
  cancelPress()
  window.removeEventListener('blur', cancelPress)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <section
    class="mobile-keyboard"
    :class="{
      'has-dock': hasDock,
      'reduced-motion': reducedMotion,
    }"
    @pointerdown.stop
    @mousedown.stop
    @keydown.esc.stop.prevent="escape"
  >
    <div ref="safeArea" class="mobile-key-safe" aria-hidden="true" />
    <div
      class="mobile-key-row"
      role="toolbar"
      :aria-label="t('terminal.keyboard.helperKeys')"
      @contextmenu.prevent
      @pointerdown="composing && $event.preventDefault()"
      @mousedown="composing && $event.preventDefault()"
    >
      <button
        v-for="key in keys"
        :key="key.key"
        type="button"
        :disabled="inactive"
        :aria-label="key.label"
        :aria-pressed="keyPressed(key.key)"
        :class="{ 'arrow-key': key.symbol }"
        @pointerdown="press($event, key.key)"
        @pointermove="movePress"
        @pointerup="releasePress"
        @pointercancel="cancelPress"
        @lostpointercapture="cancelPress"
        @click="keyboardClick($event, key.key)"
      >
        {{ key.symbol || key.label }}
      </button>
      <button
        type="button"
        :disabled="composing"
        :aria-label="switchLabel"
        :title="switchLabel"
        :aria-pressed="keyboardMode === 'builtin'"
        :class="{
          active:
            (keyboardOpen && keyboardMode === 'builtin') ||
            modifiers.shift ||
            modifiers.alt ||
            modifiers.meta,
        }"
        @pointerdown.prevent
        @click="switchKeyboard"
      >
        <CanvasGlyph name="keyboard-switch" :size="19" />
      </button>
    </div>
    <div
      class="mobile-key-dock"
      :class="{ blank: !deck }"
      :style="{ height: `${Math.max(0, dockHeight)}px` }"
      :inert="!hasDock || !deck"
      :aria-hidden="!hasDock || !deck"
      role="region"
      :aria-label="t('terminal.keyboard.builtin')"
      @wheel.stop
    >
      <div
        ref="actions"
        class="mobile-key-actions"
        role="toolbar"
        :aria-label="t('terminal.keyboard.actions')"
        @contextmenu.prevent
      >
        <TransitionGroup
          name="mobile-tool"
          @before-leave="pinLeavingTool"
          @leave-cancelled="unpinTool"
        >
          <button
            key="file"
            type="button"
            :disabled="disabled"
            :aria-label="t('terminal.upload.file')"
            :title="t('terminal.upload.file')"
            @pointerdown.prevent
            @click="pickFiles"
          >
            <UIcon name="i-lucide-file" class="size-[18px]" />
          </button>
          <button
            key="composer"
            type="button"
            :disabled="disabled"
            :aria-label="t('terminal.composer.title')"
            :title="t('terminal.composer.title')"
            @pointerdown.prevent
            @click="emit('composer')"
          >
            <UIcon name="i-lucide-square-pen" class="size-[18px]" />
          </button>
          <button
            key="copy"
            type="button"
            :aria-label="t('terminal.keyboard.selectText')"
            :title="t('terminal.keyboard.selectText')"
            @pointerdown.prevent
            @click="openSelection"
          >
            <UIcon name="i-lucide-copy" class="size-[18px]" />
          </button>
          <button
            v-if="touchMode === 'touchpad'"
            key="left"
            type="button"
            class="mobile-mouse-button"
            :disabled="disabled"
            :aria-label="t('terminal.keyboard.mouseLeft')"
            :title="t('terminal.keyboard.mouseLeft')"
            :aria-pressed="pointerPress?.button === 'left'"
            @pointerdown="pointerDown($event, 'left')"
            @pointerup="pointerUp($event)"
            @pointercancel="pointerUp($event, true)"
            @lostpointercapture="pointerUp($event, true)"
            @click="
              (event) => {
                if (event.detail === 0) emit('pointer', { type: 'click', button: 'left' })
              }
            "
          >
            <UIcon name="i-lucide-mouse-left" class="size-[18px]" />
          </button>
          <button
            v-if="touchMode === 'touchpad'"
            key="middle"
            type="button"
            class="mobile-mouse-button"
            :disabled="disabled"
            :aria-label="t('terminal.keyboard.mouseMiddle')"
            :title="t('terminal.keyboard.mouseMiddle')"
            :aria-pressed="pointerPress?.button === 'middle'"
            @pointerdown="pointerDown($event, 'middle')"
            @pointermove="pointerMove"
            @pointerup="pointerUp($event)"
            @pointercancel="pointerUp($event, true)"
            @lostpointercapture="pointerUp($event, true)"
            @click="
              (event) => {
                if (event.detail === 0) emit('pointer', { type: 'click', button: 'middle' })
              }
            "
          >
            <CanvasGlyph name="mouse-middle" :size="18" />
          </button>
          <button
            v-if="touchMode === 'touchpad'"
            key="right"
            type="button"
            :disabled="disabled"
            :aria-label="t('terminal.keyboard.mouseRight')"
            :title="t('terminal.keyboard.mouseRight')"
            @pointerdown.prevent
            @click="emit('pointer', { type: 'click', button: 'right' })"
          >
            <UIcon name="i-lucide-mouse-right" class="size-[18px]" />
          </button>
          <button
            key="scroll"
            type="button"
            :aria-pressed="touchMode === 'scroll'"
            :aria-label="t('terminal.keyboard.touchScroll')"
            :title="t('terminal.keyboard.touchScroll')"
            @pointerdown.prevent
            @click="chooseMode('scroll')"
          >
            <UIcon name="i-lucide-move-vertical" class="size-[18px]" />
          </button>
          <button
            key="mouse"
            type="button"
            :disabled="disabled"
            :aria-pressed="touchMode === 'mouse'"
            :aria-label="t('terminal.keyboard.touchMouse')"
            :title="t('terminal.keyboard.touchMouse')"
            @pointerdown.prevent
            @click="chooseMode('mouse')"
          >
            <UIcon name="i-lucide-mouse-pointer-2" class="size-[18px]" />
          </button>
          <button
            key="touchpad"
            type="button"
            :disabled="disabled"
            :aria-pressed="touchMode === 'touchpad'"
            :aria-label="t('terminal.keyboard.touchpad')"
            :title="t('terminal.keyboard.touchpad')"
            @pointerdown.prevent
            @click="chooseMode('touchpad')"
          >
            <UIcon name="i-lucide-touchpad" class="size-[18px]" />
          </button>
        </TransitionGroup>
      </div>
      <div
        ref="deckElement"
        class="mobile-key-deck"
        role="group"
        :aria-label="t('terminal.keyboard.full')"
        @scroll.capture="stopRepeat"
        @contextmenu.prevent
      >
        <div
          v-for="row in deckRows"
          :key="row.keys[0]?.key"
          class="mobile-key-deck-row"
          :class="row.class"
          role="group"
          :aria-label="row.name"
        >
          <button
            v-for="key in row.keys"
            :key="key.key"
            type="button"
            :disabled="disabled"
            :aria-label="key.label"
            :title="key.label"
            :aria-pressed="keyPressed(key.key)"
            :style="key.span ? { gridColumn: `span ${key.span}` } : undefined"
            :class="{
              'letter-key': key.key.length === 1,
              'shift-key': key.key.startsWith('Shift'),
              'backspace-key': key.key === 'Backspace',
              'space-key': key.key === ' ',
              'enter-key': key.key === 'Enter',
              'symbol-key': ['Meta', 'Home', 'End'].includes(key.key),
            }"
            @pointerdown="press($event, key.key)"
            @pointermove="movePress"
            @pointerup="releasePress"
            @pointercancel="cancelPress"
            @lostpointercapture="cancelPress"
            @click="keyboardClick($event, key.key)"
          >
            {{ keyLabel(key) }}
          </button>
        </div>
      </div>
    </div>
    <input
      ref="fileInput"
      class="mobile-file-input"
      type="file"
      multiple
      tabindex="-1"
      :aria-label="t('terminal.upload.file')"
      @change="filesChanged"
      @cancel="filesCancelled"
    />
    <UModal
      :open="!!sheet"
      :transition="false"
      :title="t('terminal.keyboard.selectText')"
      :content="{ onCloseAutoFocus: (event) => event.preventDefault() }"
      :ui="{
        content: 'mobile-text-sheet',
        overlay: 'mobile-text-backdrop',
        header: 'shrink-0 px-4 py-3',
        title: 'text-sm font-medium',
        body: 'flex flex-1 min-h-0 p-0 sm:p-0',
        footer: 'shrink-0 justify-end gap-2 p-2',
        close: 'min-w-[44px] min-h-[44px]',
      }"
      @update:open="
        (value) => {
          if (!value) closeSheet()
        }
      "
    >
      <template #body>
        <div
          v-if="loadingText || textFailed"
          class="mobile-text-status"
          :role="textFailed ? 'alert' : 'status'"
        >
          <template v-if="loadingText"
            ><UIcon
              name="i-lucide-loader-circle"
              class="spinner size-3.5 shrink-0 motion-safe:animate-spin"
            />{{ t('common.loading') }}</template
          >
          <template v-else
            ><span>{{ t('panels.scan.incomplete') }}</span
            ><UButton
              type="button"
              color="neutral"
              variant="ghost"
              class="min-h-[44px]"
              @click="loadText"
              >{{ t('common.retry') }}</UButton
            ></template
          >
        </div>
        <textarea
          v-else
          ref="textArea"
          :value="snapshot"
          readonly
          inputmode="none"
          :aria-label="t('terminal.keyboard.terminalText')"
          spellcheck="false"
          @select="updateSelection"
          @pointerup="updateSelection"
          @keyup="updateSelection"
        />
      </template>
      <template #footer>
        <UButton
          type="button"
          color="neutral"
          variant="outline"
          class="min-h-[44px]"
          :disabled="!selected"
          @pointerdown.prevent
          @click="copy(false)"
          >{{ t('terminal.keyboard.copySelection') }}</UButton
        ><UButton
          type="button"
          color="neutral"
          variant="outline"
          class="min-h-[44px]"
          :disabled="!snapshot"
          @pointerdown.prevent
          @click="copy(true)"
          >{{ t('terminal.keyboard.copyAll') }}</UButton
        >
      </template>
    </UModal>
  </section>
</template>

<style scoped>
.mobile-keyboard {
  --key-on: color-mix(in srgb, var(--ui-primary) 55%, #1c1f25);
  --key-on-fg: color-mix(in srgb, var(--ui-primary) 30%, #fff);
  position: relative;
  flex: 0 0 auto;
  min-width: 0;
  border-top: 1px solid #353c47;
  background: #1a1e25;
  /* Nothing below the tools but the safe area: an open keyboard sits directly under them. */
  padding: 4px 4px var(--mobile-safe-bottom, 0px);
  color: #cbd2dd;
  z-index: 6;
  touch-action: manipulation;
}
.mobile-key-row {
  position: relative;
  z-index: 3;
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 3px;
  overflow: hidden;
  min-height: 40px;
  background: #1a1e25;
}
.mobile-keyboard button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 6px;
  border: 1px solid #3a4350;
  border-bottom-color: #48515e;
  border-radius: 5px;
  background: rgb(43 50 61 / var(--key-fill, 1));
  box-shadow:
    inset 0 1px 0 #ffffff05,
    0 1px 1px #0003;
  color: #cbd2dd;
  font-size: 12px;
  line-height: 1;
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  white-space: nowrap;
  -webkit-tap-highlight-color: transparent;
}
.mobile-key-row > button {
  min-width: 0;
  min-height: 40px;
  padding: 0;
  height: 44px;
}
.mobile-keyboard button:active {
  background: #414955;
  border-color: #637082;
  box-shadow: inset 0 1px 2px #0003;
}
.mobile-keyboard button:is([aria-pressed='true'], .active) {
  background: var(--key-on);
  border-color: var(--ui-primary);
  color: var(--key-on-fg);
  box-shadow: inset 0 1px 0 #ffffff12;
}
.mobile-keyboard button:focus-visible {
  outline: 2px solid var(--key-on-fg);
  outline-offset: -3px;
}
.mobile-keyboard button:disabled {
  opacity: 0.4;
  cursor: default;
}
.mobile-keyboard .arrow-key {
  font-size: 21px;
  font-family: system-ui, sans-serif;
}
.mobile-key-safe {
  position: absolute;
  width: 0;
  height: var(--ui-safe-bottom, 0px);
  visibility: hidden;
  pointer-events: none;
}
.mobile-key-dock {
  --key-fill: 0.5;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  /* Keys in an area an IME still makes taller sit at its top, directly under the tools. */
  justify-content: flex-start;
  min-height: 0;
  margin: 0 -4px;
  overflow: hidden;
  padding-bottom: var(--ui-safe-bottom, 0px);
  border-top: 1px solid #48515e;
  background: #181d258c;
}
.mobile-keyboard:not(.has-dock) .mobile-key-dock {
  visibility: hidden;
  padding-bottom: 0;
  border-top-width: 0;
}
/* Under the system keyboard the area is only reserved space: nothing of it shows above the IME. */
.mobile-key-dock.blank {
  border-top-width: 0;
}
.mobile-key-dock.blank > * {
  visibility: hidden;
}

/* The deck has the height of its rows and scrolls where a short frame caps the dock. A row grows
   with the deck width, as the key labels do, up to a full touch target. */
.mobile-key-deck {
  container-type: inline-size;
  flex: 0 1 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 6px;
  overscroll-behavior: contain;
  touch-action: pan-y;
  scrollbar-width: thin;
  scrollbar-color: #515c6b transparent;
}
.mobile-key-deck-row {
  flex: none;
  display: grid;
  gap: 2px;
  min-width: 0;
  height: clamp(36px, 10.5cqw, 48px);
}
.mobile-key-deck button {
  min-width: 0;
  min-height: 0;
  height: auto;
  padding: 0 1px;
  touch-action: pan-y;
  font-size: clamp(10px, 3cqw, 13px);
  border-radius: 5px;
}
.mobile-key-deck .letter-key {
  font-size: clamp(14px, 4.3cqw, 18px);
}
.mobile-key-standard {
  grid-template-columns: repeat(14, minmax(0, 1fr));
}
.mobile-key-functions {
  grid-template-columns: repeat(12, minmax(0, 1fr));
}
.mobile-key-bottom button {
  padding: 0;
  font-size: clamp(8px, 2.4cqw, 11px);
  letter-spacing: -0.25px;
}
.mobile-key-bottom .symbol-key {
  font-size: clamp(12px, 3.6cqw, 18px);
  font-family: system-ui, sans-serif;
  letter-spacing: 0;
}
.mobile-key-deck :is(.shift-key, .backspace-key, .enter-key) {
  font-size: clamp(14px, 4cqw, 20px);
}
.mobile-key-deck :is(.shift-key, .backspace-key, .enter-key):not([aria-pressed='true']) {
  background: rgb(37 44 54 / var(--key-fill, 1));
}
.mobile-key-actions {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  gap: 3px;
  padding: 6px;
  border-bottom: 1px solid #3c4552;
}
.mobile-key-actions button:not([aria-pressed='true']) {
  background: rgb(37 45 55 / var(--key-fill, 1));
  border-color: #35414f;
  color: #b7c3d2;
}
.mobile-key-actions button {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 0;
  min-width: 0;
  min-height: 44px;
  padding: 0;
}
.mobile-key-actions .mobile-mouse-button {
  touch-action: none;
}
.mobile-tool-move {
  transition: transform 160ms ease-out;
}
.mobile-tool-enter-active,
.mobile-tool-leave-active {
  transition:
    opacity 120ms ease-out,
    transform 160ms ease-out;
}
.mobile-tool-enter-from,
.mobile-tool-leave-to {
  opacity: 0;
  transform: translateY(3px);
}
.mobile-tool-leave-active {
  position: absolute;
  pointer-events: none;
}
.reduced-motion :is(.mobile-tool-move, .mobile-tool-enter-active, .mobile-tool-leave-active) {
  transition: none;
}
.mobile-key-actions button:active {
  background: #3b4654;
}
.mobile-file-input {
  display: none;
}
@media (hover: hover) {
  .mobile-keyboard button:hover:not(:disabled):not([aria-pressed='true']):not(.active) {
    background: #37414e;
    border-color: #526071;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .mobile-key-dock {
    --key-fill: 1;
    background: #20252d;
  }
}
</style>

<style>
.mobile-text-backdrop {
  background: #070a10b0;
}
.mobile-text-sheet {
  --text-safe-top: var(--mobile-safe-top, var(--ui-safe-top));
  --text-safe-bottom: var(--mobile-safe-bottom, var(--ui-safe-bottom));
  left: calc(
    var(--mobile-left, 0px) +
      (var(--mobile-width, var(--ui-viewport-width)) + var(--ui-safe-left) - var(--ui-safe-right)) /
      2
  );
  top: calc(
    var(--dialog-top) + (var(--dialog-height) + var(--text-safe-top) - var(--text-safe-bottom)) / 2
  );
  width: min(
    600px,
    calc(
      var(--mobile-width, var(--ui-viewport-width)) - 24px - var(--ui-safe-left) -
        var(--ui-safe-right)
    )
  );
  height: min(
    520px,
    calc(var(--dialog-height) - 24px - var(--text-safe-top) - var(--text-safe-bottom))
  );
  max-width: none;
  max-height: none;
  min-height: 0;
  overflow: hidden;
  overscroll-behavior: contain;
}
.mobile-text-status {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  color: #a0adbf;
  font-size: 13px;
}
.mobile-text-sheet textarea {
  display: block;
  flex: 1;
  min-height: 0;
  resize: none;
  width: 100%;
  padding: 12px;
  margin: 0;
  color: #d7dce5;
  border: 0;
  border-radius: 0;
  outline: none;
  box-shadow: none;
  background: #15191f;
  font-family: var(--content-font-family, monospace);
  font-feature-settings: var(--content-font-features, normal);
  font-size: 16px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow: auto;
  user-select: text;
  -webkit-user-select: text;
  touch-action: pan-y;
  -webkit-touch-callout: default;
}
</style>
