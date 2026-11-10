<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import UButton from '@nuxt/ui/components/Button.vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import type { DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import { NodeResizer } from '@vue-flow/node-resizer'
import Icon from './Icon.vue'
import UploadProgress from './UploadProgress.vue'
import CardLayoutControls from './CardLayoutControls.vue'
import { useLayoutCard } from '../layout-editing'
import { requestTrustedPreview } from '../trusted-preview'
import { captureTrusted, trustCapture } from '../capture-trust'
import { isMarkdownFile } from '../markdown'
import { apiContext, isCurrentApi } from '../api'
import WindowTitle from './WindowTitle.vue'
import { windowLabel } from '../window-title'
import PaneIndicators from './PaneIndicators.vue'
import MobileKeyboard from './MobileKeyboard.vue'
import { statusColor } from '../status'
import { claimNoteDrop, readNoteTransfer } from '../note-transfer'
import { isFileReference, readFileReference } from '../file-reference'
import { useComposer, composerHasContent, discardComposerDraft } from '../composers'
import { capturedApp, setCaptureVisible } from '../capture'
import { useRetainedFrame } from '../retained-frame'
import { useCardContentFocus } from '../card-content-focus'
import { captureToolbarHeight } from '../../../shared/capture'
import { api } from '../api'
import { cachedTerminalView, mountTerminal, type TerminalStatus } from '../terminals'
import { emptyModifiers, type TerminalModifiers } from '../terminal-input'
import type { TerminalTouchMode } from '../terminal-touch'
import type { TouchpadControl } from '../touchpad-gesture'
import { cutoutPosition, cutoutWidth } from '../display-cutout'
import { useDocumentFocus } from '../document-focus'
import { uiZoom } from '../ui-scale'
import { useTerminalSettings } from '../terminal-settings'
import TerminalSettingsDialog from './TerminalSettingsDialog.vue'
import ContentZoom from './ContentZoom.vue'
import CardHeaderActions from './CardHeaderActions.vue'
import PaneContextMenu from './PaneContextMenu.vue'
import type { PaneAction, PaneContext } from '../../../shared/pane-context'
import { contentZoomMenu } from '../content-zoom-menu'
import type { TerminalData } from '../types'
// The editor stays out of the terminal bundle until a composer opens or a mobile terminal is focused.
const loadComposer = () => import('./TerminalComposer.vue')
const TerminalComposer = defineAsyncComponent(loadComposer)
const { t } = useI18n()
const toast = useToast()
const props = defineProps<Pick<NodeProps<TerminalData>, 'id' | 'data'> & Partial<Omit<NodeProps<TerminalData>, 'id' | 'data'>>>()
const layoutRoot = ref<HTMLElement>()
const { editing } = useLayoutCard(layoutRoot)
const host = ref<HTMLElement>()
const app = computed(() => capturedApp(props.data.sourceId, props.data.windowId))
const captureHost = ref<HTMLElement>()
const captureBody = ref<HTMLElement>()
const trustedApp = computed(() => !!app.value && (app.value.preview !== 'static' || captureTrusted(props.data.sourceId, props.data.windowId, app.value.id) || isMarkdownFile(new URL(app.value.url).pathname)))
function withTrustedApp(run: (url: string) => void) {
  const current = app.value, context = apiContext()
  if (!current) return
  const execute = () => {
    if (!isCurrentApi(context) || app.value?.id !== current.id) return
    if (!trustedApp.value) trustCapture(props.data.sourceId, props.data.windowId, current.id)
    run(current.url)
  }
  if (trustedApp.value) execute(); else requestTrustedPreview(current.title, execute)
}
function activateApp() { withTrustedApp(() => showCapturedApp()) }
function openApp() { withTrustedApp(url => window.open(url, '_blank', 'noopener,noreferrer')) }


