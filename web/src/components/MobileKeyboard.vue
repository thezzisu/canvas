<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TerminalModifiers } from '../terminal-input'
import Icon from './Icon.vue'

const { t } = useI18n()

type TouchMode = 'scroll' | 'mouse' | 'select'
interface Keycap { key: string; label: string; symbol?: string; span?: number }
const props = defineProps<{
  sessionKey: string
  disabled?: boolean
  modifiers: TerminalModifiers
  touchMode: TouchMode
  readText(): string
  copyText(text?: string): boolean
}>()
const emit = defineEmits<{
  key: [key: string, modifiers?: Partial<TerminalModifiers>]
  modifiers: [value: TerminalModifiers]
  mode: [value: TouchMode]
  files: [files: File[]]
  paste: [text: string]
  reading: [active: boolean]
}>()
const more = ref(false)
const caps = ref(false)
const sheet = ref<'select' | 'paste'>()
const snapshot = ref('')
const draft = ref('')
const copyResult = ref('')
const selected = ref(false)
const textArea = ref<HTMLTextAreaElement>()
const fileInput = ref<HTMLInputElement>()
let held: { pointer: number; target: HTMLElement; key: string; modifiers: TerminalModifiers;
  x: number; y: number; deferred: boolean; sent: boolean } | undefined
