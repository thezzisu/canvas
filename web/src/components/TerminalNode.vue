<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import UButton from '@nuxt/ui/components/Button.vue'
import { NodeResizer } from '@vue-flow/node-resizer'
import Icon from './Icon.vue'
import PaneIndicators from './PaneIndicators.vue'
import MobileKeyboard from './MobileKeyboard.vue'
import { statusColor } from '../status'
import { needsAttention } from '../canvas-status'
import { claimNoteDrop, readNoteTransfer } from '../note-transfer'
import { isFileReference, readFileReference } from '../file-reference'
import { copiedFile } from '../file-clipboard'
import { mountTerminal, type TerminalStatus } from '../terminals'
import { emptyModifiers, type TerminalModifiers } from '../terminal-input'
import { terminalInsets } from '../terminal-geometry'
import { cutoutPosition, cutoutWidth, useCompactHeader } from '../display-cutout'
import { useDocumentFocus } from '../document-focus'
import type { TerminalData } from '../types'
const { t } = useI18n()
const props = defineProps<Pick<NodeProps<TerminalData>, 'id' | 'data'> & Partial<Omit<NodeProps<TerminalData>, 'id' | 'data'>>>()
const host = ref<HTMLElement>()
const header = ref<HTMLElement>()
const compact = useCompactHeader(computed(() => props.data.mobile && props.data.focus ? header.value : undefined))
const status = ref<TerminalStatus>({ status: 'connecting' })
const noteDrag = ref(false)
const fileDrag = ref(false)
const mobilePreview = computed(() => !!props.data.mobile && !props.data.focus)
const mobileFocus = computed(() => !!props.data.mobile && props.data.focus)
const modifiers = computed(() => status.value.modifiers || emptyModifiers())
const reconnecting = computed(() => status.value.status === 'connecting' && !!status.value.retryAttempt)
const keepTerminal = computed(() => props.data.available || !!props.data.sourceOffline && (status.value.status === 'connected' || reconnecting.value))
const maximizedElsewhere = computed(() => !!status.value.presentation?.maximized && (!status.value.presentation.owned || !props.data.focus))
const noteDropAvailable = computed(() => keepTerminal.value && !mobilePreview.value && !maximizedElsewhere.value && status.value.status === 'connected')
const noteDropLabel = computed(() => mobilePreview.value ? t('panels.note.openToPaste') : maximizedElsewhere.value ? t('terminal.maximized')
  : status.value.status !== 'connected' || !keepTerminal.value ? t('terminal.upload.disconnected') : t('panels.note.paste'))
const { activeElement, windowFocused } = useDocumentFocus()
const inputFocused = computed(() => windowFocused.value && !mobilePreview.value && !maximizedElsewhere.value &&
  keepTerminal.value && status.value.status === 'connected' && !status.value.readOnly &&
  !!activeElement.value?.matches('.xterm-helper-textarea, .terminal-mobile-input') && !!host.value?.contains(activeElement.value))