const showApp = computed(() => !!app.value?.visible && !closed.value && !maximizedElsewhere.value && status.value.status === 'connected')
function showCapturedApp() { setCaptureVisible(props.data.sourceId, props.data.windowId, true) }
function returnToTerminal() {
  const current = terminal
  setCaptureVisible(props.data.sourceId, props.data.windowId, false)
  nextTick(() => { if (!showApp.value && host.value?.isConnected && terminal === current) current?.focus({ keyboard: false }) })
}
const stoppingAppId = ref('')
const stoppingApp = computed(() => stoppingAppId.value === app.value?.id)
const captureError = ref('')
async function stopCapturedApp() {
  const current = app.value
  if (!current || stoppingApp.value) return
  stoppingAppId.value = current.id; captureError.value = ''
  try {
    await api(`/api/captured-apps/${current.id}/stop`, { method: 'POST', body: '{}' })
    if (app.value?.id === current.id) setCaptureVisible(props.data.sourceId, props.data.windowId, false)
  } catch (error) {
    if (app.value?.id === current.id) captureError.value = error instanceof Error ? error.message : String(error)
  } finally { if (stoppingAppId.value === current.id) stoppingAppId.value = '' }
}
const shortcuts = computed(() => [...(showCanvasJumps.value ? ['previous', 'next'] : []), ...(mobileFocus.value && !showApp.value ? ['keyboard'] : []), ...(props.data.focus && !showApp.value ? ['zoom'] : []), ...(canCompose.value ? ['composer'] : [])])
const { effective: settings, overrides, zoom, resetZoom } = useTerminalSettings(() => props.data.preferenceKey)
const settingsOpen = ref(false)
const status = ref<TerminalStatus>({ status: 'connecting' })
const noteDrag = ref(false)
const fileDrag = ref(false)
const closed = computed(() => props.data.closed || status.value.status === 'closed')
const mobilePreview = computed(() => !!props.data.mobile && !props.data.focus && !closed.value)
const mobileFocus = computed(() => !!props.data.mobile && props.data.focus)
const modifiers = computed(() => status.value.modifiers || emptyModifiers())
const reconnecting = computed(() => status.value.status === 'connecting' && !!status.value.retryAttempt)
const keepTerminal = computed(() => !!closed.value && !!cachedTerminalView(props.data.sourceId, props.data.windowId) || props.data.available || !!props.data.sourceOffline && (status.value.status === 'connected' || reconnecting.value))
const maximizedElsewhere = computed(() => !!status.value.presentation?.maximized && (!status.value.presentation.owned || !props.data.focus))
const { active: captureActive, focus: focusCapture, pointerDown: capturePointerDown } = useCardContentFocus(captureBody,
  () => !showApp.value || !trustedApp.value || mobilePreview.value || editing.value)
useRetainedFrame(captureHost, () => app.value && trustedApp.value ? { key: `capture:${app.value.id}`, src: app.value.url, attributes: {
  class: 'capture-frame', title: app.value.title, sandbox: 'allow-scripts allow-forms allow-same-origin allow-downloads allow-popups', referrerpolicy: 'no-referrer', tabindex: !props.data.mobile && !captureActive.value ? '-1' : '0' } } : undefined)
const captureButtonUi = { base: 'capture-action', label: 'capture-action-label', leadingIcon: 'capture-action-icon' }
const noteDropAvailable = computed(() => !showApp.value && keepTerminal.value && !mobilePreview.value && !maximizedElsewhere.value && status.value.status === 'connected')
const noteDropLabel = computed(() => showApp.value ? t('terminal.capture.terminal') : mobilePreview.value ? t('panels.note.openToPaste') : maximizedElsewhere.value ? t('terminal.maximized')
  : status.value.status !== 'connected' || !keepTerminal.value ? t('terminal.upload.disconnected') : t('panels.note.paste'))
const { activeElement, windowFocused } = useDocumentFocus()
const inputFocused = computed(() => !showApp.value && windowFocused.value && !mobilePreview.value && !maximizedElsewhere.value &&
  keepTerminal.value && status.value.status === 'connected' && !status.value.readOnly &&
  !!activeElement.value?.matches('.xterm-helper-textarea, .terminal-mobile-input') && !!host.value?.contains(activeElement.value))