let repeatDelay: ReturnType<typeof setTimeout> | undefined
let repeatTimer: ReturnType<typeof setInterval> | undefined
let copyTimer: ReturnType<typeof setTimeout> | undefined
let previousMode: TouchMode = 'scroll'
const arrows = computed<Keycap[]>(() => [
  { key: 'ArrowLeft', label: t('terminal.keyboard.arrowLeft'), symbol: '←' }, { key: 'ArrowDown', label: t('terminal.keyboard.arrowDown'), symbol: '↓' },
  { key: 'ArrowUp', label: t('terminal.keyboard.arrowUp'), symbol: '↑' }, { key: 'ArrowRight', label: t('terminal.keyboard.arrowRight'), symbol: '→' },
])
const keys = computed<Keycap[]>(() => [
  { key: 'Escape', label: 'Esc' }, { key: 'Tab', label: 'Tab' },
  { key: 'Control', label: 'Ctrl' }, ...arrows.value,
])
const modifierKeys: Record<string, keyof TerminalModifiers> = { Shift: 'shift', ShiftRight: 'shift', Control: 'ctrl', ControlRight: 'ctrl', Alt: 'alt', AltRight: 'alt', Meta: 'meta' }
const shiftedSymbols: Record<string, string> = { '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?' }
const characters = (text: string): Keycap[] => [...text].map(key => ({ key, label: /[a-z]/.test(key) ? key.toUpperCase() : key }))
const deckRows = computed(() => [
  { name: t('terminal.keyboard.functions'), class: 'mobile-key-functions', keys: Array.from({ length: 12 }, (_, index) => ({ key: `F${index + 1}`, label: `F${index + 1}` })) as Keycap[] },
  { name: t('terminal.keyboard.numbers'), class: 'mobile-key-standard', keys: [...characters('`1234567890-='), { key: 'Backspace', label: 'Backspace', symbol: '⌫' }] },
  { name: 'QWERTY', class: 'mobile-key-standard', keys: [{ key: 'Tab', label: 'Tab', symbol: '⇥' }, ...characters('qwertyuiop[]\\')] },
  { name: 'ASDF', class: 'mobile-key-standard', keys: [{ key: 'CapsLock', label: 'Caps Lock', symbol: 'Caps' }, ...characters("asdfghjkl;'"), { key: 'Enter', label: 'Enter', symbol: '↵', span: 2 }] },
  { name: 'ZXCV', class: 'mobile-key-standard', keys: [{ key: 'Shift', label: 'Shift', symbol: '⇧', span: 2 }, ...characters('zxcvbnm,./'), { key: 'ShiftRight', label: t('terminal.keyboard.rightShift'), symbol: '⇧', span: 2 }] },
  { name: t('terminal.keyboard.modifiers'), class: 'mobile-key-standard mobile-key-bottom', keys: [
    { key: 'Control', label: 'Ctrl' }, { key: 'Meta', label: 'Meta', symbol: '⊞' }, { key: 'Alt', label: 'Alt' },
    { key: ' ', label: 'Space', symbol: '', span: 3 }, { key: 'AltRight', label: t('terminal.keyboard.rightAlt'), symbol: 'Alt' }, { key: 'ControlRight', label: t('terminal.keyboard.rightCtrl'), symbol: 'Ctrl' },
    { key: 'PageUp', label: 'Page Up', symbol: 'Pg↑' }, { key: 'PageDown', label: 'Page Down', symbol: 'Pg↓' },
    { key: 'Home', label: 'Home', symbol: '↤' }, { key: 'End', label: 'End', symbol: '↦' }, { key: 'Insert', label: 'Insert', symbol: 'Ins' }, { key: 'Delete', label: 'Delete', symbol: 'Del' },
  ] },
])
const modifierPresses = ref(new Map<number, { key: keyof TerminalModifiers; previous: boolean; value: boolean; used: boolean; target: HTMLElement }>())
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
  if (cancelled && !press.used) emit('modifiers', { ...props.modifiers, [press.key]: press.previous })
  return true
}
function cancelPress(event?: Event) {
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
  if (/^[a-z]$/.test(key.key)) return caps.value !== !!activeModifiers.value.shift ? key.key.toUpperCase() : key.key
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
  if (press?.target.hasPointerCapture(press.pointer)) press.target.releasePointerCapture(press.pointer)
}
function send(key: string, modifiers?: Partial<TerminalModifiers>) {
  if (props.disabled) return
  if (key === 'CapsLock') { caps.value = !caps.value; return }
  const modifier = modifierKeys[key]
  if (modifier) { emit('modifiers', { ...props.modifiers, [modifier]: !props.modifiers[modifier] }); return }
  for (const press of modifierPresses.value.values()) press.used = true
  emit('key', key, modifiers)
}
function press(event: PointerEvent, key: string) {
  if (event.button !== 0 || props.disabled) return
  event.preventDefault()
  event.stopPropagation()
  stopRepeat()
  const target = event.currentTarget as HTMLElement
  const modifier = modifierKeys[key]
  if (modifier) {
    const previous = activeModifiers.value[modifier]
    modifierPresses.value.set(event.pointerId, { key: modifier, previous, value: !previous, used: false, target })
    target.setPointerCapture(event.pointerId)
    emit('modifiers', { ...props.modifiers, [modifier]: !previous })
    return
  }
  if (!event.isPrimary && !modifierPresses.value.size) return
  const chord = { ...activeModifiers.value }
  // A touch may become a scroll. Commit only on release or a stationary hold.
  const deferred = event.pointerType === 'touch'
  const value = caps.value && /^[a-z]$/.test(key) ? key.toUpperCase() : key
  held = { pointer: event.pointerId, target, key: value, modifiers: chord,
    x: event.clientX, y: event.clientY, deferred, sent: !deferred }
  target.setPointerCapture(event.pointerId)
  if (!deferred) send(value, chord)
  if (!(key.length === 1 || key.startsWith('Arrow') || ['Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'].includes(key))) return
  repeatDelay = setTimeout(() => {
    if (!held) return
    if (!held.sent) { held.sent = true; send(held.key, held.modifiers) }
    repeatTimer = setInterval(() => { if (held) send(held.key, held.modifiers) }, 80)
  }, 400)
}
function movePress(event: PointerEvent) {
  const modifier = modifierPresses.value.get(event.pointerId)
  if (modifier) {
    const box = modifier.target.getBoundingClientRect()
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) releaseModifier(event.pointerId, true)
    return
  }
  if (!held || event.pointerId !== held.pointer) return
  const bounds = held.target.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom
    || held.deferred && Math.hypot(event.clientX - held.x, event.clientY - held.y) > 6) stopRepeat()
}
function releasePress(event: PointerEvent) {
  if (releaseModifier(event.pointerId)) return
  const press = held
  if (!press || press.pointer !== event.pointerId) return
  if (press.deferred && !press.sent
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 6) send(press.key, press.modifiers)
  stopRepeat()
}
function keyboardClick(event: MouseEvent, key: string) {
  if (event.detail === 0) send(caps.value && /^[a-z]$/.test(key) ? key.toUpperCase() : key, { ...activeModifiers.value })
}
function toggleMore() { stopRepeat(); more.value = !more.value }
function chooseMode(mode: TouchMode) { emit('mode', mode); more.value = false }
function closeSheet() {
  if (!sheet.value) return
  sheet.value = undefined
  copyResult.value = ''
  selected.value = false
  emit('mode', previousMode === 'select' ? 'scroll' : previousMode)
  emit('reading', false)
}
async function openSheet(kind: 'select' | 'paste') {
  stopRepeat()
  more.value = false
  previousMode = props.touchMode
  emit('reading', true)
  emit('mode', 'select')
  snapshot.value = kind === 'select' ? props.readText() : ''
  draft.value = ''
  copyResult.value = ''
  selected.value = false
  sheet.value = kind
  if (kind === 'select') { await nextTick(); textArea.value?.focus({ preventScroll: true }) }
}
function updateSelection() {
  const area = textArea.value
  selected.value = !!area && area.selectionStart !== area.selectionEnd
}
function copy(all: boolean) {
  const area = textArea.value
  const text = all ? snapshot.value : area?.value.slice(area.selectionStart, area.selectionEnd) || ''
  if (!text) return
  copyResult.value = props.copyText(text) ? 'copied' : 'failed'
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copyResult.value = '' }, 1800)
}
function pasteText() {
  if (!draft.value || props.disabled) return
  emit('paste', draft.value)
  closeSheet()
}
function pasteFiles(event: ClipboardEvent) {
  const data = event.clipboardData
  const files = data?.files.length ? [...data.files] : [...data?.items || []].map(item => item.kind === 'file' ? item.getAsFile() : null).filter((file): file is File => !!file)
  if (!files.length) return
  event.preventDefault()
  event.stopPropagation()
  emit('files', files)
  closeSheet()
}
function pickFiles() { more.value = false; emit('reading', true); fileInput.value?.click() }
function filesChanged(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...input.files || []]
  input.value = ''
  if (files.length) emit('files', files)
}
function escape() { if (sheet.value) closeSheet(); else more.value = false; stopRepeat() }
function reset() { cancelPress(); more.value = false; caps.value = false; closeSheet(); emit('modifiers', { shift: false, ctrl: false, alt: false, meta: false }) }
function visibilityChanged() { if (document.hidden) cancelPress() }
watch(() => props.sessionKey, reset)
watch(() => props.disabled, disabled => { if (disabled) reset() })
onMounted(() => { window.addEventListener('blur', cancelPress); document.addEventListener('visibilitychange', visibilityChanged) })
onBeforeUnmount(() => { cancelPress(); clearTimeout(copyTimer); window.removeEventListener('blur', cancelPress); document.removeEventListener('visibilitychange', visibilityChanged) })
</script>

