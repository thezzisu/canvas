<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TerminalModifiers } from '../terminal-input'
import Icon from './Icon.vue'

type TouchMode = 'scroll' | 'mouse' | 'select'
interface Keycap { key: string; label: string; symbol?: string }
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
const arrows: Keycap[] = [
  { key: 'ArrowLeft', label: '向左', symbol: '←' }, { key: 'ArrowDown', label: '向下', symbol: '↓' },
  { key: 'ArrowUp', label: '向上', symbol: '↑' }, { key: 'ArrowRight', label: '向右', symbol: '→' },
]
const keys: Keycap[] = [
  { key: 'Escape', label: 'Esc' }, { key: 'Tab', label: 'Tab' },
  { key: 'Control', label: 'Ctrl' }, ...arrows,
]
const modifierKeys: Record<string, keyof TerminalModifiers> = { Shift: 'shift', Control: 'ctrl', Alt: 'alt', Meta: 'meta' }
const shiftedSymbols: Record<string, string> = { '`': '~', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?' }
const characters = (text: string): Keycap[] => [...text].map(key => ({ key, label: /[a-z]/.test(key) ? key.toUpperCase() : key }))
const deckRows = [
  { name: 'QWERTY', class: 'mobile-key-letters', keys: characters('qwertyuiop') },
  { name: 'ASDF', class: 'mobile-key-home', keys: characters('asdfghjkl') },
  { name: 'ZXCV', class: 'mobile-key-lower', keys: [
    { key: 'Shift', label: 'Shift', symbol: '⇧' }, ...characters('zxcvbnm'), { key: 'Backspace', label: 'Backspace', symbol: '⌫' },
  ] },
  { name: '修改键', class: 'mobile-key-modifiers', keys: [
    { key: 'CapsLock', label: 'Caps Lock', symbol: 'Caps' }, { key: 'Control', label: 'Ctrl' },
    { key: 'Alt', label: 'Alt' }, { key: 'Meta', label: 'Meta' },
    { key: ' ', label: 'Space', symbol: '空格' }, { key: 'Enter', label: 'Enter', symbol: '↵' },
  ] },
  { name: '标点', class: 'mobile-key-symbols', keys: characters('`-=[]\\;\',./') },
  { name: '符号', class: 'mobile-key-letters', keys: characters('!@#$%^&*()') },
  { name: '导航', class: 'mobile-key-strip', keys: [
    ...arrows, { key: 'Home', label: 'Home' }, { key: 'End', label: 'End' },
    { key: 'PageUp', label: 'Page Up', symbol: 'PgUp' }, { key: 'PageDown', label: 'Page Down', symbol: 'PgDn' },
    { key: 'Insert', label: 'Insert', symbol: 'Ins' }, { key: 'Delete', label: 'Delete', symbol: 'Del' },
  ] },
  { name: '功能键', class: 'mobile-key-strip', keys: [
    { key: 'Escape', label: 'Esc' }, { key: 'Tab', label: 'Tab' },
    ...Array.from({ length: 12 }, (_, index) => ({ key: `F${index + 1}`, label: `F${index + 1}` })),
  ] },
]

function keyLabel(key: Keycap) {
  if (key.symbol) return key.symbol
  if (/^[a-z]$/.test(key.key)) return caps.value !== !!props.modifiers.shift ? key.key.toUpperCase() : key.key
  return props.modifiers.shift ? shiftedSymbols[key.key] || key.label : key.label
}
function keyPressed(key: string) {
  if (key === 'CapsLock') return caps.value
  const modifier = modifierKeys[key]
  return modifier ? props.modifiers[modifier] : undefined
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
  emit('key', key, modifiers)
}
function press(event: PointerEvent, key: string) {
  if (event.button !== 0 || props.disabled) return
  event.preventDefault()
  event.stopPropagation()
  stopRepeat()
  if (!event.isPrimary) return
  const target = event.currentTarget as HTMLElement
  const chord = { ...props.modifiers }
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
  if (!held || event.pointerId !== held.pointer) return
  const bounds = held.target.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom
    || held.deferred && Math.hypot(event.clientX - held.x, event.clientY - held.y) > 6) stopRepeat()
}
function releasePress(event: PointerEvent) {
  const press = held
  if (!press || press.pointer !== event.pointerId) return
  if (press.deferred && !press.sent
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 6) send(press.key, press.modifiers)
  stopRepeat()
}
function keyboardClick(event: MouseEvent, key: string) {
  if (event.detail === 0) send(caps.value && /^[a-z]$/.test(key) ? key.toUpperCase() : key, { ...props.modifiers })
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
  copyResult.value = props.copyText(text) ? '已复制' : '复制失败'
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
function pickFiles() { more.value = false; fileInput.value?.click() }
function filesChanged(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...input.files || []]
  input.value = ''
  if (files.length) emit('files', files)
}
function escape() { if (sheet.value) closeSheet(); else more.value = false; stopRepeat() }
function reset() { stopRepeat(); more.value = false; caps.value = false; closeSheet(); emit('modifiers', { shift: false, ctrl: false, alt: false, meta: false }) }
function visibilityChanged() { if (document.hidden) stopRepeat() }
watch(() => props.sessionKey, reset)
watch(() => props.disabled, disabled => { if (disabled) reset() })
onMounted(() => { window.addEventListener('blur', stopRepeat); document.addEventListener('visibilitychange', visibilityChanged) })
onBeforeUnmount(() => { stopRepeat(); clearTimeout(copyTimer); window.removeEventListener('blur', stopRepeat); document.removeEventListener('visibilitychange', visibilityChanged) })
</script>