const frameStatus = computed(() => !closed.value && !props.data.sourceOffline ? props.data.status : 'unknown')
const resizeState = computed(() => !props.data.focus ? 'passive' : !status.value.focusResize ? 'pending' : status.value.focusResize.owned ? 'owned' : 'passive')
const uploadActive = computed(() => status.value.upload && ['waiting', 'preparing', 'uploading'].includes(status.value.upload.state))
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
  if (upload.state === 'completed') return t(upload.kind === 'send' ? 'terminal.upload.sent' : (upload.fileCount || 0) > 1 ? 'terminal.upload.pathsInserted' : 'terminal.upload.pathInserted')
  return upload.state === 'waiting' ? t('terminal.upload.waiting') : upload.state === 'preparing' ? t('terminal.upload.preparing') : `${uploadPercent.value}%`
})
const label = computed(() => windowLabel(props.data, status.value.focusedPaneId))
const canvasJumps = computed(() => props.data.focus || props.data.mobile || !props.data.canvasJump ? [] : (['previous', 'next'] as const).map(direction => {
  const target = props.data.canvasJump!.neighbor(direction), action = t(`terminal.action.${direction}Canvas`)
  return { direction, target, label: target ? t('terminal.action.canvasNamed', { action, name: target.name }) : action }
}))
const showCanvasJumps = computed(() => canvasJumps.value.some(jump => jump.target))
// The button preserves terminal focus for pointers; keyboard use keeps button focus.
function jumpCanvas(direction: 'previous' | 'next', event: MouseEvent) {
  props.data.canvasJump?.go(direction, event.detail === 0 ? 'button' : inputFocused.value ? 'terminal' : undefined)
}
let terminal: ReturnType<typeof mountTerminal> | undefined
watch(() => app.value?.id, () => { captureError.value = '' })
watch(showApp, value => terminal?.setAppShowing(value))
watch(editing, value => terminal?.setEditing(value), { flush: 'sync' })
let ownedPresentation = false
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
  const eligible = !editing.value && (previewEligible || event.detail === 0)
  clearPreviewTap()
  if (eligible) action('focus')
}
function contentPointerDown(event: PointerEvent) {
  if (mobilePreview.value || closed.value) return
  event.stopPropagation()
  closeComposer()
  if (event.button === 2) return
  if (!props.data.mobile) terminal?.focus()
  else if (event.pointerType !== 'touch') terminal?.focus()
}
// The composer is a window-owned note shown over the terminal; it never resizes the grid.
const composerTarget = () => ({ sourceId: props.data.sourceId, windowId: props.data.windowId })
const composer = useComposer(composerTarget)
const composerOpen = ref(false)
const canCompose = computed(() => !showApp.value && keepTerminal.value && !closed.value && !mobilePreview.value && !maximizedElsewhere.value && (!props.data.mobile || props.data.focus))
const canSendComposer = computed(() => status.value.status === 'connected' && !status.value.readOnly && !!props.data.available)
const composerDraft = computed(() => !composerOpen.value && !composerSending.value && composerHasContent(composer.value.content))
const composerLabel = computed(() => composerDraft.value ? t('terminal.composer.draft') : t('terminal.composer.title'))
// The text-selection sheet borrows the IME; the mobile composer editor owns it until it closes.
const selecting = ref(false)
watch(selecting, value => terminal?.suspendKeyboard(value))
function openComposer() {
  if (composerOpen.value || !canCompose.value) return
  composerOpen.value = true
}
// A late claim from a collapsing composer is ignored.
function holdKeyboardForPicker() { return terminal?.holdKeyboardForPicker() }
function holdInput() { return terminal?.holdInput() }
function composerKeyboard(editor?: HTMLElement) { if (!editor || composerOpen.value) terminal?.composerKeyboard(editor, closeComposer) }
function closeComposer(focusTerminal = false) {
  if (!composerOpen.value) return
  composerOpen.value = false
  if (props.data.mobile) terminal?.composerKeyboard()
  else if (focusTerminal) terminal?.focus()
}
function toggleComposer() { if (composerOpen.value) closeComposer(true); else openComposer() }
// Sending collapses at once and counts the draft as clean; a failure reopens it with the error.
const composerSending = ref(false), composerError = ref('')
function sendComposer(id: string, version: number, files: string[]) {
  composerSending.value = true; composerError.value = ''
  // Collapse first: a refusal reported synchronously must be able to reopen it.
  closeComposer(true)
  if (!terminal) { composerSending.value = false; composerError.value = t('terminal.upload.disconnected'); openComposer(); return }
  terminal.sendComposer(id, version, files, error => {
    composerSending.value = false
    if (!error) return
    composerError.value = error
    openComposer()
  })
}
watch(canCompose, value => { if (!value) closeComposer() })
// A loaded editor mounts within the opening tap, so the IME moves to it in the same gesture.
watch(mobileFocus, value => { if (value) void loadComposer() }, { immediate: true })
watch(closed, value => { if (value) discardComposerDraft(composerTarget()) }, { flush: 'sync' })
function toggleKeyboard() {
  if (status.value.keyboardRequested) terminal?.blur()
  else terminal?.focus({ keyboard: true })
}
function switchKeyboard() { terminal?.switchKeyboard() }
let keyboardMinHeight = 0
function keyboardBounds(height: number) { keyboardMinHeight = height; terminal?.setKeyboardMinHeight(height) }
function readText(signal: AbortSignal) { return terminal?.readText(signal) ?? Promise.reject(new Error(t('terminal.unavailable'))) }
function paneContext(x: number, y: number, signal: AbortSignal) { return terminal?.paneContext(x, y, signal) ?? Promise.resolve(null) }
function paneAction(pane: PaneContext, command: PaneAction) { return terminal?.paneAction(pane, command) ?? Promise.reject(new Error(t('terminal.unavailable'))) }
function allowsContextMenu() { return terminal?.allowsContextMenu() ?? true }
function copyText(text?: string) { return terminal?.copySelection(text) ?? Promise.resolve(false) }
function reading(active: boolean) { selecting.value = active }
function mobileKey(key: string, modifiers?: Partial<TerminalModifiers>) { terminal?.sendKey(key, modifiers) }
function mobileModifiers(value: TerminalModifiers) { terminal?.setModifiers(value) }
function mobileMode(mode: TerminalTouchMode) { terminal?.setTouchMode(mode) }
function mobilePointer(action: TouchpadControl) { terminal?.touchpadControl(action) }
function prepareFiles() { return terminal?.prepareFiles() }
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
function mount() {
  if (host.value && keepTerminal.value) terminal = mountTerminal(host.value, props.data, state => {
    const superseded = ownedPresentation && state.presentation && !state.presentation.owned
    ownedPresentation = props.data.focus && state.presentation?.owned === true
    status.value = state
    if (superseded) props.data.onAction('unfocus', props.id)
  }, { magnified: props.data.focus, mobile: props.data.mobile, zoom: zoom.value, closed: !!props.data.closed, settings: settings.value })
  terminal?.setAppShowing(showApp.value)
  terminal?.setEditing(editing.value)
  if (keyboardMinHeight) terminal?.setKeyboardMinHeight(keyboardMinHeight)
  if (mobileFocus.value && !showApp.value) {
    if (status.value.touchMode === 'select') terminal?.setTouchMode('scroll')
    terminal?.focus({ keyboard: false })
  }
}
onMounted(() => { mount(); document.addEventListener('dragend', clearNoteDrag); window.addEventListener('blur', clearNoteDrag) })
watch(() => props.data.closed, value => { if (value) terminal?.close() })
watch([zoom, () => props.data.focus], () => { terminal?.setZoom(zoom.value) })
watch(settings, value => terminal?.setSettings(value), { flush: 'sync' })
watch(uiZoom, () => { if (keyboardMinHeight) terminal?.setKeyboardMinHeight(keyboardMinHeight) })
watch(() => status.value.keyboardUnavailable, value => {
  if (value) toast.add({ title: t('terminal.keyboard.systemUnavailable'), color: 'warning' })
})
watch([keepTerminal, () => props.data.mobile, () => props.data.focus], async () => { terminal?.dispose(); terminal = undefined; await nextTick(); mount() })
onBeforeUnmount(() => { clearPreviewTap(); terminal?.dispose(); document.removeEventListener('dragend', clearNoteDrag); window.removeEventListener('blur', clearNoteDrag) })
function action(name: string) {
  if (name === 'reconnect') terminal?.reconnect()
  else { if (name === 'unfocus' && props.data.mobile) terminal?.blur(); props.data.onAction(name, props.id) }
}
const menu = computed<DropdownMenuItem[]>(() => [
  ...(!showApp.value && mobileFocus.value ? [{ slot: 'keyboard', label: t(status.value.keyboardRequested ? 'terminal.action.hideKeyboard' : 'terminal.action.showKeyboard'), icon: 'i-lucide-keyboard', onSelect: toggleKeyboard }] : []),
  ...(props.data.focus && !showApp.value ? contentZoomMenu(zoom, !props.data.available, { reset: resetZoom, resetLabel: t('terminal.settings.restoreDefault') }) : []),
  ...(props.data.newTab ? [{ label: t('app.newTab'), icon: 'i-lucide-square-plus', disabled: !props.data.available || closed.value || props.data.newTab.pending(), onSelect: () => props.data.newTab?.create() }] : []),
  { label: t('panels.scan.title'), icon: 'i-lucide-scan-text', disabled: !keepTerminal.value || closed.value, onSelect: () => action('scan') },
  ...(canCompose.value ? [{ slot: 'composer', label: t('terminal.composer.title'), icon: 'i-lucide-square-pen', onSelect: toggleComposer }] : []),
  { label: t('app.renameWindow'), icon: 'i-lucide-pencil', disabled: !props.data.available || closed.value, onSelect: () => action('rename') },
  { label: t('terminal.settings.title'), icon: 'i-lucide-settings', onSelect: () => { settingsOpen.value = true } },
  { label: t('app.closeWindow'), icon: 'i-lucide-trash', color: 'error', disabled: !props.data.available || closed.value, onSelect: () => action('close') },
])
function resizeStarted(event: { params: { x: number; y: number; width: number; height: number } }) {
  if (!editing.value) terminal?.setResizing(true)
  props.data.onResizeStart(props.id, event.params)
}
async function resized(event: { params: { width: number; height: number; x: number; y: number } }) {
  if (props.data.overview || props.data.focus) return
  await nextTick()
  if (!editing.value) terminal?.setResizing(false)
  const { width, height, x, y } = event.params
  props.data.onResize(props.id, width, height, x, y)
}
</script>
<template>
  <NodeResizer v-if="!data.mobile && !data.overview && !data.focus && !maximizedElsewhere" :min-width="360" :min-height="220" :max-width="4000" :max-height="3000" @resize-start="resizeStarted" @resize-end="resized" />
  <article ref="layoutRoot" tabindex="-1" class="terminal-card" :class="[{ selected, 'terminal-transition': status.transitioning || status.layoutRestoring, unavailable: !closed && !keepTerminal, focused: data.focus, 'input-focused': inputFocused || captureActive, 'terminal-mobile': data.mobile, 'terminal-mobile-preview': mobilePreview, closed }, `program-${frameStatus}`]" :data-source-id="data.sourceId" :data-space-id="data.spaceId" :data-window-id="data.windowId" :data-connection-status="closed ? 'closed' : keepTerminal ? status.status : 'unavailable'" :data-presentation="maximizedElsewhere ? 'paused' : data.focus ? 'maximized' : 'normal'" :data-program-status="data.status" :data-resize-state="resizeState" :data-content-mode="showApp ? 'app' : 'terminal'" :data-input-focused="inputFocused" :data-note-drop="noteDrag ? noteDropAvailable ? 'ready' : 'unavailable' : undefined" @dragenter.capture="noteDragOver" @dragover.capture="noteDragOver" @dragleave="noteDragLeave" @drop.capture="dropNote" :style="{ '--program-color': statusColor(frameStatus), '--capture-toolbar-height': `${captureToolbarHeight}px`, width: dimensions || data.focus ? '100%' : `${data.width}px`, height: dimensions || data.focus ? '100%' : `${data.height}px` }" :aria-label="`${label} · ${data.subtitle}`">
    <header class="terminal-header drag-handle" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined" :class="{ 'cutout-header': mobileFocus }" :data-cutout-position="mobileFocus && cutoutWidth > 0 ? cutoutPosition : undefined" :style="mobileFocus ? { '--cutout-width': `calc(${cutoutWidth}px / var(--ui-zoom))` } : undefined">
      <PaneIndicators :panes="data.panes" :status="data.status" :available="keepTerminal" :connection="closed ? 'closed' : status.status" :error="status.error" :read-only="status.readOnly" :fresh="data.statusFresh && !data.sourceOffline" />
      <WindowTitle class="terminal-name" :class="{ 'cutout-title': mobileFocus }" :window="data" :pane-id="status.focusedPaneId" :description="data.subtitle" />
      <CardHeaderActions class="terminal-actions" :class="{ 'cutout-actions': mobileFocus }" :items="menu" :expanded="data.focus" :removable="!data.overview" :mobile="mobileFocus" :shortcuts="shortcuts" :priority="['previous', 'next', 'keyboard', 'composer', 'zoom']" :trailing="['composer']" :disabled="closed && !data.focus"
        :add-label="t('terminal.action.addToCanvas')" :remove-label="t('terminal.action.removeFromCanvas')" :maximize-label="t('terminal.action.focus')" :restore-label="t('terminal.action.restore')" :more-label="t('terminal.action.windowActions')"
        @add="action('add')" @toggle="action(data.focus ? 'unfocus' : 'focus')" @remove="action('remove')">
        <template v-for="jump in canvasJumps" :key="jump.direction" #[jump.direction]><UButton :class="`card-${jump.direction}-canvas`" data-preserve-content-focus :disabled="!jump.target" :title="jump.label" :aria-label="jump.label" @pointerdown.prevent @click="jumpCanvas(jump.direction, $event)"><Icon name="down" :size="15" :style="{ transform: jump.direction === 'next' ? '' : 'rotate(180deg)' }" /></UButton></template>
        <template #keyboard><UButton class="terminal-keyboard" :title="status.keyboardRequested ? t('terminal.action.hideKeyboard') : t('terminal.action.showKeyboard')" :aria-label="status.keyboardRequested ? t('terminal.action.hideKeyboard') : t('terminal.action.showKeyboard')" :active="!!status.keyboardRequested" :aria-pressed="!!status.keyboardRequested" @pointerdown.prevent @click="toggleKeyboard"><Icon name="keyboard" :size="18" /></UButton></template>
        <template #composer><UButton class="terminal-composer-toggle" :class="{ 'has-draft': composerDraft }" :title="composerLabel" :aria-label="composerLabel" :active="composerOpen" :aria-pressed="composerOpen" @pointerdown.prevent @click="toggleComposer"><Icon name="compose" :size="15" /></UButton></template>
        <template #zoom><ContentZoom v-model="zoom" :mobile="data.mobile" :disabled="!data.available" :label="t('terminal.zoom.title')" :reset="resetZoom" :reset-label="t('terminal.settings.restoreDefault')" /></template>
      </CardHeaderActions>
    </header>
    <div v-if="app" :inert="mobilePreview || editing || undefined" class="capture-toolbar nodrag nopan" @pointerdown.stop @mousedown.stop>
      <span class="capture-title" :class="{ 'capture-error': captureError }" :role="captureError ? 'alert' : undefined" :title="captureError || app.title">{{ captureError || app.title }}</span>
      <UButton type="button" color="neutral" variant="ghost" :size="mobileFocus ? 'sm' : 'xs'" :ui="captureButtonUi" :icon="showApp ? 'i-lucide-terminal' : 'i-lucide-globe'" :label="t(showApp ? 'terminal.capture.terminal' : 'terminal.capture.app')" :title="t(showApp ? 'terminal.capture.terminal' : 'terminal.capture.app')" :aria-label="t(showApp ? 'terminal.capture.terminal' : 'terminal.capture.app')" :disabled="status.status !== 'connected' || closed || maximizedElsewhere" @click="showApp ? returnToTerminal() : activateApp()" />
      <UButton type="button" color="neutral" variant="ghost" :size="mobileFocus ? 'sm' : 'xs'" :ui="captureButtonUi" icon="i-lucide-external-link" :label="t('terminal.capture.open')" :title="t('terminal.capture.open')" :aria-label="t('terminal.capture.open')" @click="openApp" />
      <UButton type="button" color="neutral" variant="ghost" :size="mobileFocus ? 'sm' : 'xs'" :ui="captureButtonUi" icon="i-lucide-square" :label="t('terminal.capture.stop')" :title="t('terminal.capture.stop')" :aria-label="t('terminal.capture.stop')" :loading="stoppingApp" :disabled="stoppingApp" @click="stopCapturedApp" />
    </div>
    <div class="terminal-body">
    <div v-if="app" v-show="showApp && trustedApp" ref="captureBody" class="capture-body card-content nodrag nopan nowheel" :data-content-active="captureActive" :tabindex="mobilePreview ? -1 : 0" :inert="mobilePreview || editing || undefined" :aria-label="app.title" @pointerdown.capture="capturePointerDown" @pointerdown.stop @mousedown.stop @wheel.stop>
      <div ref="captureHost" class="capture-host" />
      <div v-if="!data.mobile && !captureActive" class="capture-activate card-content-activate" role="button" tabindex="0" :aria-label="t('common.openCard', { name: app.title })" @click.stop="focusCapture" @keydown.enter.stop.prevent="focusCapture" @keydown.space.stop.prevent="focusCapture" />
    </div>
    <div v-if="showApp && !trustedApp" class="capture-trust-prompt card-content" :inert="mobilePreview || editing || undefined"><Icon name="globe" :size="32" /><span>{{ app?.title }}</span><UButton v-if="!mobilePreview" color="neutral" variant="outline" @click="activateApp">{{ t('terminal.capture.app') }}</UButton></div>
    <div v-if="keepTerminal" ref="host" class="terminal-host card-content nodrag nopan nowheel" :data-content-active="inputFocused" :class="{ 'terminal-paused': maximizedElsewhere, 'terminal-drop-target': status.draggingFile }" :inert="mobilePreview || closed || showApp || undefined" :aria-hidden="mobilePreview || undefined" @pointerdown="contentPointerDown" @mousedown.stop @wheel.stop @dblclick.stop><div class="terminal-transition-surface" aria-hidden="true" /></div>
    <Transition name="terminal-composer"><TerminalComposer v-if="composerOpen && canCompose" :target="composerTarget()" :can-send="canSendComposer" :mobile="data.mobile" :hold-keyboard="data.mobile ? holdKeyboardForPicker : undefined" :hold-input="holdInput" :error="composerError" @close="closeComposer(true)" @send="sendComposer" @edited="composerError = ''" @keyboard="composerKeyboard" /></Transition>
    <PaneContextMenu :host="host" :enabled="!showApp && keepTerminal && !mobilePreview && !closed && !maximizedElsewhere && status.status === 'connected'" :allows-menu="allowsContextMenu" :lookup="paneContext" :action="paneAction" />
    <TerminalSettingsDialog v-model="overrides" :open="settingsOpen" @close="settingsOpen = false" />

    <div v-if="status.draggingFile" class="terminal-file-drop" aria-hidden="true">{{ t('terminal.upload.drop') }}</div>
    <div v-if="noteDrag || fileDrag" class="terminal-file-drop terminal-note-drop" :class="{ 'note-drop-unavailable': !noteDropAvailable }" aria-hidden="true">{{ !noteDropAvailable ? noteDropLabel : fileDrag ? t(status.fileReading ? 'fileTransfer.preparing' : 'fileTransfer.drop') : noteDropLabel }}</div>
    <span v-if="status.upload?.rejected" class="terminal-copy-notice copy-failed" role="alert">{{ status.upload.rejected }}</span>
    <span v-if="status.fileReading && !fileDrag" class="terminal-copy-notice" role="status">{{ t('fileTransfer.preparing') }}</span>
    <span v-if="status.clipboardError" class="terminal-copy-notice" role="status">{{ t(`terminal.clipboard.${status.clipboardError}`) }}</span>
    <UploadProgress v-if="status.upload && !status.upload.hidden" class="terminal-upload" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined" :data-upload-id="status.upload.id" :data-upload-state="status.upload.state"
      :name="uploadName" :status="uploadLabel" :transferred="status.upload.transferred" :total="status.upload.total" :active="!!uploadActive" :queued="status.upload.queued" :cancelling="status.upload.cancelling" :failed="status.upload.state === 'failed'" @cancel="terminal?.cancelUpload()" />
    <div v-if="data.available && maximizedElsewhere" class="terminal-maximized nodrag nopan" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined" @pointerdown.stop @mousedown.stop @click.stop>
      <span>{{ t('terminal.maximized') }}</span>
      <UButton type="button" color="neutral" variant="outline" size="xs" :loading="status.presentationCancelling" :disabled="status.status !== 'connected' || status.presentation?.lease === undefined" @click.stop="terminal?.cancelMaximized()">{{ t('terminal.action.cancelMaximized') }}</UButton>
    </div>
    <div v-if="closed" class="terminal-closed" role="status">{{ t('terminal.closed') }}</div>
    <div v-else-if="!keepTerminal" class="terminal-unavailable"><Icon name="terminal" :size="28" /><strong>{{ t('terminal.unavailable') }}</strong></div>
    <div v-if="!closed && data.available && status.status === 'disconnected'" class="terminal-disconnected nodrag" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined"><span>{{ status.error || t('terminal.connection.disconnected') }}</span><button @click.stop="action('reconnect')"><Icon name="refresh" :size="13" />{{ t('terminal.connection.reconnect') }}</button></div>
    <div v-if="!showApp && !closed && keepTerminal && !maximizedElsewhere && (status.status === 'connecting' || status.status === 'connected' && !status.screenReady)" class="terminal-loading nodrag" :class="{ 'terminal-loading-initial': !status.screenReady }" role="status"><span class="spinner" />{{ status.retryAttempt ? t('terminal.connection.reconnecting', { attempt: status.retryAttempt }) : t('common.loading') }}</div>
    </div>
    <div v-if="mobilePreview && !closed && !editing" class="terminal-preview-button" role="button" tabindex="0" :aria-label="t('terminal.action.openWindow', { name: label })" @pointerdown="previewStart" @pointermove="previewMove" @pointerup="previewEnd" @pointercancel="clearPreviewTap" @click.stop.prevent="previewClick" @keydown.enter.stop.prevent="action('focus')" @keydown.space.stop.prevent="action('focus')" />
    <MobileKeyboard v-if="mobileFocus && !showApp" :session-key="`${data.sourceId}/${data.windowId}`" :disabled="!data.available || status.status !== 'connected' || maximizedElsewhere" :modifiers="modifiers" :touch-mode="status.touchMode || 'scroll'" :keyboard-mode="status.keyboardMode || 'system'" :keyboard-open="!!status.keyboardRequested" :composing="!!status.keyboardComposer" :dock-height="(status.keyboardDockHeight || 0) / uiZoom" :read-text="readText" :copy-text="copyText" :prepare-files="prepareFiles" @switch-keyboard="switchKeyboard" @bounds="keyboardBounds" @key="mobileKey" @modifiers="mobileModifiers" @mode="mobileMode" @pointer="mobilePointer" @composer="openComposer" @reading="reading" />
  </article>
  <CardLayoutControls :id="id" :label="label" :kind="app ? 'app' : 'terminal'" :width="data.width" :height="data.height" />