<template>
  <section class="mobile-keyboard" @pointerdown.stop @mousedown.stop @keydown.esc.stop.prevent="escape">
    <div v-if="more" class="mobile-keys-dismiss" @pointerdown.stop.prevent="more = false" />
    <div v-if="more" class="mobile-keys-more" role="menu" :aria-label="t('terminal.keyboard.more')" @wheel.stop>
      <div class="mobile-key-deck" role="group" :aria-label="t('terminal.keyboard.full')" @scroll.capture="stopRepeat" @contextmenu.prevent>
        <div v-for="row in deckRows" :key="row.keys[0]?.key" class="mobile-key-deck-row" :class="row.class" role="group" :aria-label="row.name">
          <button v-for="key in row.keys" :key="key.key" type="button" :disabled="disabled" :aria-label="key.label" :title="key.label" :aria-pressed="keyPressed(key.key)" :style="key.span ? { gridColumn: `span ${key.span}` } : undefined"
            :class="{ 'letter-key': key.key.length === 1, 'shift-key': key.key.startsWith('Shift'), 'backspace-key': key.key === 'Backspace', 'space-key': key.key === ' ', 'enter-key': key.key === 'Enter', 'symbol-key': ['Meta', 'Home', 'End'].includes(key.key) }"
            @pointerdown="press($event, key.key)" @pointermove="movePress" @pointerup="releasePress" @pointercancel="cancelPress" @lostpointercapture="cancelPress" @click="keyboardClick($event, key.key)">{{ keyLabel(key) }}</button>
        </div>
      </div>
      <div class="mobile-key-actions" role="toolbar" :aria-label="t('terminal.keyboard.actions')">
        <button type="button" :disabled="disabled" :aria-label="t('terminal.upload.file')" :title="t('terminal.upload.file')" @pointerdown.prevent @click="pickFiles"><Icon name="file" :size="18" /></button>
        <button type="button" :disabled="disabled" :aria-label="t('terminal.keyboard.pasteText')" :title="t('terminal.keyboard.pasteText')" @pointerdown.prevent @click="openSheet('paste')"><Icon name="copy" :size="18" /></button>
        <button type="button" :aria-label="t('terminal.keyboard.selectText')" :title="t('terminal.keyboard.selectText')" @pointerdown.prevent @click="openSheet('select')"><Icon name="note" :size="18" /></button>
        <button type="button" :aria-pressed="touchMode === 'scroll'" :aria-label="t('terminal.keyboard.touchScroll')" :title="t('terminal.keyboard.touchScroll')" @pointerdown.prevent @click="chooseMode('scroll')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18 M8 7l4-4 4 4 M8 17l4 4 4-4" /></svg></button>
        <button type="button" :disabled="disabled" :aria-pressed="touchMode === 'mouse'" :aria-label="t('terminal.keyboard.touchMouse')" :title="t('terminal.keyboard.touchMouse')" @pointerdown.prevent @click="chooseMode('mouse')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="6" /><path d="M12 3v6" /></svg></button>
      </div>
    </div>
    <div class="mobile-key-row" role="toolbar" :aria-label="t('terminal.keyboard.helperKeys')" @contextmenu.prevent>
      <button v-for="key in keys" :key="key.key" type="button" :disabled="disabled" :aria-label="key.label" :aria-pressed="keyPressed(key.key)" :class="{ 'arrow-key': key.symbol }" @pointerdown="press($event, key.key)" @pointermove="movePress" @pointerup="releasePress" @pointercancel="cancelPress" @lostpointercapture="cancelPress" @click="keyboardClick($event, key.key)">{{ key.symbol || key.label }}</button>
      <button type="button" :aria-label="t('terminal.keyboard.more')" :aria-expanded="more" :class="{ active: more || modifiers.shift || modifiers.alt || modifiers.meta }" @pointerdown.prevent @click="toggleMore"><Icon name="more" :size="19" /></button>
    </div>
    <input ref="fileInput" class="mobile-file-input" type="file" multiple tabindex="-1" :aria-label="t('terminal.upload.file')" @change="filesChanged" />
    <div v-if="sheet" class="mobile-text-backdrop" @pointerdown.self="closeSheet">
      <section class="mobile-text-sheet" role="dialog" aria-modal="true" :aria-label="sheet === 'select' ? t('terminal.keyboard.selectText') : t('terminal.keyboard.pasteText')">
        <header><strong>{{ sheet === 'select' ? t('terminal.keyboard.selectText') : t('terminal.keyboard.pasteText') }}</strong><button type="button" :aria-label="t('common.close')" @pointerdown.prevent @click="closeSheet"><Icon name="close" :size="18" /></button></header>
        <textarea v-if="sheet === 'select'" ref="textArea" :value="snapshot" readonly inputmode="none" :aria-label="t('terminal.keyboard.terminalText')" spellcheck="false" @select="updateSelection" @pointerup="updateSelection" @keyup="updateSelection" />
        <textarea v-else ref="textArea" v-model="draft" :aria-label="t('terminal.keyboard.textToPaste')" :placeholder="t('terminal.keyboard.longPressPaste')" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" @paste="pasteFiles" />
        <footer v-if="sheet === 'select'"><span role="status">{{ copyResult ? t(`terminal.clipboard.${copyResult}`) : '' }}</span><button type="button" :disabled="!selected" @pointerdown.prevent @click="copy(false)">{{ t('terminal.keyboard.copySelection') }}</button><button type="button" :disabled="!snapshot" @pointerdown.prevent @click="copy(true)">{{ t('terminal.keyboard.copyAll') }}</button></footer>
        <footer v-else><button type="button" :disabled="!draft || disabled" @pointerdown.prevent @click="pasteText">{{ t('terminal.keyboard.pasteIntoTerminal') }}</button></footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.mobile-keyboard{position:relative;flex:0 0 auto;min-width:0;border-top:1px solid #353c47;background:#1a1e25;padding:4px 4px calc(4px + var(--mobile-safe-bottom,0px));color:#cbd2dd;z-index:6;touch-action:manipulation}
.mobile-key-row{position:relative;z-index:3;display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:3px;overflow:hidden;min-height:40px;background:#1a1e25}
.mobile-keyboard button{min-height:44px;min-width:44px;padding:0 6px;border:1px solid #3a4350;border-bottom-color:#48515e;border-radius:5px;background:#2b323d;box-shadow:inset 0 1px 0 #ffffff05,0 1px 1px #0003;color:#cbd2dd;font-size:12px;line-height:1;touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;white-space:nowrap;-webkit-tap-highlight-color:transparent}
.mobile-key-row>button{min-width:0;min-height:40px;padding:0;height:44px}
.mobile-keyboard button:active{background:#414955;border-color:#637082;box-shadow:inset 0 1px 2px #0003}
.mobile-keyboard button[aria-pressed=true],.mobile-keyboard button.active{background:#493b31;border-color:#977254;color:#f2c5a2;box-shadow:inset 0 1px 0 #e9b18812}
.mobile-keyboard button:focus-visible{outline:2px solid #d9ab87;outline-offset:-3px}
.mobile-keyboard button:disabled{opacity:.4;cursor:default}
.mobile-keyboard .arrow-key{font-size:21px;font-family:system-ui,sans-serif}
.mobile-keys-dismiss{position:fixed;inset:0;z-index:1;background:transparent}
.mobile-keys-more{position:absolute;left:50%;bottom:calc(100% + 5px);width:min(760px,calc(100% - 8px));transform:translateX(-50%);z-index:2;display:flex;flex-direction:column;max-height:min(460px,calc(var(--mobile-height,100dvh) - 110px - var(--mobile-safe-top,0px) - var(--mobile-safe-bottom,0px)));overflow:hidden;background:#20252d;border:1px solid #48515e;border-radius:9px;box-shadow:0 8px 32px #0008}
.mobile-key-deck{container-type:inline-size;flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;padding:6px;overscroll-behavior:contain;touch-action:pan-y;scrollbar-width:thin;scrollbar-color:#515c6b transparent}
.mobile-key-deck-row{display:grid;gap:2px;margin-bottom:4px;min-width:0}
.mobile-key-deck-row:last-child{margin-bottom:0}
.mobile-key-deck button{min-width:0;min-height:0;height:clamp(28px,8cqw,44px);padding:0 1px;touch-action:pan-y;font-size:clamp(8px,2.4cqw,12px);border-radius:4px}
.mobile-key-deck .letter-key{font-size:clamp(11px,3.3cqw,16px)}
.mobile-key-standard{grid-template-columns:repeat(14,minmax(0,1fr))}
.mobile-key-functions{grid-template-columns:repeat(12,minmax(0,1fr))}
.mobile-key-bottom button{padding:0;font-size:clamp(8px,2.4cqw,11px);letter-spacing:-.25px}
.mobile-key-bottom .symbol-key{font-size:clamp(12px,3.6cqw,18px);font-family:system-ui,sans-serif;letter-spacing:0}
.mobile-key-deck .shift-key,.mobile-key-deck .backspace-key,.mobile-key-deck .enter-key{font-size:clamp(14px,4cqw,20px);background:#252c36}
.mobile-key-deck .shift-key[aria-pressed=true]{background:#493b31}
.mobile-key-actions{flex:0 0 auto;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;padding:6px;border-top:1px solid #3c4552;background:#191e25}
.mobile-key-actions button{min-width:0;min-height:44px;padding:0;background:#252d37;border-color:#35414f;color:#b7c3d2}
.mobile-key-actions button[aria-pressed=true]{background:#3d342e;border-color:#886b54;color:#e8bc9a}
.mobile-key-actions button:active{background:#3b4654}
.mobile-file-input{display:none}
.mobile-text-backdrop{--text-safe-top:var(--mobile-safe-top,env(safe-area-inset-top,0px));--text-safe-bottom:var(--mobile-safe-bottom,env(safe-area-inset-bottom,0px));box-sizing:border-box;position:fixed;left:var(--mobile-left,0);top:var(--mobile-top,0);width:var(--mobile-width,100%);height:var(--mobile-height,100dvh);z-index:90;display:flex;align-items:center;justify-content:center;padding:calc(12px + var(--text-safe-top)) calc(12px + env(safe-area-inset-right,0px)) calc(12px + var(--text-safe-bottom)) calc(12px + env(safe-area-inset-left,0px));background:#070a10b0}
.mobile-text-sheet{width:min(600px,100%);max-height:100%;min-height:0;height:min(520px,80%);display:flex;flex-direction:column;overflow:auto;overscroll-behavior:contain;border:1px solid #48515f;border-radius:9px;background:#20252d;box-shadow:0 16px 50px #0008}
.mobile-text-sheet header{display:flex;align-items:center;justify-content:space-between;flex:0 0 48px;padding:0 6px 0 15px;border-bottom:1px solid #353e4b}
.mobile-text-sheet strong{font-size:14px;font-weight:500}
.mobile-text-sheet textarea{display:block;flex:1;min-height:0;resize:none;width:100%;padding:12px;margin:0;color:#d7dce5;border:0;border-radius:0;outline:none;box-shadow:none;background:#15191f;font-family:var(--content-font-family,monospace);font-feature-settings:var(--content-font-features,normal);font-size:16px;line-height:1.5;white-space:pre-wrap;overflow:auto;user-select:text;-webkit-user-select:text;touch-action:pan-y;-webkit-touch-callout:default}
.mobile-text-sheet footer{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex:0 0 52px;padding:2px 8px;border-top:1px solid #353e4b}
.mobile-text-sheet footer>span{margin-right:auto;color:#a0b6a9;font-size:11px}
.mobile-text-sheet footer button{background:#333c49;color:#d4dfed;font-size:12px}
@media(hover:hover){.mobile-keyboard button:hover:not(:disabled):not([aria-pressed=true]):not(.active){background:#37414e;border-color:#526071}}
@media(max-height:400px){.mobile-text-backdrop{padding:calc(5px + var(--text-safe-top)) calc(5px + env(safe-area-inset-right,0px)) calc(5px + var(--text-safe-bottom)) calc(5px + env(safe-area-inset-left,0px))}.mobile-text-sheet{height:100%;}.mobile-text-sheet header{flex-basis:44px}.mobile-text-sheet footer{flex-basis:44px}}
</style>