<template>
  <section class="mobile-keyboard" @pointerdown.stop @mousedown.stop @keydown.esc.stop.prevent="escape">
    <div v-if="more" class="mobile-keys-dismiss" @pointerdown.stop.prevent="more = false" />
    <div v-if="more" class="mobile-keys-more" role="menu" aria-label="更多按键" @wheel.stop>
      <div class="mobile-key-deck" role="group" aria-label="完整键盘" @scroll.capture="stopRepeat" @contextmenu.prevent>
        <div v-for="row in deckRows" :key="row.name" class="mobile-key-deck-row" :class="row.class" role="group" :aria-label="row.name">
          <button v-for="key in row.keys" :key="key.key" type="button" :disabled="disabled" :aria-label="key.label" :aria-pressed="keyPressed(key.key)"
            :class="{ 'arrow-key': key.key.startsWith('Arrow'), 'letter-key': key.key.length === 1, 'shift-key': key.key === 'Shift', 'backspace-key': key.key === 'Backspace', 'space-key': key.key === ' ', 'enter-key': key.key === 'Enter' }"
            @pointerdown="press($event, key.key)" @pointermove="movePress" @pointerup="releasePress" @pointercancel="stopRepeat" @lostpointercapture="stopRepeat" @click="keyboardClick($event, key.key)">{{ keyLabel(key) }}</button>
        </div>
      </div>
      <div class="mobile-key-actions" role="toolbar" aria-label="终端操作">
        <button type="button" :disabled="disabled" aria-label="上传文件" @pointerdown.prevent @click="pickFiles"><Icon name="file" :size="17" /><span>上传文件</span></button>
        <button type="button" :disabled="disabled" aria-label="粘贴文本" @pointerdown.prevent @click="openSheet('paste')"><Icon name="copy" :size="17" /><span>粘贴文本</span></button>
        <button type="button" aria-label="选择文本" @pointerdown.prevent @click="openSheet('select')"><Icon name="note" :size="17" /><span>选择文本</span></button>
        <button type="button" :aria-pressed="touchMode === 'scroll'" aria-label="触控滚动" @pointerdown.prevent @click="chooseMode('scroll')"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18 M8 7l4-4 4 4 M8 17l4 4 4-4" /></svg><span>滚动</span></button>
        <button type="button" :disabled="disabled" :aria-pressed="touchMode === 'mouse'" aria-label="触控鼠标" @pointerdown.prevent @click="chooseMode('mouse')"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="6" /><path d="M12 3v6" /></svg><span>鼠标</span></button>
      </div>
    </div>
    <div class="mobile-key-row" role="toolbar" aria-label="终端辅助键" @contextmenu.prevent>
      <button v-for="key in keys" :key="key.key" type="button" :disabled="disabled" :aria-label="key.label" :aria-pressed="keyPressed(key.key)" :class="{ 'arrow-key': key.symbol }" @pointerdown="press($event, key.key)" @pointermove="movePress" @pointerup="releasePress" @pointercancel="stopRepeat" @lostpointercapture="stopRepeat" @click="keyboardClick($event, key.key)">{{ key.symbol || key.label }}</button>
      <button type="button" aria-label="更多按键" :aria-expanded="more" :class="{ active: more || modifiers.shift || modifiers.alt || modifiers.meta }" @pointerdown.prevent @click="toggleMore"><Icon name="more" :size="19" /></button>
    </div>
    <input ref="fileInput" class="mobile-file-input" type="file" multiple tabindex="-1" aria-label="上传文件" @change="filesChanged" />
    <div v-if="sheet" class="mobile-text-backdrop" @pointerdown.self="closeSheet">
      <section class="mobile-text-sheet" role="dialog" aria-modal="true" :aria-label="sheet === 'select' ? '选择文本' : '粘贴文本'">
        <header><strong>{{ sheet === 'select' ? '选择文本' : '粘贴文本' }}</strong><button type="button" :aria-label="sheet === 'select' ? '关闭选择' : '关闭粘贴'" @pointerdown.prevent @click="closeSheet"><Icon name="close" :size="18" /></button></header>
        <textarea v-if="sheet === 'select'" ref="textArea" :value="snapshot" readonly inputmode="none" aria-label="终端文本" spellcheck="false" @select="updateSelection" @pointerup="updateSelection" @keyup="updateSelection" />
        <textarea v-else ref="textArea" v-model="draft" aria-label="待粘贴文本" placeholder="长按粘贴" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" @paste="pasteFiles" />
        <footer v-if="sheet === 'select'"><span role="status">{{ copyResult }}</span><button type="button" :disabled="!selected" @pointerdown.prevent @click="copy(false)">复制选中</button><button type="button" :disabled="!snapshot" @pointerdown.prevent @click="copy(true)">复制全部</button></footer>
        <footer v-else><button type="button" :disabled="!draft || disabled" @pointerdown.prevent @click="pasteText">粘贴到终端</button></footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.mobile-keyboard{position:relative;flex:0 0 auto;min-width:0;border-top:1px solid #353c47;background:#1a1e25;padding:4px;color:#cbd2dd;z-index:6;touch-action:manipulation}
.mobile-key-row{position:relative;z-index:3;display:grid;grid-template-columns:repeat(8,minmax(44px,1fr));gap:3px;overflow-x:auto;overscroll-behavior-x:contain;min-height:44px;background:#1a1e25;scrollbar-width:none}
.mobile-key-row::-webkit-scrollbar{display:none}
.mobile-keyboard button{min-height:44px;min-width:44px;padding:0 6px;border:1px solid #3a4350;border-bottom-color:#48515e;border-radius:5px;background:#2b323d;box-shadow:inset 0 1px 0 #ffffff05,0 1px 1px #0003;color:#cbd2dd;font-size:12px;line-height:1;touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;white-space:nowrap;-webkit-tap-highlight-color:transparent}
.mobile-keyboard button:active{background:#414955;border-color:#637082;box-shadow:inset 0 1px 2px #0003}
.mobile-keyboard button[aria-pressed=true],.mobile-keyboard button.active{background:#493b31;border-color:#977254;color:#f2c5a2;box-shadow:inset 0 1px 0 #e9b18812}
.mobile-keyboard button:focus-visible{outline:2px solid #d9ab87;outline-offset:-3px}
.mobile-keyboard button:disabled{opacity:.4;cursor:default}
.mobile-keyboard .arrow-key{font-size:21px;font-family:system-ui,sans-serif}
.mobile-keys-dismiss{position:fixed;inset:0;z-index:1;background:transparent}
.mobile-keys-more{position:absolute;left:50%;bottom:calc(100% + 5px);width:min(760px,calc(100% - 8px));transform:translateX(-50%);z-index:2;display:flex;flex-direction:column;max-height:min(460px,calc(var(--mobile-height,100dvh) - 110px - env(safe-area-inset-top) - env(safe-area-inset-bottom)));overflow:hidden;background:#20252d;border:1px solid #48515e;border-radius:9px;box-shadow:0 8px 32px #0008}
.mobile-key-deck{flex:1 1 auto;min-height:0;overflow:auto;padding:6px;overscroll-behavior:contain;touch-action:pan-x pan-y;scrollbar-width:thin;scrollbar-color:#515c6b transparent}
.mobile-key-deck-row{display:grid;gap:3px;margin-bottom:4px}
.mobile-key-deck-row:last-child{margin-bottom:0}
.mobile-key-deck button{min-width:0;height:44px;padding:0 2px;touch-action:pan-x pan-y;font-size:11px}
.mobile-key-deck .letter-key{font-size:16px}
.mobile-key-letters{grid-template-columns:repeat(10,minmax(0,1fr))}
.mobile-key-home{grid-template-columns:repeat(9,minmax(0,1fr));margin-left:5%;margin-right:5%}
.mobile-key-lower{grid-template-columns:1.5fr repeat(7,minmax(0,1fr)) 1.5fr}
.mobile-key-modifiers{grid-template-columns:repeat(4,minmax(40px,1fr)) minmax(44px,2fr) minmax(44px,1.2fr)}
.mobile-key-deck .shift-key,.mobile-key-deck .backspace-key,.mobile-key-deck .enter-key{font-size:20px;background:#252c36}
.mobile-key-deck .space-key{font-size:11px;color:#acb6c4}
.mobile-key-deck .shift-key[aria-pressed=true]{background:#493b31}
.mobile-key-symbols{grid-template-columns:repeat(11,minmax(0,1fr))}
.mobile-key-strip{grid-auto-flow:column;grid-auto-columns:minmax(44px,1fr);overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none}
.mobile-key-strip::-webkit-scrollbar{display:none}
.mobile-key-actions{flex:0 0 auto;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;padding:6px;border-top:1px solid #3c4552;background:#191e25}
.mobile-key-actions button{min-width:0;min-height:48px;flex-direction:column;gap:5px;padding:4px 0;font-size:10px;background:#252d37;border-color:#35414f;color:#b7c3d2}
.mobile-key-actions button[aria-pressed=true]{background:#3d342e;border-color:#886b54;color:#e8bc9a}
.mobile-key-actions button:active{background:#3b4654}
.mobile-file-input{display:none}
.mobile-text-backdrop{position:fixed;left:var(--mobile-left,0);top:var(--mobile-top,0);width:var(--mobile-width,100%);height:var(--mobile-height,100dvh);z-index:90;display:flex;align-items:center;justify-content:center;padding:12px;background:#070a10b0}
.mobile-text-sheet{width:min(600px,100%);max-height:100%;height:min(520px,80%);display:flex;flex-direction:column;overflow:hidden;border:1px solid #48515f;border-radius:9px;background:#20252d;box-shadow:0 16px 50px #0008}
.mobile-text-sheet header{display:flex;align-items:center;justify-content:space-between;flex:0 0 48px;padding:0 6px 0 15px;border-bottom:1px solid #353e4b}
.mobile-text-sheet strong{font-size:14px;font-weight:500}
.mobile-text-sheet textarea{display:block;flex:1;min-height:0;resize:none;width:100%;padding:12px;margin:0;color:#d7dce5;border:0;border-radius:0;outline:none;box-shadow:none;background:#15191f;font-family:'JetBrains Mono',monospace;font-size:16px;line-height:1.5;white-space:pre-wrap;overflow:auto;user-select:text;-webkit-user-select:text;touch-action:pan-y;-webkit-touch-callout:default}
.mobile-text-sheet footer{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex:0 0 52px;padding:2px 8px;border-top:1px solid #353e4b}
.mobile-text-sheet footer>span{margin-right:auto;color:#a0b6a9;font-size:11px}
.mobile-text-sheet footer button{background:#333c49;color:#d4dfed;font-size:12px}
@media(hover:hover){.mobile-keyboard button:hover:not(:disabled):not([aria-pressed=true]):not(.active){background:#37414e;border-color:#526071}}
@media(max-height:400px){.mobile-text-backdrop{padding:5px}.mobile-text-sheet{height:100%;}.mobile-text-sheet header{flex-basis:44px}.mobile-text-sheet footer{flex-basis:44px}}
</style>