</template>

<style scoped>
.terminal-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;overflow:clip}
.terminal-closed{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#171a20bb;color:#a0a9b6;font-size:12px;pointer-events:none}
.closed .terminal-host{opacity:.45}.closed .terminal-actions{opacity:1;pointer-events:auto}

.terminal-host{position:relative}
.terminal-composer-enter-active,.terminal-composer-leave-active{transition:transform 160ms ease-out,opacity 120ms ease-out}
.terminal-composer-enter-from,.terminal-composer-leave-to{transform:translateY(-100%);opacity:0}
@media (prefers-reduced-motion:reduce){.terminal-composer-enter-active,.terminal-composer-leave-active{transition:none}}
.terminal-composer-toggle{position:relative}
.terminal-composer-toggle.has-draft::after{content:'';position:absolute;top:3px;right:3px;width:5px;height:5px;border-radius:50%;background:var(--ui-primary)}
.terminal-transition-surface{position:absolute;inset:0;z-index:3;pointer-events:none;display:none;background:var(--terminal-transition-background,#1b1f26)}
.terminal-transition .terminal-transition-surface{display:block}
.terminal-transition :deep(.xterm-rows),.terminal-transition :deep(.xterm-selection),.terminal-transition :deep(.xterm-viewport),.terminal-transition :deep(.xterm-decoration-container),.terminal-transition :deep(.xterm-overview-ruler){opacity:0}
.terminal-host[data-content-active=false] :deep(.xterm){cursor:inherit}
.terminal-card.input-focused{--frame-rest:color-mix(in srgb,var(--program-color) 60%,#fff)}
.terminal-card.input-focused.program-unknown{--frame-rest:#aeb9c8}
.terminal-card.input-focused .terminal-header{background:color-mix(in srgb,var(--program-color) 27%,#22262d)}
.terminal-card.input-focused .terminal-name{color:#f4f6f9;--window-title-color:#c4cbd5}
.terminal-loading{inset:0;background:#11131799;color:#b0b8c5}
.terminal-loading-initial{z-index:12;background:#111317}
.terminal-maximized{inset:0;z-index:5;flex-direction:column;gap:10px}
.terminal-maximized>button{padding:5px 9px;gap:5px;min-height:28px}
.terminal-drop-target{outline:1px solid var(--ui-primary);outline-offset:-3px;background:color-mix(in srgb,var(--ui-primary) 3%,transparent)}
.terminal-copy-notice{position:absolute;z-index:8;top:8px;right:9px;padding:4px 7px;border:1px solid #424a56;border-radius:4px;background:#242930f2;color:#b6c0ce;font-size:10px;pointer-events:none}
.terminal-copy-notice.copy-failed{border-color:#79545470;background:#33262bf2;color:#d6aaaa}
.terminal-note-drop{z-index:5}.terminal-note-drop.note-drop-unavailable{color:#9aa4b3;background:#171b21df}
.terminal-file-drop{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;background:#12151aca;color:var(--ui-primary);font-size:12px}
.terminal-upload{position:absolute;z-index:8;top:6px;left:8px;right:8px}
.terminal-preview-button{position:absolute;inset:0;z-index:4;pointer-events:auto;cursor:pointer;outline:none;touch-action:none;-webkit-tap-highlight-color:transparent}
.terminal-preview-button:focus-visible{box-shadow:inset 0 0 0 2px var(--ui-primary)}
.terminal-mobile-preview .terminal-host{pointer-events:none}
.terminal-mobile-preview .terminal-actions{visibility:hidden}
.terminal-mobile.focused{--terminal-header-height:calc(44px + var(--mobile-safe-top,0px));min-height:0;border-radius:0;box-shadow:none}
.terminal-mobile.focused .terminal-header{height:var(--terminal-header-height);min-height:var(--terminal-header-height);flex:0 0 var(--terminal-header-height);padding:var(--mobile-safe-top,0px) 0 0;gap:0;cursor:default}
.terminal-mobile.focused .terminal-name{height:44px;font-size:13px}
.canvas-fullscreen .terminal-mobile.focused{--terminal-header-height:44px}
.canvas-fullscreen .terminal-mobile.focused .terminal-header{padding-top:0}
.terminal-mobile.focused{container-type:inline-size}
.terminal-mobile.focused :deep(.terminal-status-trigger){width:44px;height:44px;min-width:44px}
.terminal-mobile.focused .terminal-host{min-height:0;flex:1;touch-action:none}
</style>

<style scoped>
.terminal-mobile-preview .capture-body,.terminal-mobile-preview .capture-toolbar{pointer-events:none}.terminal-mobile-preview .terminal-preview-button{z-index:10}
.capture-trust-prompt{position:absolute;inset:0;z-index:6;background:#1b1f26;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#a4afbe}
.capture-toolbar{container:capture-toolbar / inline-size;flex:0 0 var(--capture-toolbar-height);display:flex;align-items:center;gap:4px;padding:0 8px;background:#252a33;color:#d5d7dd;font-size:12px}
.capture-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.capture-error{color:#e4aaaa}
.capture-toolbar :deep(.capture-action){flex:none;white-space:nowrap}
.capture-body{position:absolute;z-index:5;inset:0;background:#fff;outline:none}.capture-host,.capture-body :deep(.capture-frame){display:block;width:100%;height:100%;border:0}
.capture-activate{position:absolute;inset:0;cursor:pointer;outline:none}
.terminal-mobile.focused .capture-toolbar{flex-basis:44px}.terminal-mobile.focused .capture-toolbar :deep(.capture-action){min-width:44px;min-height:44px;justify-content:center}
@container capture-toolbar (width > 420px){.capture-toolbar :deep(.capture-action-icon:not(.animate-spin)){display:none}}
@container capture-toolbar (width <= 420px){.capture-toolbar :deep(.capture-action-label){display:none}}
</style>