const frameStatus = computed(() => !props.data.sourceOffline ? props.data.status : 'unknown')
const statusPulse = computed(() => props.data.statusFresh === true && !props.data.sourceOffline && needsAttention(frameStatus.value))
const resizeState = computed(() => !props.data.focus ? 'passive' : !status.value.focusResize ? 'pending' : status.value.focusResize.owned ? 'owned' : 'passive')
const uploadActive = computed(() => status.value.upload && ['preparing', 'uploading'].includes(status.value.upload.state))
const uploadPercent = computed(() => {
  const upload = status.value.upload
  return upload?.total ? Math.min(100, Math.floor(upload.transferred / upload.total * 100)) : upload?.state === 'completed' ? 100 : 0
})
const uploadName = computed(() => status.value.upload?.fileCount && status.value.upload.fileCount > 1 ? t('terminal.upload.files', { count: status.value.upload.fileCount }) : status.value.upload?.name || '')
const uploadLabel = computed(() => {
  const upload = status.value.upload
  if (!upload) return ''
  if (upload.cancelling) return t('terminal.upload.cancelling')
  if (upload.state === 'failed') return upload.error || t('terminal.upload.failed')
  if (upload.state === 'cancelled') return t('terminal.upload.cancelled')
  if (upload.state === 'completed') return t('terminal.upload.pathInserted')
  return upload.state === 'preparing' ? t('terminal.upload.preparing') : `${uploadPercent.value}%`
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
function noteDragOver(event: DragEvent) {
  if (isFileReference(event.dataTransfer)) {
    event.preventDefault(); event.stopPropagation()
    event.dataTransfer.dropEffect = noteDropAvailable.value && !status.value.fileReading ? 'copy' : 'none'
    fileDrag.value = true; noteDrag.value = false
  } else if (claimNoteDrop(event, noteDropAvailable.value)) { noteDrag.value = true; fileDrag.value = false }
}
function clearNoteDrag() { noteDrag.value = false; fileDrag.value = false }
function noteDragLeave(event: DragEvent) {
  if (event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget)) return
  clearNoteDrag()
}
function dropNote(event: DragEvent) {
  if (isFileReference(event.dataTransfer)) {
    event.preventDefault(); event.stopPropagation(); clearNoteDrag()
    const reference = readFileReference(event.dataTransfer)
    if (reference && noteDropAvailable.value && !status.value.fileReading) void terminal?.uploadReference(reference)
    return
  }
  if (!claimNoteDrop(event, noteDropAvailable.value)) return
  clearNoteDrag()
  const text = readNoteTransfer(event.dataTransfer)
  if (!text || !noteDropAvailable.value || !terminal?.canPasteText()) return
  terminal.focus({ keyboard: false })
  terminal.pasteText(text)
}
function pasteFile() { if (copiedFile.value && noteDropAvailable.value && !status.value.fileReading) void terminal?.uploadReference(copiedFile.value.reference) }
function mount() {
  if (host.value && keepTerminal.value) terminal = mountTerminal(host.value, props.data, state => {
    const superseded = ownedPresentation && state.presentation && !state.presentation.owned
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
onMounted(() => { mount(); document.addEventListener('dragend', clearNoteDrag); window.addEventListener('blur', clearNoteDrag) })
watch([keepTerminal, () => props.data.mobile, () => props.data.focus], async () => { terminal?.dispose(); terminal = undefined; await nextTick(); mount() })
onBeforeUnmount(() => { clearPreviewTap(); terminal?.dispose(); document.removeEventListener('dragend', clearNoteDrag); window.removeEventListener('blur', clearNoteDrag) })
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
  <NodeResizer v-if="!data.mobile && !data.overview && !data.focus && !maximizedElsewhere" :min-width="360" :min-height="220" :max-width="4000" :max-height="3000" @resize-start="resizeStarted" @resize-end="resized" />
  <article tabindex="-1" class="terminal-card" :class="[{ selected, unavailable: !keepTerminal, focused: data.focus, 'input-focused': inputFocused, 'terminal-mobile': data.mobile, 'terminal-mobile-preview': mobilePreview }, `program-${frameStatus}`]" :data-source-id="data.sourceId" :data-space-id="data.spaceId" :data-window-id="data.windowId" :data-connection-status="keepTerminal ? status.status : 'unavailable'" :data-presentation="maximizedElsewhere ? 'paused' : data.focus ? 'maximized' : 'normal'" :data-program-status="data.status" :data-resize-state="resizeState" :data-input-focused="inputFocused" :data-note-drop="noteDrag ? noteDropAvailable ? 'ready' : 'unavailable' : undefined" @dragenter.capture="noteDragOver" @dragover.capture="noteDragOver" @dragleave="noteDragLeave" @drop.capture="dropNote" :style="{ '--program-color': statusColor(frameStatus), width: dimensions || mobileFocus ? '100%' : `${data.width}px`, height: dimensions || mobileFocus ? '100%' : `${data.height}px` }" :aria-label="`${data.name} · ${data.subtitle}`">
    <header ref="header" class="terminal-header drag-handle" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined" :class="{ 'cutout-header': mobileFocus }" :data-cutout-position="mobileFocus && cutoutWidth > 0 ? cutoutPosition : undefined" :style="mobileFocus ? { '--cutout-width': `calc(${cutoutWidth}px / var(--ui-zoom))` } : undefined">
      <PaneIndicators :panes="data.panes" :status="data.status" :available="keepTerminal" :connection="status.status" :error="status.error" :read-only="status.readOnly" :pulse="statusPulse" />
      <span class="terminal-name" :class="{ 'cutout-title': mobileFocus }" :title="title"><span class="terminal-tab-name">{{ data.name }}</span><span v-if="liveTitle" class="terminal-live-title">{{ liveTitle }}</span></span>
      <div class="terminal-actions nodrag" :class="{ 'cutout-actions': mobileFocus }">
        <button v-if="data.overview && !mobileFocus" :title="t('terminal.action.addToCanvas')" :aria-label="t('terminal.action.addToCanvas')" @click.stop="action('add')"><Icon name="layers" :size="15" /></button>
        <button v-else-if="!mobileFocus" :title="t('terminal.action.removeFromCanvas')" :aria-label="t('terminal.action.removeFromCanvas')" @click.stop="action('remove')"><Icon name="close" :size="15" /></button>
        <button v-if="data.newTab && !mobileFocus" :title="t('app.newTab')" :aria-label="t('app.newTab')" :disabled="!data.available || data.newTab.pending()" :aria-busy="data.newTab.pending()" @click.stop="data.newTab.create()"><span v-if="data.newTab.pending()" class="spinner" /><Icon v-else name="tab-plus" :size="15" /></button>
        <button v-if="!data.focus" :title="t('terminal.action.focus')" :aria-label="t('terminal.action.focus')" @click.stop="action('focus')"><Icon name="expand" :size="14" /></button>
        <button v-if="mobileFocus && !compact" :title="status.keyboardRequested ? t('terminal.action.hideKeyboard') : t('terminal.action.showKeyboard')" :aria-label="status.keyboardRequested ? t('terminal.action.hideKeyboard') : t('terminal.action.showKeyboard')" :aria-pressed="status.keyboardRequested" @pointerdown.stop.prevent @click.stop="toggleKeyboard"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10" /></svg></button>
        <button :title="t('terminal.action.windowActions')" :aria-label="t('terminal.action.windowActions')" @click.stop="action('menu')"><Icon name="more" :size="17" /></button>
        <button v-if="data.focus" :title="t('terminal.action.restore')" :aria-label="t('terminal.action.restore')" @click.stop="action('unfocus')"><Icon name="collapse" :size="15" /></button>
      </div>
    </header>
    <div v-if="keepTerminal" ref="host" class="terminal-host card-content nodrag nopan nowheel" :data-content-active="inputFocused" :class="{ 'terminal-paused': maximizedElsewhere, 'terminal-drop-target': status.draggingFile }" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined" @pointerdown="contentPointerDown" @mousedown.stop @wheel.stop @dblclick.stop />
    <div v-if="mobilePreview" class="terminal-preview-button" role="button" tabindex="0" :aria-label="t('terminal.action.openWindow', { name: data.name })" @pointerdown="previewStart" @pointermove="previewMove" @pointerup="previewEnd" @pointercancel="clearPreviewTap" @click.stop.prevent="previewClick" @keydown.enter.stop.prevent="action('focus')" @keydown.space.stop.prevent="action('focus')" />
    <div v-if="status.draggingFile" class="terminal-file-drop" aria-hidden="true">{{ t('terminal.upload.file') }}</div>
    <div v-if="noteDrag || fileDrag" class="terminal-file-drop terminal-note-drop" :class="{ 'note-drop-unavailable': !noteDropAvailable }" aria-hidden="true">{{ !noteDropAvailable ? noteDropLabel : fileDrag ? t(status.fileReading ? 'fileTransfer.preparing' : 'fileTransfer.drop') : noteDropLabel }}</div>
    <span v-if="status.fileReading && !fileDrag" class="terminal-copy-notice" role="status">{{ t('fileTransfer.preparing') }}</span>
    <span v-if="status.clipboardError" class="terminal-copy-notice" :class="{ 'copy-failed': status.clipboardError === 'failed' }" role="status">{{ t(`terminal.clipboard.${status.clipboardError}`) }}</span>
    <div v-if="status.upload" class="terminal-upload nodrag nopan" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined" :class="{ 'upload-failed': status.upload.state === 'failed' }" :data-upload-id="status.upload.id" :data-upload-state="status.upload.state" @pointerdown.stop @mousedown.stop>
      <div class="terminal-upload-row"><span class="terminal-upload-name" :title="uploadName">{{ uploadName }}</span><small v-if="status.upload.queued">+{{ status.upload.queued }}</small><span class="terminal-upload-status" role="status">{{ uploadLabel }}</span><button :aria-label="uploadActive ? t('terminal.upload.cancel') : t('terminal.upload.close')" :disabled="status.upload.cancelling" @click.stop="terminal?.cancelUpload()"><Icon name="close" :size="13" /></button></div>
      <div v-if="uploadActive" class="terminal-upload-track" role="progressbar" :aria-valuenow="status.upload.transferred" :aria-valuemin="0" :aria-valuemax="status.upload.total" :aria-valuetext="`${uploadPercent}%`" :aria-label="t('terminal.upload.progress')"><span :style="{ width: `${uploadPercent}%` }" /></div>
    </div>
    <div v-if="data.available && maximizedElsewhere" class="terminal-maximized nodrag nopan" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined" @pointerdown.stop @mousedown.stop @click.stop>
      <span>{{ t('terminal.maximized') }}</span>
      <UButton type="button" color="neutral" variant="outline" size="xs" :loading="status.presentationCancelling" :disabled="status.status !== 'connected' || status.presentation?.lease === undefined" @click.stop="terminal?.cancelMaximized()">{{ t('terminal.action.cancelMaximized') }}</UButton>
    </div>
    <div v-if="!keepTerminal" class="terminal-unavailable"><Icon name="terminal" :size="28" /><strong>{{ t('terminal.unavailable') }}</strong></div>
    <div v-if="data.available && status.status === 'disconnected'" class="terminal-disconnected nodrag" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined"><span>{{ status.error || t('terminal.connection.disconnected') }}</span><button @click.stop="action('reconnect')"><Icon name="refresh" :size="13" />{{ t('terminal.connection.reconnect') }}</button></div>
    <div v-if="keepTerminal && status.status === 'connecting'" class="terminal-loading nodrag" role="status"><span class="spinner" />{{ status.retryAttempt ? t('terminal.connection.reconnecting', { attempt: status.retryAttempt }) : t('terminal.connection.connecting') }}</div>
    <MobileKeyboard v-if="mobileFocus" :session-key="`${data.sourceId}/${data.windowId}`" :disabled="!data.available || status.status !== 'connected' || maximizedElsewhere" :modifiers="modifiers" :touch-mode="status.touchMode || 'scroll'" :read-text="readText" :copy-text="copyText" @key="mobileKey" @modifiers="mobileModifiers" @mode="mobileMode" @files="mobileFiles" @paste="mobilePaste" @paste-file="pasteFile" @reading="reading" />
  </article>
</template>

<style scoped>
.terminal-host[data-content-active=false] :deep(.xterm){cursor:inherit}
.terminal-name{display:flex;align-items:center;gap:6px}
.terminal-card.input-focused{--frame-rest:color-mix(in srgb,var(--program-color) 60%,#fff)}
.terminal-card.input-focused.program-unknown{--frame-rest:#aeb9c8}
.terminal-card.input-focused .terminal-header{background:color-mix(in srgb,var(--program-color) 27%,#22262d)}
.terminal-card.input-focused .terminal-name{color:#f4f6f9}
.terminal-card.input-focused .terminal-live-title{color:#c4cbd5}
.terminal-loading{background:#11131799;color:#b0b8c5}
.terminal-maximized{z-index:5;flex-direction:column;gap:10px}
.terminal-maximized>button{padding:5px 9px;gap:5px;min-height:28px}
.terminal-tab-name{overflow:hidden;text-overflow:ellipsis;min-width:0}
.terminal-name:has(.terminal-live-title) .terminal-tab-name{max-width:40%;flex-shrink:0}
.terminal-live-title{color:#939ba8;overflow:hidden;text-overflow:ellipsis;min-width:0;font-weight:400}
.terminal-drop-target{outline:1px solid var(--accent);outline-offset:-3px;background:#e9b18808}
.terminal-copy-notice{position:absolute;bottom:8px;right:9px;padding:4px 7px;border:1px solid #424a56;border-radius:4px;background:#242930f2;color:#b6c0ce;font-size:10px;pointer-events:none}
.terminal-copy-notice.copy-failed{border-color:#79545470;background:#33262bf2;color:#d6aaaa}
.terminal-note-drop{z-index:5}.terminal-note-drop.note-drop-unavailable{color:#9aa4b3;background:#171b21df}
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
.terminal-mobile.focused{--terminal-header-height:calc(44px + var(--mobile-safe-top,0px));min-height:0;border-radius:0;box-shadow:none}
.terminal-mobile.focused .terminal-header{height:var(--terminal-header-height);min-height:var(--terminal-header-height);flex:0 0 var(--terminal-header-height);padding:var(--mobile-safe-top,0px) 0 0;gap:0;cursor:default}
.terminal-mobile.focused .terminal-name{height:44px;font-size:13px}
.canvas-fullscreen .terminal-mobile.focused{--terminal-header-height:44px}
.canvas-fullscreen .terminal-mobile.focused .terminal-header{padding-top:0}
.terminal-mobile.focused{container-type:inline-size}
.terminal-mobile.focused .terminal-actions{opacity:1;pointer-events:auto;gap:0}
.terminal-mobile.focused .terminal-actions button{width:44px;height:44px;min-width:44px;border-radius:4px}
.terminal-mobile.focused :deep(.terminal-status-trigger){width:44px;height:44px;min-width:44px}
.terminal-mobile.focused .terminal-host{min-height:0;flex:1;touch-action:none}
.terminal-mobile.focused .terminal-loading,.terminal-mobile.focused .terminal-maximized,.terminal-mobile.focused .terminal-file-drop{top:var(--terminal-header-height);bottom:calc(49px + var(--mobile-safe-bottom,0px))}
.terminal-mobile.focused .terminal-upload{bottom:calc(55px + var(--mobile-safe-bottom,0px))}
.terminal-mobile.focused .terminal-copy-notice{bottom:calc(57px + var(--mobile-safe-bottom,0px))}
.terminal-mobile.focused .terminal-disconnected{bottom:calc(49px + var(--mobile-safe-bottom,0px))}
</style>
