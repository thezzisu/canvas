<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'

type Modifiers = { ctrl: boolean; alt: boolean }
type TouchMode = 'scroll' | 'mouse' | 'select'
const props = defineProps<{
  sessionKey: string
  disabled?: boolean
  modifiers: Modifiers
  touchMode: TouchMode
  readText(): string
  copyText(text?: string): boolean
}>()
const emit = defineEmits<{
  key: [key: string, modifiers?: Partial<Modifiers>]
  modifiers: [value: Modifiers]
  mode: [value: TouchMode]
  files: [files: File[]]
  paste: [text: string]
  reading: [active: boolean]
}>()
const more = ref(false)
const sheet = ref<'select' | 'paste'>()
const snapshot = ref('')
const draft = ref('')
const copyResult = ref('')
const selected = ref(false)
const textArea = ref<HTMLTextAreaElement>()
const fileInput = ref<HTMLInputElement>()
let held: { pointer: number; target: HTMLElement; key: string; modifiers?: Partial<Modifiers>;
  x: number; y: number; deferred: boolean; sent: boolean } | undefined
let repeatDelay: ReturnType<typeof setTimeout> | undefined
let repeatTimer: ReturnType<typeof setInterval> | undefined
let copyTimer: ReturnType<typeof setTimeout> | undefined
let previousMode: TouchMode = 'scroll'
const keys = [
  { key: 'Escape', label: 'Esc' }, { key: 'Tab', label: 'Tab' },
  { key: 'ArrowLeft', label: '向左', symbol: '←' }, { key: 'ArrowDown', label: '向下', symbol: '↓' },
  { key: 'ArrowUp', label: '向上', symbol: '↑' }, { key: 'ArrowRight', label: '向右', symbol: '→' },
]
const extraKeys = [
  { key: 'Home', label: 'Home' }, { key: 'End', label: 'End' },
  { key: 'PageUp', label: 'Page Up' }, { key: 'PageDown', label: 'Page Down' },
  { key: 'Delete', label: 'Delete' },
]

