<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import { NodeResizer } from '@vue-flow/node-resizer'
import Icon from './Icon.vue'
import PaneIndicators from './PaneIndicators.vue'
import MobileKeyboard from './MobileKeyboard.vue'
import { statusColor } from '../status'
import { mountTerminal, type TerminalStatus } from '../terminals'
import { emptyModifiers, type TerminalModifiers } from '../terminal-input'
import { terminalInsets } from '../terminal-geometry'
import type { TerminalData } from '../types'
const props = defineProps<Pick<NodeProps<TerminalData>, 'id' | 'data'> & Partial<Omit<NodeProps<TerminalData>, 'id' | 'data'>>>()
const host = ref<HTMLElement>()
const status = ref<TerminalStatus>({ status: 'connecting' })
const mobilePreview = computed(() => !!props.data.mobile && !props.data.focus)
const mobileFocus = computed(() => !!props.data.mobile && props.data.focus)
const modifiers = computed(() => status.value.modifiers || emptyModifiers())
const reconnecting = computed(() => status.value.status === 'connecting' && !!status.value.retryAttempt)
const keepTerminal = computed(() => props.data.available || !!props.data.sourceOffline && (status.value.status === 'connected' || reconnecting.value))
const maximizedElsewhere = computed(() => !!status.value.presentation?.maximized && (!status.value.presentation.owned || !props.data.focus))
const frameStatus = computed(() => !keepTerminal.value || status.value.status === 'disconnected' ? 'error' : props.data.status)
const resizeState = computed(() => !props.data.focus ? 'passive' : !status.value.focusResize ? 'pending' : status.value.focusResize.owned ? 'owned' : 'passive')
const uploadActive = computed(() => status.value.upload && ['preparing', 'uploading'].includes(status.value.upload.state))
const uploadPercent = computed(() => {
  const upload = status.value.upload
  return upload?.total ? Math.min(100, Math.floor(upload.transferred / upload.total * 100)) : upload?.state === 'completed' ? 100 : 0
})
const uploadLabel = computed(() => {
  const upload = status.value.upload
  if (!upload) return ''
  if (upload.cancelling) return '取消中…'
  if (upload.state === 'failed') return upload.error || '上传失败'
  if (upload.state === 'cancelled') return '已取消'
  if (upload.state === 'completed') return '已插入路径'
  return upload.state === 'preparing' ? '准备上传…' : `${uploadPercent.value}%`
})
const liveTitle = computed(() => {
  const value = props.data.panes.find(pane => pane.id === status.value.focusedPaneId)?.terminalTitle || ''
  return value === props.data.name ? '' : value
})
const title = computed(() => [props.data.name, liveTitle.value, props.data.subtitle].filter(Boolean).join('\n'))
let terminal: ReturnType<typeof mountTerminal> | undefined
let ownedPresentation = false
let resizeOrigin: { x: number; y: number } | undefined
let previewTap: { id: number; x: number; y: number; at: number } | undefined
let previewEligible = false
function clearPreviewTap() { previewTap = undefined; previewEligible = false; document.removeEventListener('pointerdown', cancelMultiTap, true) }
function cancelMultiTap(event: PointerEvent) { if (previewTap && event.pointerId !== previewTap.id) clearPreviewTap() }
function previewStart(event: PointerEvent) {
  previewEligible = false
  if (!event.isPrimary || event.button !== 0) { clearPreviewTap(); return }
  previewTap = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() }
  document.addEventListener('pointerdown', cancelMultiTap, true)
}
function previewMove(event: PointerEvent) {
  if (previewTap && (event.pointerId !== previewTap.id || Math.hypot(event.clientX - previewTap.x, event.clientY - previewTap.y) > 6)) clearPreviewTap()
}
function previewEnd(event: PointerEvent) {
  const tap = previewTap
  clearPreviewTap()
  previewEligible = tap?.id === event.pointerId && performance.now() - tap.at < 600 && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) <= 6
}
function previewClick(event: MouseEvent) {
  const eligible = previewEligible || event.detail === 0
  clearPreviewTap()
  if (eligible) action('focus')
}
function contentPointerDown(event: PointerEvent) {
  if (mobilePreview.value) return
  event.stopPropagation()
  if (!props.data.mobile) terminal?.focus()
  else if (event.pointerType !== 'touch') terminal?.focus()
}
function toggleKeyboard() {
  if (status.value.keyboardRequested) terminal?.blur()
  else terminal?.focus({ keyboard: true })
}
function readText() { return terminal?.selectionText() || terminal?.viewportText() || '' }
function copyText(text?: string) { return terminal?.copySelection(text) ?? false }
function reading(active: boolean) { if (active) terminal?.blur() }
function mobileKey(key: string, modifiers?: Partial<TerminalModifiers>) { terminal?.sendKey(key, modifiers) }
function mobileModifiers(value: TerminalModifiers) { terminal?.setModifiers(value) }
function mobileMode(mode: 'scroll' | 'mouse' | 'select') { terminal?.setTouchMode(mode) }
function mobileFiles(files: File[]) { terminal?.uploadFiles(files) }
function mobilePaste(text: string) { terminal?.pasteText(text) }
function mount() {
  if (host.value && keepTerminal.value) terminal = mountTerminal(host.value, props.data, state => {
    const superseded = ownedPresentation && state.presentation?.maximized && !state.presentation.owned
    ownedPresentation = props.data.focus && state.presentation?.owned === true
    status.value = state
    if (superseded) props.data.onAction('unfocus', props.id)
  }, geometry => {
    if (props.data.focus || maximizedElsewhere.value) return
    const element = host.value
    const card = element?.closest<HTMLElement>('.terminal-card')
    if (!element || !card) return
    const inset = terminalInsets(card, element)
    props.data.onGeometry(props.data.sourceId, props.data.windowId, geometry.height / geometry.width, inset.x, inset.y)
  }, { magnified: props.data.focus, mobile: props.data.mobile })
  if (mobileFocus.value) { terminal?.setTouchMode('scroll'); terminal?.focus({ keyboard: false }) }
}
onMounted(mount)
watch([keepTerminal, () => props.data.mobile, () => props.data.focus], async () => { terminal?.dispose(); terminal = undefined; await nextTick(); mount() })
onBeforeUnmount(() => { clearPreviewTap(); terminal?.dispose() })
function action(name: string) {
  if (name === 'reconnect') terminal?.reconnect()
  else { if (name === 'unfocus' && props.data.mobile) terminal?.blur(); props.data.onAction(name, props.id) }
}
function resizeStarted(event: { params: { x: number; y: number } }) {
  resizeOrigin = { x: event.params.x, y: event.params.y }
  props.data.onLayoutStart()
}
async function resized(event: { params: { width: number; height: number; x: number; y: number } }) {
  if (props.data.overview || props.data.focus) return
  await nextTick()
  const geometry = terminal?.resize()
  let { width, height, x, y } = event.params
  const element = host.value, card = element?.closest<HTMLElement>('.terminal-card')
  if (geometry && element && card) {
    const inset = terminalInsets(card, element)
    const snappedWidth = geometry.width + inset.x
    const snappedHeight = geometry.height + inset.y
    // A left/top handle keeps the opposite edge anchored when snapping.
    if (resizeOrigin && x !== resizeOrigin.x) x += width - snappedWidth
    if (resizeOrigin && y !== resizeOrigin.y) y += height - snappedHeight
    width = snappedWidth; height = snappedHeight
  }
  resizeOrigin = undefined
  props.data.onResize(props.id, width, height, x, y)
}
</script>
<template>
  <NodeResizer v-if="!data.mobile && !data.overview && !data.focus && !maximizedElsewhere" :is-visible="selected" :min-width="360" :min-height="220" :max-width="4000" :max-height="3000" @resize-start="resizeStarted" @resize-end="resized" />
  <article tabindex="-1" class="terminal-card" :class="[{ selected, unavailable: !keepTerminal, focused: data.focus, 'terminal-mobile': data.mobile, 'terminal-mobile-preview': mobilePreview }, `program-${frameStatus}`]" :data-source-id="data.sourceId" :data-space-id="data.spaceId" :data-window-id="data.windowId" :data-connection-status="keepTerminal ? status.status : 'unavailable'" :data-presentation="maximizedElsewhere ? 'paused' : data.focus ? 'maximized' : 'normal'" :data-program-status="data.status" :data-resize-state="resizeState" :style="{ '--program-color': statusColor(frameStatus), width: dimensions || mobileFocus ? '100%' : `${data.width}px`, height: dimensions || mobileFocus ? '100%' : `${data.height}px` }" :aria-label="`${data.name} · ${data.subtitle}`">
    <header class="terminal-header drag-handle">
      <PaneIndicators :panes="data.panes" :status="data.status" :available="keepTerminal" :connection="status.status" :error="status.error" :read-only="status.readOnly" />
      <span class="terminal-name" :title="title"><span class="terminal-tab-name">{{ data.name }}</span><span v-if="liveTitle" class="terminal-live-title">{{ liveTitle }}</span></span>
      <div class="terminal-actions nodrag">
        <button v-if="data.overview && !mobileFocus" title="加入画布" aria-label="加入画布" @click.stop="action('add')"><Icon name="plus" :size="15" /></button>
        <button v-else-if="!mobileFocus" title="从画布移除" aria-label="从画布移除" @click.stop="action('remove')"><Icon name="minus" :size="15" /></button>
        <button v-if="!data.focus" title="聚焦窗口" aria-label="聚焦窗口" @click.stop="action('focus')"><Icon name="expand" :size="14" /></button>
        <button v-if="mobileFocus" :title="status.keyboardRequested ? '隐藏键盘' : '打开键盘'" :aria-label="status.keyboardRequested ? '隐藏键盘' : '打开键盘'" :aria-pressed="status.keyboardRequested" @pointerdown.stop.prevent @click.stop="toggleKeyboard"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10" /></svg></button>
        <button title="窗口操作" aria-label="窗口操作" @click.stop="action('menu')"><Icon name="more" :size="17" /></button>
        <button v-if="data.focus" title="退出放大" aria-label="退出放大" @click.stop="action('unfocus')"><Icon name="collapse" :size="15" /></button>
      </div>
    </header>
    <div v-if="keepTerminal" ref="host" class="terminal-host nodrag nopan nowheel" :class="{ 'terminal-paused': maximizedElsewhere, 'terminal-drop-target': status.draggingFile }" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined" @pointerdown="contentPointerDown" @mousedown.stop @wheel.stop @dblclick.stop />
    <div v-if="mobilePreview" class="terminal-preview-button" role="button" tabindex="0" :aria-label="`打开窗口 ${data.name}`" @pointerdown="previewStart" @pointermove="previewMove" @pointerup="previewEnd" @pointercancel="clearPreviewTap" @click.stop.prevent="previewClick" @keydown.enter.stop.prevent="action('focus')" @keydown.space.stop.prevent="action('focus')" />
    <div v-if="status.draggingFile" class="terminal-file-drop" aria-hidden="true">上传文件</div>
    <span v-if="status.clipboardError" class="terminal-copy-notice" :class="{ 'copy-failed': status.clipboardError === '复制失败' }" role="status">{{ status.clipboardError }}</span>
    <div v-if="status.upload" class="terminal-upload nodrag nopan" :class="{ 'upload-failed': status.upload.state === 'failed' }" :data-upload-id="status.upload.id" :data-upload-state="status.upload.state" @pointerdown.stop @mousedown.stop>
      <div class="terminal-upload-row"><span class="terminal-upload-name" :title="status.upload.name">{{ status.upload.name }}</span><small v-if="status.upload.queued">+{{ status.upload.queued }}</small><span class="terminal-upload-status" role="status">{{ uploadLabel }}</span><button :aria-label="uploadActive ? '取消上传' : '关闭上传状态'" :disabled="status.upload.cancelling" @click.stop="terminal?.cancelUpload()"><Icon name="close" :size="13" /></button></div>
      <div v-if="uploadActive" class="terminal-upload-track" role="progressbar" :aria-valuenow="status.upload.transferred" :aria-valuemin="0" :aria-valuemax="status.upload.total" :aria-valuetext="`${uploadPercent}%`" aria-label="文件上传进度"><span :style="{ width: `${uploadPercent}%` }" /></div>
    </div>
    <div v-if="data.available && maximizedElsewhere" class="terminal-maximized">已最大化</div>
    <div v-if="!keepTerminal" class="terminal-unavailable"><Icon name="terminal" :size="28" /><strong>窗口不可用</strong></div>
    <div v-if="data.available && status.status === 'disconnected'" class="terminal-disconnected nodrag"><span>{{ status.error || '终端连接已断开' }}</span><button @click.stop="action('reconnect')"><Icon name="refresh" :size="13" />重连</button></div>
    <div v-if="keepTerminal && status.status === 'connecting'" class="terminal-loading nodrag" role="status"><span class="spinner" />{{ status.retryAttempt ? `重连中 ${status.retryAttempt}/3` : '连接中' }}</div>
    <MobileKeyboard v-if="mobileFocus" :session-key="`${data.sourceId}/${data.windowId}`" :disabled="!data.available || status.status !== 'connected' || maximizedElsewhere" :modifiers="modifiers" :touch-mode="status.touchMode || 'scroll'" :read-text="readText" :copy-text="copyText" @key="mobileKey" @modifiers="mobileModifiers" @mode="mobileMode" @files="mobileFiles" @paste="mobilePaste" @reading="reading" />
  </article>