function stopRepeat() {
  clearTimeout(repeatDelay)
  clearInterval(repeatTimer)
  const press = held
  held = undefined
  if (press?.target.hasPointerCapture(press.pointer)) press.target.releasePointerCapture(press.pointer)
}
function send(key: string, modifiers?: Partial<Modifiers>) {
  if (!props.disabled) emit('key', key, modifiers)
}
function press(event: PointerEvent, key: string, modifiers?: Partial<Modifiers>) {
  if (event.button !== 0 || props.disabled) return
  event.preventDefault()
  event.stopPropagation()
  stopRepeat()
  const target = event.currentTarget as HTMLElement
  const chord = { ...props.modifiers, ...modifiers }
  const row = target.closest<HTMLElement>('.mobile-key-row')
  const deferred = event.pointerType === 'touch' && !!row && row.scrollWidth > row.clientWidth + 1
  held = { pointer: event.pointerId, target, key, modifiers: chord,
    x: event.clientX, y: event.clientY, deferred, sent: !deferred }
  target.setPointerCapture(event.pointerId)
  if (!deferred) send(key, chord)
  if (!key.startsWith('Arrow') && key !== 'Delete') return
  repeatDelay = setTimeout(() => {
    if (!held) return
    if (!held.sent) { held.sent = true; send(held.key, held.modifiers) }
    repeatTimer = setInterval(() => { if (held) send(held.key, held.modifiers) }, 80)
  }, 400)
}
function movePress(event: PointerEvent) {
  if (held?.deferred && event.pointerId === held.pointer && Math.hypot(event.clientX - held.x, event.clientY - held.y) > 6) stopRepeat()
}
function releasePress(event: PointerEvent) {
  const press = held
  if (press?.pointer === event.pointerId && press.deferred && !press.sent
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 6) send(press.key, press.modifiers)
  stopRepeat()
}
function keyboardClick(event: MouseEvent, key: string, modifiers?: Partial<Modifiers>) {
  if (event.detail === 0) send(key, modifiers)
}
function toggleModifier(name: keyof Modifiers) {
  if (!props.disabled) emit('modifiers', { ...props.modifiers, [name]: !props.modifiers[name] })
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
function reset() { stopRepeat(); more.value = false; closeSheet(); emit('modifiers', { ctrl: false, alt: false }) }
function visibilityChanged() { if (document.hidden) stopRepeat() }
watch(() => props.sessionKey, reset)
watch(() => props.disabled, disabled => { if (disabled) reset() })
onMounted(() => { window.addEventListener('blur', stopRepeat); document.addEventListener('visibilitychange', visibilityChanged) })
onBeforeUnmount(() => { stopRepeat(); clearTimeout(copyTimer); window.removeEventListener('blur', stopRepeat); document.removeEventListener('visibilitychange', visibilityChanged) })
</script>

<template>
  <section class="mobile-keyboard" @pointerdown.stop @mousedown.stop @keydown.esc.stop.prevent="escape">
    <div v-if="more" class="mobile-keys-dismiss" @pointerdown.stop.prevent="more = false" />
    <div v-if="more" class="mobile-keys-more" role="menu" aria-label="更多按键">
      <button type="button" :disabled="disabled" :aria-pressed="modifiers.alt" aria-label="Alt" @pointerdown.prevent @click="toggleModifier('alt')">Alt</button>
      <button v-for="key in extraKeys" :key="key.key" type="button" :disabled="disabled" :aria-label="key.label" @pointerdown="press($event, key.key)" @pointerup="releasePress" @pointercancel="stopRepeat" @lostpointercapture="stopRepeat" @click="keyboardClick($event, key.key)">{{ key.label }}</button>
      <button type="button" :disabled="disabled" aria-label="Ctrl+C" @pointerdown="press($event, 'c', { ctrl: true })" @pointerup="releasePress" @pointercancel="stopRepeat" @lostpointercapture="stopRepeat" @click="keyboardClick($event, 'c', { ctrl: true })">Ctrl+C</button>
      <button type="button" :disabled="disabled" aria-label="上传文件" @pointerdown.prevent @click="pickFiles"><Icon name="file" :size="17" /><span>文件</span></button>
      <button type="button" :disabled="disabled" aria-label="粘贴文本" @pointerdown.prevent @click="openSheet('paste')">粘贴文本</button>
      <button type="button" aria-label="选择文本" @pointerdown.prevent @click="openSheet('select')">选择文本</button>
      <button type="button" :aria-pressed="touchMode === 'scroll'" aria-label="触控滚动" @pointerdown.prevent @click="chooseMode('scroll')">滚动</button>
      <button type="button" :disabled="disabled" :aria-pressed="touchMode === 'mouse'" aria-label="触控鼠标" @pointerdown.prevent @click="chooseMode('mouse')">鼠标</button>
    </div>
    <div class="mobile-key-row" role="toolbar" aria-label="终端辅助键">
      <template v-for="(key, index) in keys" :key="key.key">
        <button v-if="index === 2" type="button" :disabled="disabled" aria-label="Ctrl" :aria-pressed="modifiers.ctrl" @pointerdown.prevent @click="toggleModifier('ctrl')">Ctrl</button>
        <button type="button" :disabled="disabled" :aria-label="key.label" :class="{ 'arrow-key': key.symbol }" @pointerdown="press($event, key.key)" @pointermove="movePress" @pointerup="releasePress" @pointercancel="stopRepeat" @lostpointercapture="stopRepeat" @click="keyboardClick($event, key.key)">{{ key.symbol || key.label }}</button>
      </template>
      <button type="button" aria-label="更多按键" :aria-expanded="more" :class="{ active: more || modifiers.alt }" @pointerdown.prevent @click="toggleMore"><Icon name="more" :size="19" /></button>
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
.mobile-keyboard{position:relative;flex:0 0 auto;min-width:0;border-top:1px solid #353c47;background:#1d2229;padding:0 4px;color:#c4ccd8;z-index:6;touch-action:manipulation}
.mobile-key-row{display:grid;grid-template-columns:repeat(8,minmax(44px,1fr));overflow-x:auto;overscroll-behavior-x:contain;min-height:48px;scrollbar-width:none}
.mobile-key-row::-webkit-scrollbar{display:none}
.mobile-keyboard button{min-height:44px;min-width:44px;padding:0 7px;font-size:12px;line-height:1;border-radius:5px;touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;white-space:nowrap}
.mobile-keyboard button:active,.mobile-keyboard button[aria-pressed=true],.mobile-keyboard button.active{background:#e9b18822;color:#f0c5a6}
.mobile-keyboard button:disabled{opacity:.4;cursor:default}
.mobile-key-row .arrow-key{font-size:21px;font-family:system-ui,sans-serif}
.mobile-keys-dismiss{position:fixed;inset:0;z-index:1;background:transparent}
.mobile-keys-more{position:absolute;left:4px;right:4px;bottom:calc(100% + 5px);z-index:2;display:grid;grid-template-columns:repeat(4,minmax(44px,1fr));gap:3px;max-height:min(270px,calc(var(--mobile-height,100dvh) - 110px - env(safe-area-inset-top) - env(safe-area-inset-bottom)));overflow:auto;padding:6px;background:#242a33;border:1px solid #464f5d;border-radius:8px;box-shadow:0 7px 28px #0007}
.mobile-keys-more button{height:46px;gap:5px;font-size:11px}
.mobile-key-row{position:relative;z-index:3;background:#1d2229}
.mobile-file-input{display:none}
.mobile-text-backdrop{position:fixed;left:var(--mobile-left,0);top:var(--mobile-top,0);width:var(--mobile-width,100%);height:var(--mobile-height,100dvh);z-index:90;display:flex;align-items:center;justify-content:center;padding:12px;background:#070a10b0}
.mobile-text-sheet{width:min(600px,100%);max-height:100%;height:min(520px,80%);display:flex;flex-direction:column;overflow:hidden;border:1px solid #48515f;border-radius:9px;background:#20252d;box-shadow:0 16px 50px #0008}
.mobile-text-sheet header{display:flex;align-items:center;justify-content:space-between;flex:0 0 48px;padding:0 6px 0 15px;border-bottom:1px solid #353e4b}
.mobile-text-sheet strong{font-size:14px;font-weight:500}
.mobile-text-sheet textarea{display:block;flex:1;min-height:0;resize:none;width:100%;padding:12px;margin:0;color:#d7dce5;border:0;border-radius:0;outline:none;box-shadow:none;background:#15191f;font-family:'JetBrains Mono',monospace;font-size:16px;line-height:1.5;white-space:pre-wrap;overflow:auto;user-select:text;-webkit-user-select:text;touch-action:pan-y;-webkit-touch-callout:default}
.mobile-text-sheet footer{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex:0 0 52px;padding:2px 8px;border-top:1px solid #353e4b}
.mobile-text-sheet footer>span{margin-right:auto;color:#a0b6a9;font-size:11px}
.mobile-text-sheet footer button{background:#333c49;color:#d4dfed;font-size:12px}
@media(max-height:400px){.mobile-text-backdrop{padding:5px}.mobile-text-sheet{height:100%;}.mobile-text-sheet header{flex-basis:44px}.mobile-text-sheet footer{flex-basis:44px}}
</style>