</template>

<style scoped>
.terminal-name{display:flex;align-items:center;gap:8px}
.terminal-loading{background:#11131799;color:#b0b8c5}
.terminal-tab-name{overflow:hidden;text-overflow:ellipsis;min-width:0}
.terminal-name:has(.terminal-live-title) .terminal-tab-name{max-width:40%;flex-shrink:0}
.terminal-live-title{color:#939ba8;overflow:hidden;text-overflow:ellipsis;min-width:0;font-weight:400}
.terminal-drop-target{outline:1px solid var(--accent);outline-offset:-3px;background:#e9b18808}
.terminal-copy-notice{position:absolute;bottom:8px;right:9px;padding:4px 7px;border:1px solid #424a56;border-radius:4px;background:#242930f2;color:#b6c0ce;font-size:10px;pointer-events:none}
.terminal-copy-notice.copy-failed{border-color:#79545470;background:#33262bf2;color:#d6aaaa}
.terminal-file-drop{position:absolute;inset:30px 0 0;display:flex;align-items:center;justify-content:center;pointer-events:none;background:#12151aca;color:var(--accent);font-size:12px}
.terminal-upload{position:absolute;bottom:6px;left:8px;right:8px;padding:4px 7px;border:1px solid #424a56;border-radius:4px;background:#242930f2;color:#b6c0ce;box-shadow:0 2px 8px #0003;font-size:10px}
.terminal-upload-row{display:flex;align-items:center;gap:8px;min-height:19px}
.terminal-upload-name{min-width:0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.terminal-upload-status{flex-shrink:0;font-variant-numeric:tabular-nums;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.terminal-upload-row>small{color:#7f8b9b;font-size:9px}
.terminal-upload button{height:18px;width:18px;min-width:18px;padding:0;color:#8c98a9;border-radius:3px}
.terminal-upload button:hover{color:#e3c9b5;background:#ffffff09}
.terminal-upload-track{height:2px;margin-top:3px;border-radius:1px;background:#414a57;overflow:hidden}
.terminal-upload-track>span{display:block;height:100%;background:var(--accent)}
.upload-failed .terminal-upload-status{color:var(--danger)}
.terminal-preview-button{position:absolute;inset:0;z-index:4;pointer-events:auto;cursor:pointer;outline:none;touch-action:none;-webkit-tap-highlight-color:transparent}
.terminal-preview-button:focus-visible{box-shadow:inset 0 0 0 2px var(--accent)}
.terminal-mobile-preview .terminal-host{pointer-events:none}
.terminal-mobile-preview .terminal-actions{visibility:hidden}
.terminal-mobile.focused{min-height:0;border-radius:0;box-shadow:none}
.terminal-mobile.focused .terminal-header{height:44px;min-height:44px;flex:0 0 44px;padding:0 4px;gap:3px;cursor:default}
.terminal-mobile.focused .terminal-name{font-size:13px}
.terminal-mobile.focused .terminal-actions{opacity:1;pointer-events:auto;gap:0}
.terminal-mobile.focused .terminal-actions button{width:44px;height:44px;min-width:44px;border-radius:4px}
.terminal-mobile.focused :deep(.terminal-status-trigger){width:44px;height:44px;min-width:44px}
.terminal-mobile.focused .terminal-host{min-height:0;flex:1;touch-action:none}
.terminal-mobile.focused .terminal-loading,.terminal-mobile.focused .terminal-maximized,.terminal-mobile.focused .terminal-file-drop{top:44px;bottom:49px}
.terminal-mobile.focused .terminal-upload{bottom:55px}
.terminal-mobile.focused .terminal-copy-notice{bottom:57px}
.terminal-mobile.focused .terminal-disconnected{bottom:49px}
</style>
