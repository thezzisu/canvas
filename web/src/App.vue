<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { VueFlow, useVueFlow, type Node, type NodeChange, type NodePositionChange, type NodeMouseEvent } from '@vue-flow/core'
import { useActiveElement, useStorage, watchDebounced } from '@vueuse/core'
import { MiniMap } from '@vue-flow/minimap'
import UApp from '@nuxt/ui/components/App.vue'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import { useI18n } from 'vue-i18n'
import { uiLocale } from './i18n'
import LanguageSelect from './components/LanguageSelect.vue'
import InstancePicker from './components/InstancePicker.vue'
import InstanceSetup from './components/InstanceSetup.vue'
import { activeInstance, activeInstanceId, instances, invalidInstanceLink, rememberInstance, selectInstance } from './instances'
import { isCanvasSession } from './instance-url'
import CanvasNavItem from './components/CanvasNavItem.vue'
import { canvasIndicators, needsAttention, windowVisualState } from './canvas-status'
import { cameraFromViewport, recallFreeCanvasLocation, rememberCanvasLocation, resolveCanvasLocation, restoreCanvasPage, viewportFromCamera, type CanvasLocation } from './canvas-location'
import { useCanvasLocation } from './use-canvas-location'
import { subscribeState } from './state-events'
import { retainBackgrounds, useBackgroundUrl } from './backgrounds'
import Icon from './components/Icon.vue'
import TerminalNode from './components/TerminalNode.vue'
import NoteNode from './components/NoteNode.vue'
import FileNode from './components/FileNode.vue'
import { downloadPreview, setDownloadContext, type DownloadContext } from './downloads'
import { isTerminalNode } from './types'
import GroupNode from './components/GroupNode.vue'
import OverviewCreateNode from './components/OverviewCreateNode.vue'
import BackgroundDialog from './components/BackgroundDialog.vue'
import DirectoryDialog from './components/DirectoryDialog.vue'
import UrlDialog from './components/UrlDialog.vue'
import DownloadPreviewDialog from './components/DownloadPreviewDialog.vue'
import WindowContentDialog from './components/WindowContentDialog.vue'
import CanvasFileDrop from './components/CanvasFileDrop.vue'
import WindowPickerTree from './components/WindowPickerTree.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import PwaUpdatePrompt from './components/PwaUpdatePrompt.vue'
import CutoutPreview from './components/CutoutPreview.vue'
import { directoryRequest } from './directories'
import { copiedFile } from './file-clipboard'
import { urlRequest } from './urls'
import { api, apiContext, isCurrentApi, requireCurrentApi, resetApiRequests, setSessionToken, ApiError, segment, uuid, write } from './api'
import { clearTerminals, focusWindow, hasLiveTerminal, pasteFileIntoWindow, setContentFont } from './terminals'
import { buildFontPresentation, ensureContentFont } from './fonts'
import type { GlobalSettings } from '../../shared/settings'
import { useCanvasNavigation } from './canvas-navigation'
import { useMobileLayout } from './mobile-layout'
import { hideMobileKeyboard } from './mobile-keyboard'
import { useDisplayCutout } from './display-cutout'
import { developerMode } from './developer-mode'
import { useScreenWakeLock } from './screen-wake-lock'
import { canvasFrame, preserveCanvasCenter, useMobileViewport, type CanvasFrame } from './viewport'
import { noteColor, statusColor, statusLabel } from './status'
import { overviewResources, overviewFocusStatuses, overviewLayoutKey, overviewStatuses, type OverviewInteraction, type OverviewOrder } from './overview'
import { adjacentPage, pageViewport, retainPage, type OverviewPage, type PageDirection } from './overview-paging'
import type { ProgramStatus } from '../../shared/status'
import type { Canvas, CanvasNode, FileCanvasNode, FileData, NoteCanvasNode, NoteData, NotePatch, SharedState, Source, SourceResource, TerminalCanvasNode, TerminalData, WindowSize } from './types'

const { t, n, locale } = useI18n()
const { fitView, zoomIn, zoomOut, setViewport, getViewport, getNodesInitialized, ariaLiveMessage } = useVueFlow()
const { hasSafeTop } = useDisplayCutout()
const ViewportDiagnostics = defineAsyncComponent(() => import('./components/ViewportDiagnostics.vue'))
const mobile = useMobileLayout()
const { viewport: visibleViewport, style: mobileViewportStyle } = useMobileViewport(mobile)
const sidebarOpen = ref(false)
const focusViewportElement = ref<HTMLElement>()
let cameraObserver: ResizeObserver | undefined
let cameraFrame: CanvasFrame | undefined
let cameraResize = 0
const ready = ref(false)
const authenticated = ref(false)
const checkingInstance = ref(false)
const instanceUnavailable = ref(invalidInstanceLink)
const instanceSetupMessage = ref(invalidInstanceLink ? 'instances.invalidUrl' : '')
let instanceActivation = 0
let instanceBooted = false
useScreenWakeLock(authenticated)
const username = ref('')
const password = ref('')
const busy = ref(false)
const loginFailure = shallowRef<unknown>()
const loginError = computed(() => {
  const reason = loginFailure.value
  if (!reason) return ''
  if (reason instanceof ApiError && reason.status === 401) return t('common.invalidCredentials')
  if (reason instanceof ApiError && reason.status === 429) return t('common.tooManyAttempts')
  return reason instanceof Error ? reason.message : t('app.loginFailed')
})
const error = ref('')
const success = ref('')
const sources = ref<Source[]>([])
const resources = ref<SourceResource[]>([])
const resourcesFresh = ref(false)
const resourcesLoaded = ref(false)
const pageVisible = ref(!document.hidden)
const freshStatuses = computed(() => resourcesFresh.value && pageVisible.value)
const canvases = ref<Canvas[]>([])
const windowSizes = ref<Record<string, WindowSize>>({})
const overviewBackground = ref<Canvas['background']>(null)
const activeId = ref('overview')
const navigation = useCanvasLocation({ instanceId: activeInstanceId, hasInstance: id => activeInstance.value.id === id || instances.value.some(instance => instance.id === id), selectInstance: selectHashInstance })
const { unknownInstance } = navigation
const indicators = computed(() => canvasIndicators(canvases.value, resources.value, freshStatuses.value))
const nodes = shallowRef<Node[]>([])
const graphKey = ref(0)
const refreshedAt = ref(0)
const refreshedTime = computed(() => refreshedAt.value ? new Date(refreshedAt.value).toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit' }) : '')
const loading = ref(false)
const sourcePanel = ref(false)
const expandedSource = ref('')
const sourceDialog = ref(false)
const sourceDraft = reactive<Source>({ id: '', name: '', transport: 'local', target: '', herdrSession: '', herdrSocket: '', sshIdentityFile: '', sshKnownHostsFile: '' })
const canvasDialog = ref(false)
const backgroundCanvas = ref<Canvas | null>(null)
const settingsDialog = ref(false)
const settings = ref<GlobalSettings | null>(null)
const contentFontStyle = ref<Record<string, string>>({})
const appliedContentFont = ref('')
const fontLoading = ref(false)
let fontSignature = ''
let fontRevision = 0
let fontApplication = Promise.resolve()
const canvasMenu = ref(false)
const canvasMenuElement = ref<HTMLElement>()
const canvasDraft = reactive({ id: '', name: '' })
const dialogError = ref('')
const actionDialog = ref<{ title: string; description: string; label?: string; optional?: boolean; value: string; danger?: boolean; button: string; submit: (value: string) => Promise<void> } | null>(null)
const addDialog = ref(false)
const addTarget = ref('')
const addSearch = ref('')
const selectedWindows = ref<string[]>([])
const windowMenu = ref<{ node: TerminalCanvasNode; name: string } | null>(null)
const scanTarget = shallowRef<{ sourceId: string; spaceId: string; windowId: string; name: string; context: DownloadContext } | null>(null)
const focused = ref<TerminalCanvasNode | null>(null)
const focusedCardId = ref('')
const hasFocus = computed(() => !!focused.value || !!focusedCardId.value)
const creating = reactive(new Set<string>())
const pendingCreatedWindow = shallowRef<{ canvasId: string; sourceId: string; spaceId: string; windowId: string }>()
interface CanvasTabDestination { canvasId: string; anchor: TerminalCanvasNode; focusedId?: string; created?: TerminalCanvasNode }
let createdCameraReady = false
let creationIntent = 0
let lastOverviewInteraction: OverviewInteraction | undefined
function cancelCreatedReveal() { creationIntent++; pendingCreatedWindow.value = undefined }
function creationNavigation(event: Event) {
  if (actionDialog.value && busy.value) return
  const control = event.target instanceof Element ? event.target.closest<HTMLElement>('.overview-create') : null
  if (control?.dataset.sourceId && creating.has(creationId(control.dataset.sourceId, control.dataset.spaceId)) &&
      (event.type === 'pointerdown' || (event instanceof KeyboardEvent && ['Enter', ' '].includes(event.key)))) return
  cancelCreatedReveal()
}
const focusedSize = reactive({ width: mobile.value ? visibleViewport.value.width : window.innerWidth - 32, height: mobile.value ? visibleViewport.value.height : window.innerHeight - 32 })
type WindowGeometry = { ratio: number; insetX: number; insetY: number }
const windowGeometry = reactive(new Map<string, WindowGeometry>())
let geometryFrame = 0
const saveState = ref<'' | 'saving' | 'saved' | 'saveFailed'>('')
let refreshTimer: ReturnType<typeof setInterval>
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
type LayoutPatch = Partial<Pick<CanvasNode, 'x' | 'y' | 'width' | 'height'>>
const pendingLayouts = new Map<string, Map<string, LayoutPatch>>()
type NoteEdit = { canvasId: string; id: string; patch: NotePatch }
const pendingNotes = new Map<string, NoteEdit>()
const savingNotes = new Map<string, NoteEdit>()
const noteTimers = new Map<string, ReturnType<typeof setTimeout>>()
let noteSave: Promise<void> | undefined
let layoutGesture = ''
let latestState: SharedState | undefined
let stateEvents: ReturnType<typeof subscribeState> | undefined
let noticeTimer: ReturnType<typeof setTimeout>
let resourceSignature = ''
let resourceLayoutSignature = ''
let resourceRequest: Promise<void> | undefined
let pendingViewport = ''
let viewportRequest = 0
const currentCanvas = computed(() => canvases.value.find(canvas => canvas.id === activeId.value))
const focusedCard = computed(() => currentCanvas.value?.nodes.find((node): node is NoteCanvasNode | FileCanvasNode => node.id === focusedCardId.value && node.type !== 'terminal'))
const isOverview = computed(() => activeId.value === 'overview')
const overviewPaged = ref(false)
const paging = computed(() => isOverview.value && overviewPaged.value)
const currentPage = shallowRef<OverviewPage>()
// Vertical navigation keeps its intended column even when a short row clamps it.
const preferredPageX = ref<number>()
function selectPage(page: OverviewPage | undefined) {
  currentPage.value = page
  preferredPageX.value = page ? page.x + page.width / 2 : undefined
}
const pages = computed<OverviewPage[]>(() => nodes.value.filter(node => node.type === 'terminal' || node.type === 'create' && node.data.spaceId).map(node => ({
  id: node.type === 'terminal' ? `${node.data.sourceId}/${node.data.windowId}` : node.id, row: node.data.spaceId ? `${node.data.sourceId}/${node.data.spaceId}` : node.id,
  ...node.position, width: node.data.width, height: node.data.height,
})))
const pageLayout = computed(() => paging.value ? JSON.stringify(pages.value) : '')
const pageDirections = computed(() => [
  { direction: 'left', key: 'ArrowLeft', label: t('app.previousWindow'), icon: 'chevron', rotation: 'rotate(180deg)' },
  { direction: 'up', key: 'ArrowUp', label: t('app.previousSpace'), icon: 'down', rotation: 'rotate(180deg)' },
  { direction: 'down', key: 'ArrowDown', label: t('app.nextSpace'), icon: 'down', rotation: '' },
  { direction: 'right', key: 'ArrowRight', label: t('app.nextWindow'), icon: 'chevron', rotation: '' },
] as const)
function pageNeighbor(direction: PageDirection) { return adjacentPage(pages.value, currentPage.value?.id || '', direction, preferredPageX.value) }
async function fitPage(animate = false) {
  resetPagingFeedback()
  const frame = graphSurface.value
  if (!paging.value || focused.value || !frame?.clientWidth || !frame.clientHeight) return
  const initial = currentPage.value ? pages.value : pages.value.filter(page => !page.id.startsWith('create-'))
  const page = retainPage(initial.length ? initial : pages.value, currentPage.value?.id || '', currentPage.value, getViewport(), { width: frame.clientWidth, height: frame.clientHeight })
  if (page?.id !== currentPage.value?.id || preferredPageX.value === undefined) selectPage(page)
  else currentPage.value = page
  if (!page) return
  const duration = animate && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 200 : 0
  const transition = setViewport(pageViewport(page, { width: frame.clientWidth, height: frame.clientHeight }), {
    duration, interpolate: 'linear', ease: value => 1 - (1 - value) ** 3,
  })
  // VueFlow does not resolve an interrupted animation. Only immediate camera
  // writes can be awaited by mode/fullscreen lifecycle code.
  if (!duration) await transition
  if (!pendingViewport) saveViewport()
}
function movePage(direction: PageDirection) {
  if (!paging.value || focused.value) return
  const horizontal = direction === 'left' || direction === 'right'
  if (horizontal || preferredPageX.value === undefined) selectPage(currentPage.value)
  const page = pageNeighbor(direction)
  if (!page) return
  if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.terminal-host')) document.activeElement.blur()
  pendingCreatedWindow.value = undefined
  if (horizontal) selectPage(page)
  else currentPage.value = page
  void fitPage(true)
}
async function togglePaging() {
  resetPagingFeedback()
  preferredPageX.value = undefined
  if (!overviewPaged.value) saveViewport()
  overviewPaged.value = !overviewPaged.value
  await nextTick()
  if (paging.value) await fitPage(true)
  else await restoreViewport()
  saveViewport()
}
function guardPageDrag(event: MouseEvent) {
  if (paging.value && event.button === 1 && !(event.target as Element)?.closest('.terminal-host')) {
    event.preventDefault(); event.stopPropagation()
  }
}
function fitCanvas() { if (paging.value) void fitPage(true); else void fitView({ padding: .14, maxZoom: 1, duration: 200 }) }
async function navigateMinimap({ event, node }: NodeMouseEvent) {
  if (node.type !== 'terminal' || focused.value) return
  event.stopPropagation()
  const canvasId = activeId.value
  resetPagingFeedback()
  cancelCreatedReveal()
  if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.terminal-host')) document.activeElement.blur()
  // Blurring can remove a focus-exempt window from the filtered overview.
  await nextTick()
  if (activeId.value !== canvasId || focused.value) return
  const target = nodes.value.find(item => item.id === node.id && item.type === 'terminal')
  const frame = graphSurface.value
  if (!target || !frame?.clientWidth || !frame.clientHeight) return
  if (paging.value) {
    selectPage(pages.value.find(page => page.id === `${target.data.sourceId}/${target.data.windowId}`))
    void fitPage(true)
  } else {
    void setViewport(pageViewport({ ...target.position, width: target.data.width, height: target.data.height },
      { width: frame.clientWidth, height: frame.clientHeight }),
    { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200, interpolate: 'linear', ease: value => 1 - (1 - value) ** 3 })
  }
}


const overviewSelected = useStorage<ProgramStatus[]>('canvas:overview:statuses', [...overviewStatuses])
const overviewOrder = useStorage<OverviewOrder>('canvas:overview:order', 'native')
const overviewCreation = computed(() => overviewSelected.value.includes('unknown'))
const showMinimap = useStorage('canvas:view:minimap', true)
const showNavigation = useStorage('canvas:view:navigation', true)
const overviewMenuOpen = ref(false)
const overviewFiltered = computed(() => overviewSelected.value.length !== overviewStatuses.length)
const overviewFocused = computed(() => overviewSelected.value.length === overviewFocusStatuses.length && overviewFocusStatuses.every(status => overviewSelected.value.includes(status)))
const overviewChanged = computed(() => overviewFiltered.value || overviewOrder.value !== 'native')
const activeElement = useActiveElement({ triggerOnRemoval: true })
const overviewInteraction = computed<OverviewInteraction | undefined>(() => {
  if (!isOverview.value) return
  if (pendingCreatedWindow.value) return pendingCreatedWindow.value
  if (focused.value) return { sourceId: focused.value.sourceId, windowId: focused.value.windowId }
  const card = activeElement.value?.closest<HTMLElement>('.terminal-card')
  if (card?.dataset.sourceId && card.dataset.windowId) return { sourceId: card.dataset.sourceId, windowId: card.dataset.windowId }
})
const visibleOverview = computed(() => overviewResources(resources.value, overviewSelected.value, overviewOrder.value, overviewInteraction.value))
const visibleOverviewCount = computed(() => visibleOverview.value.reduce((total, source) => total + source.spaces.reduce((sum, space) => sum + space.windows.length, 0), 0))
function resetOverview() { overviewSelected.value = [...overviewStatuses]; overviewOrder.value = 'native' }
const overviewMenu = computed<DropdownMenuItem[][]>(() => [
  [{ type: 'label', label: t('app.status') },
    { type: 'checkbox', label: t('app.allStatuses'), checked: !overviewFiltered.value, onSelect: event => event.preventDefault(), onUpdateChecked: checked => { overviewSelected.value = checked ? [...overviewStatuses] : [] } },
    { type: 'checkbox', label: t('app.focus'), checked: overviewFocused.value, onSelect: event => event.preventDefault(), onUpdateChecked: checked => { overviewSelected.value = checked ? [...overviewFocusStatuses] : [] } },
    ...overviewStatuses.map(status => ({ type: 'checkbox' as const, label: status === 'unknown' ? t('app.other') : statusLabel(status), status, checked: overviewSelected.value.includes(status),
      onSelect: (event: Event) => event.preventDefault(), onUpdateChecked: (checked: boolean) => { overviewSelected.value = checked ? [...overviewSelected.value, status] : overviewSelected.value.filter(value => value !== status) } })),
  ],
  [{ type: 'label', label: t('app.sort') }, ...(['native', 'status'] as const).map(order => ({ type: 'checkbox' as const,
    label: order === 'native' ? t('app.nativeOrder') : t('app.statusOrder'), checked: overviewOrder.value === order, onSelect: (event: Event) => event.preventDefault(), onUpdateChecked: () => { overviewOrder.value = order } })),
  ],
  [{ label: t('app.reset'), disabled: !overviewChanged.value, onSelect: resetOverview }],
])
const currentName = computed(() => isOverview.value ? t('app.overview') : currentCanvas.value?.name || t('app.canvas'))
const allWindows = computed(() => resources.value.flatMap(source => source.spaces.flatMap(space => space.windows.map(window => ({ source, space, window, key: `${source.id}/${space.id}/${window.id}` })))))
const windowCount = computed(() => allWindows.value.length)
const existingAddWindows = computed(() => new Set(canvases.value.find(canvas => canvas.id === addTarget.value)?.nodes.filter(isTerminalNode).map(node => `${node.sourceId}/${node.windowId}`) || []))
const selectedAddWindows = computed(() => allWindows.value.filter(item => selectedWindows.value.includes(item.key) && !existingAddWindows.value.has(`${item.source.id}/${item.window.id}`)))
watch([allWindows, existingAddWindows], () => {
  const next = selectedAddWindows.value.map(item => item.key)
  if (next.length !== selectedWindows.value.length || next.some((key, index) => selectedWindows.value[index] !== key)) selectedWindows.value = next
})
const modalOpen = computed(() => sourceDialog.value || canvasDialog.value || actionDialog.value || addDialog.value || windowMenu.value || backgroundCanvas.value || settingsDialog.value || scanTarget.value)
const { surface: graphSurface, app: appElement, fullscreen: canvasFullscreen, resetPagingFeedback, wheel: canvasWheel, touchStart: canvasTouchStart, touchMove: canvasTouchMove, touchEnd: canvasTouchEnd, touchCancel: canvasTouchCancel, click: canvasClick, toggleFullscreen, exitFullscreen } = useCanvasNavigation({
  getCanvasId: () => `${activeInstance.value.id}/${activeId.value}`, getViewport, setViewport, saveViewport,
  onError: showError,
  blocked: () => overviewMenuOpen.value || !!modalOpen.value || !!directoryRequest.value || !!urlRequest.value || !!downloadPreview.value || hasFocus.value || (mobile.value && (sidebarOpen.value || sourcePanel.value)),
  mobile: () => mobile.value,
  paging: { enabled: () => paging.value, canMove: direction => !!pageNeighbor(direction), move: movePage, recenter: fitPage },
  beforeFullscreen: () => { sourcePanel.value = false; sidebarOpen.value = false; canvasMenu.value = false },
})
const currentBackground = computed(() => isOverview.value ? overviewBackground.value : currentCanvas.value?.background)
const { url: backgroundUrl } = useBackgroundUrl(() => currentBackground.value?.url)
const canvasCounts = computed(() => {
  if (isOverview.value) return overviewFiltered.value
    ? t('app.filteredWindows', { visible: visibleOverviewCount.value, total: windowCount.value })
    : t('app.overviewCount', { connections: t('app.connectionCount', sources.value.length), windows: t('app.windowCount', windowCount.value) })
  const items = currentCanvas.value?.nodes || []
  const notes = items.filter(node => node.type === 'note').length
  const files = items.filter(node => node.type === 'file').length
  const windows = items.filter(isTerminalNode).length
  return [windows && t('app.windowCount', windows), notes && t('app.noteCount', notes), files && t('app.fileCount', files)].filter(Boolean).join(' · ') || t('app.emptyCanvas')
})

function windowHeight(node: Pick<TerminalCanvasNode, 'sourceId' | 'windowId' | 'width' | 'height'>) {
  const geometry = windowGeometry.get(`${node.sourceId}/${node.windowId}`)
  return geometry ? (node.width - geometry.insetX) * geometry.ratio + geometry.insetY : node.height
}
function windowSize(node: Pick<TerminalCanvasNode, 'sourceId' | 'windowId'>): WindowSize {
  return windowSizes.value[`${node.sourceId}/${node.windowId}`] || { width: 480, height: 302 }
}
function recordGeometry(sourceId: string, windowId: string, ratio: number, insetX: number, insetY: number) {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return
  const key = `${sourceId}/${windowId}`
  const previous = windowGeometry.get(key)
  if (previous && Math.abs(previous.ratio - ratio) < .00001 && previous.insetX === insetX && previous.insetY === insetY) return
  windowGeometry.set(key, { ratio, insetX, insetY })
  // This is view geometry only. Opening a canvas never edits its saved layout
  // or changes the shared PTY's rows and columns.
  cancelAnimationFrame(geometryFrame)
  geometryFrame = requestAnimationFrame(() => {
    if (layoutGesture) return
    if (isOverview.value) rebuildNodes()
    else nodes.value = nodes.value.map(node => {
      if (node.type !== 'terminal') return node
      const height = windowHeight(node.data)
      return { ...node, data: { ...node.data, height }, style: { ...node.style, height: `${height}px` } }
    })
    if (pendingCreatedWindow.value) void nextTick().then(() => focusCreatedWindow())
  })
}

function notify(message: string) { success.value = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { success.value = '' }, 3500) }
function showError(reason: unknown) { if (reason instanceof Error && reason.name === 'AbortError') return; error.value = reason instanceof Error ? reason.message : String(reason) }
function requestError(event: Event) { showError((event as CustomEvent).detail) }
function resourceFor(node: TerminalCanvasNode) {
  const source = resources.value.find(item => item.id === node.sourceId)
  const space = source?.spaces.find(item => item.id === node.spaceId)
  const window = space?.windows.find(item => item.id === node.windowId)
  // A window can move to another space while remaining on this canvas.
  const linked = window || source?.spaces.flatMap(item => item.windows).find(item => item.id === node.windowId)
  return { source, space, window: linked }
}
function terminalData(node: TerminalCanvasNode, overview = false): TerminalData {
  const found = resourceFor(node)
  const sourceConfig = sources.value.find(source => source.id === node.sourceId)
  const canvasId = currentCanvas.value?.id
  const spaceId = found.source?.spaces.find(space => space.windows.some(window => window.id === node.windowId))?.id || node.spaceId
  const newTab = canvasId ? {
    pending: () => creating.has(creationId(node.sourceId, spaceId)),
    create: () => windowAction(node, 'create', { canvasId, anchor: { ...node }, focusedId: focused.value?.id }),
  } : undefined
  const visual = windowVisualState(found.source, found.window, freshStatuses.value)
  return { ...node, newTab, status: visual.status, statusFresh: visual.fresh, name: found.window?.name || t('app.closedWindow'), subtitle: `${found.source?.name || sourceConfig?.name || t('app.unknownConnection')} / ${found.space?.name || t('app.space')}`, available: !!found.window && !found.source?.error, sourceOffline: !!found.source?.error, panes: found.window?.panes || [], overview, focus: false, mobile: mobile.value, onAction: terminalAction, onResize: resizeNode, onLayoutStart: layoutStarted, onGeometry: recordGeometry }
}
function terminalFlowNode(node: TerminalCanvasNode, overview = false): Node {
  node = { ...node, ...windowSize(node) }
  node.height = windowHeight(node)
  return { id: node.id, type: 'terminal', position: { x: node.x, y: node.y }, data: terminalData(node, overview), style: { width: `${node.width}px`, height: `${node.height}px` }, draggable: !overview && !mobile.value, selectable: !mobile.value, dragHandle: '.drag-handle' }
}
function noteData(node: NoteCanvasNode, focus = false): NoteData {
  const canvasId = activeId.value
  return { ...node, mobile: mobile.value, focus, onResize: resizeNode, onLayoutStart: layoutStarted,
    onChange: (id, patch) => editNote(canvasId, id, patch), onFlush: () => void flushNotes(canvasId),
    onAction: (action, id) => { if (action === 'remove') removeNote(id); else cardAction(action, id) } }
}
function fileData(node: FileCanvasNode, focus = false): FileData {
  return { ...node, mobile: mobile.value, focus, onResize: resizeNode, onLayoutStart: layoutStarted, onRemove: removeFile, onAction: cardAction }
}
function flowNode(node: CanvasNode): Node {
  if (isTerminalNode(node)) return terminalFlowNode(node)
  if (node.type === 'file') {
    const data = fileData(node)
    return { id: node.id, type: 'file', position: { x: node.x, y: node.y }, data,
      style: { width: `${node.width}px`, height: `${node.height}px` },
      draggable: !mobile.value, selectable: !mobile.value, dragHandle: '.drag-handle' }
  }
  const data = noteData(node)
  return { id: node.id, type: 'note', position: { x: node.x, y: node.y }, data,
    style: { width: `${node.width}px`, height: `${node.minimized ? 30 : node.height}px` },
    draggable: !mobile.value, selectable: !mobile.value, dragHandle: '.drag-handle' }
}
function creationId(sourceId: string, spaceId?: string) { return spaceId ? `create-tab:${sourceId}:${spaceId}` : `create-space:${sourceId}` }
function overviewCreateNode(source: SourceResource, spaceId: string | undefined, x: number, y: number, width: number, height: number): Node {
  const id = creationId(source.id, spaceId)
  return { id, type: 'create', position: { x, y }, draggable: false, selectable: false,
    style: { width: `${width}px`, height: `${height}px` },
    data: { sourceId: source.id, spaceId, width, height,
      context: [source.name, source.spaces.find(space => space.id === spaceId)?.name].filter(Boolean).join(' / '),
      available: !source.error && !['offline', 'error', 'disconnected'].includes(source.status), pending: () => creating.has(id),
      create: () => spaceId ? createTab(source.id, spaceId) : void createResource(source.id).catch(showError) } }
}
function overviewNodes(): Node[] {
  const result: Node[] = []
  let y = 0
  for (const config of sources.value) {
    const source = resources.value.find(item => item.id === config.id)
    if (!source) continue
    const visible = visibleOverview.value.find(item => item.id === config.id)
    const rows = source.spaces.flatMap(space => {
      const windows = visible?.spaces.find(item => item.id === space.id)?.windows || []
      if (!windows.length && !overviewCreation.value) return []
      const last = windows.at(-1)
      const cardWidth = last ? windowSize({ sourceId: source.id, windowId: last.id }).width : 480
      const cardHeight = windows.length ? Math.max(...windows.map(window => windowHeight({ sourceId: source.id, windowId: window.id, ...windowSize({ sourceId: source.id, windowId: window.id }) }))) : 302
      return [{ space: { ...space, windows }, cardWidth, cardHeight, height: 54 + cardHeight }]
    })
    if (!rows.length && !overviewCreation.value) continue
    const width = Math.max(528, ...rows.map(row => 32 + (overviewCreation.value ? row.cardWidth + 16 : 0) + row.space.windows.reduce((sum, window) => sum + windowSize({ sourceId: source.id, windowId: window.id }).width + 16, 0)))
    const count = rows.reduce((sum, row) => sum + row.space.windows.length, 0)
    const height = (overviewCreation.value ? 132 : 78) + rows.reduce((sum, row) => sum + row.height, 0)
    result.push({ id: `source:${source.id}`, type: 'group', position: { x: 0, y }, data: { kind: 'source', name: config.name, subtitle: config.transport === 'local' ? t('app.local') : 'SSH', count, width, height }, draggable: false, selectable: false, style: { width: `${width}px`, height: `${height}px`, zIndex: '-1', pointerEvents: 'none' } })
    let rowY = y + 68
    for (const { space, height: rowHeight, cardWidth, cardHeight } of rows) {
      result.push({ id: `space:${source.id}:${space.id}`, type: 'group', position: { x: 24, y: rowY }, data: { kind: 'space', name: space.name, count: space.windows.length }, draggable: false, selectable: false, style: { width: `${width - 48}px`, pointerEvents: 'none' } })
      let windowX = 24
      for (const window of space.windows) {
        const target = { sourceId: source.id, windowId: window.id }
        result.push(terminalFlowNode({ type: 'terminal', id: `window:${source.id}:${space.id}:${window.id}`, ...target, spaceId: space.id, x: windowX, y: rowY + 34, ...windowSize(target) }, true))
        windowX += windowSize(target).width + 16
      }
      if (overviewCreation.value) result.push(overviewCreateNode(source, space.id, windowX, rowY + 34, cardWidth, cardHeight))
      rowY += rowHeight
    }
    if (overviewCreation.value) result.push(overviewCreateNode(source, undefined, 24, rowY + 4, width - 48, 32))
    y += height + 48
  }
  return result
}
// VueFlow has no locale API; its public attributes and live-message state
// let Canvas describe the existing keyboard behavior without replacing it.
function accessibleNode<T extends Node>(node: T): T {
  const card = ['terminal', 'note', 'file'].includes(node.type || '')
  return { ...node, domAttributes: { ...node.domAttributes,
    'aria-roledescription': card ? t('app.card') : undefined,
    'aria-describedby': card && node.selectable !== false ? node.draggable ? 'canvas-card-move-help' : 'canvas-card-select-help' : undefined,
  } }
}
function announceNodeMove(changes: NodeChange[]) {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !graphSurface.value?.contains(active) ||
      !active.matches('.vue-flow__node, .vue-flow__nodesselection-rect')) return
  const moved = changes.filter((change): change is NodePositionChange => change.type === 'position' &&
    change.dragging === false && !!change.position && !!change.from &&
    (change.position.x !== change.from.x || change.position.y !== change.from.y))
  const change = active.matches('.vue-flow__nodesselection-rect') ? moved[0] : moved.find(item => item.id === active.dataset.id)
  if (!change) return
  if (moved.length > 1) { ariaLiveMessage.value = t('app.cardsMoved', moved.length); return }
  const node = nodes.value.find(item => item.id === change.id)
  const name = node?.type === 'terminal' ? node.data.name : node?.type === 'note' ? node.data.title || t('app.note') : node?.data.asset?.filename || t('app.card')
  ariaLiveMessage.value = t('app.cardMoved', { name, x: n(Math.round(change.position.x)), y: n(Math.round(change.position.y)) })
}
function rebuildNodes() {
  const previous = new Map(nodes.value.map(node => [node.id, node as Node & { selected?: boolean }]))
  nodes.value = (isOverview.value ? overviewNodes() : (currentCanvas.value?.nodes || []).map(flowNode)).map(node => accessibleNode({ ...node, selected: previous.get(node.id)?.selected }))
}
function applySettings(value: GlobalSettings) {
  settings.value = value
  const signature = JSON.stringify(value.contentFont)
  if (signature === fontSignature) return
  fontSignature = signature
  const revision = ++fontRevision
  const config = { ...value.contentFont, stack: value.contentFont.stack.map(entry => ({ ...entry })) }
  fontLoading.value = true
  fontApplication = (async () => {
    try {
      await ensureContentFont(config)
      if (revision !== fontRevision) return
      const presentation = buildFontPresentation(config)
      contentFontStyle.value = { '--content-font-family': presentation.family, '--content-font-features': presentation.features }
      appliedContentFont.value = config.stack[0]?.family || ''
      setContentFont(config, presentation)
    } catch (reason) {
      if (revision === fontRevision) { fontSignature = ''; showError(reason) }
    } finally { if (revision === fontRevision) fontLoading.value = false }
  })()
}
function applySharedState(state: SharedState) {
  if (latestState?.instanceId === state.instanceId && state.revision < latestState.revision) return
  latestState = state
  retainBackgrounds([state.overviewBackground, ...state.canvases.map(canvas => canvas.background)].flatMap(background => background ? [background.url] : []))
  applySettings(state.settings)
  const sourceChanged = JSON.stringify(sources.value) !== JSON.stringify(state.sources)
  const previousNodes = JSON.stringify(currentCanvas.value?.nodes)
  const nextSizes = { ...state.windowSizes }
  for (const canvas of state.canvases) for (const [id, patch] of pendingLayouts.get(canvas.id) || []) {
    const node = canvas.nodes.find(item => item.id === id)
    if (node && isTerminalNode(node) && (patch.width !== undefined || patch.height !== undefined)) {
      const key = `${node.sourceId}/${node.windowId}`
      nextSizes[key] = { ...(nextSizes[key] || windowSize(node)),
        ...(patch.width === undefined ? {} : { width: patch.width }),
        ...(patch.height === undefined ? {} : { height: patch.height }) }
    }
  }
  const sizesChanged = JSON.stringify(windowSizes.value) !== JSON.stringify(nextSizes)
  windowSizes.value = nextSizes
  sources.value = state.sources
  overviewBackground.value = state.overviewBackground
  canvases.value = state.canvases.map(canvas => ({ ...canvas, nodes: (canvas.nodes || []).map(node => ({ ...node, ...pendingLayouts.get(canvas.id)?.get(node.id), ...(node.type === 'note' ? { ...savingNotes.get(noteKey(canvas.id, node.id))?.patch, ...pendingNotes.get(noteKey(canvas.id, node.id))?.patch } : {}) })) }))
  for (const [id, timer] of saveTimers) if (!canvases.value.some(canvas => canvas.id === id)) { clearTimeout(timer); saveTimers.delete(id); pendingLayouts.delete(id) }
  for (const id of pendingLayouts.keys()) if (!canvases.value.some(canvas => canvas.id === id)) pendingLayouts.delete(id)
  for (const edit of [...pendingNotes.values(), ...savingNotes.values()]) if (!canvases.value.find(canvas => canvas.id === edit.canvasId)?.nodes.some(node => node.id === edit.id)) clearNoteEdits(edit.canvasId, edit.id)
  if (!isOverview.value && !currentCanvas.value) navigation.fallback(activeInstance.value.id)
  else {
    if (!isOverview.value && focused.value && !currentCanvas.value?.nodes.some(node => node.id === focused.value?.id)) void closeFocus()
    if (!layoutGesture && (sizesChanged || previousNodes !== JSON.stringify(currentCanvas.value?.nodes))) rebuildNodes()
  }
  if (backgroundCanvas.value && backgroundCanvas.value.id !== 'overview' && !canvases.value.some(canvas => canvas.id === backgroundCanvas.value?.id)) backgroundCanvas.value = null
  if (sourceChanged) {
    resourcesFresh.value = false
    resources.value = resources.value.filter(resource => sources.value.some(source => source.id === resource.id))
    if (focused.value && !sources.value.some(source => source.id === focused.value?.sourceId)) focused.value = null
    resourceSignature = ''; resourceLayoutSignature = ''
    if (isOverview.value && !layoutGesture) rebuildNodes()
    void refreshResources(true)
  }
}
async function syncState() {
  const previous = latestState
  const state = await api<SharedState>('/api/state')
  if (latestState !== previous && latestState?.instanceId !== state.instanceId) return
  applySharedState(state)
}
function stopStateEvents() { stateEvents?.close(); stateEvents = undefined }
function startStateEvents() {
  stopStateEvents()
  stateEvents = subscribeState(state => applySharedState(state as SharedState))
}

function currentLocation(): CanvasLocation {
  const frame = graphSurface.value
  const bounds = frame ? { width: frame.clientWidth, height: frame.clientHeight } : undefined
  const viewport = bounds && paging.value && currentPage.value ? pageViewport(currentPage.value, bounds) : getViewport()
  const camera = bounds && !hasFocus.value ? cameraFromViewport(viewport, bounds) : navigation.saved(activeInstance.value.id, activeId.value)?.camera
  return { instance: activeInstance.value.id, canvas: activeId.value, ...(camera ? { camera } : {}),
    ...(paging.value ? { view: 'paged' as const, ...(currentPage.value ? { page: currentPage.value.id } : {}) } : {}) }
}
function rememberCurrentLocation() {
  const location = currentLocation()
  if (hasFocus.value) return
  rememberCanvasLocation(localStorage, location)
  return location
}
async function selectHashInstance(id: string) {
  if (!instanceBooted) { selectInstance(id); return }
  const actual = currentLocation()
  if (!await flushInstanceEdits()) { navigation.cancel(actual); return }
  if (navigation.requested.value?.location.instance !== id) return
  rememberCurrentLocation()
  selectInstance(id)
}
async function applyRequestedLocation() {
  const requested = navigation.requested.value
  if (!requested || unknownInstance.value || requested.location.instance !== activeInstance.value.id || !authenticated.value || !latestState || !resourcesLoaded.value) return
  const location = resolveCanvasLocation(requested.location, canvases.value.map(canvas => canvas.id))
  focused.value = null; focusedCardId.value = ''
  if (activeId.value !== location.canvas) {
    activeId.value = location.canvas
    overviewPaged.value = location.view === 'paged'
    currentPage.value = undefined
    return
  }
  overviewPaged.value = location.view === 'paged'
  currentPage.value = undefined
  await restoreViewport()
}
async function restoreViewport() {
  if (!authenticated.value || !resourcesLoaded.value || unknownInstance.value) return
  const id = activeId.value, instance = activeInstance.value.id
  const requested = navigation.requested.value
  const request = ++viewportRequest
  pendingViewport = id
  await nextTick()
  if (request !== viewportRequest || id !== activeId.value || instance !== activeInstance.value.id || requested !== navigation.requested.value) return
  const frame = graphSurface.value
  if (!frame?.clientWidth || !frame.clientHeight) return
  const initialized = new Set(getNodesInitialized.value.map(node => node.id))
  if (nodes.value.some(node => !initialized.has(node.id))) return
  if (requested && (requested.location.instance !== instance || requested.location.canvas !== id && canvases.value.some(canvas => canvas.id === requested.location.canvas))) return
  const saved = requested ? resolveCanvasLocation(requested.location, canvases.value.map(canvas => canvas.id))
    : (overviewPaged.value ? navigation.saved(instance, id) : recallFreeCanvasLocation(localStorage, instance, id))
  if (requested && saved) overviewPaged.value = saved.view === 'paged'
  if (paging.value) {
    if (requested && saved) selectPage(restoreCanvasPage(saved, pages.value, { width: frame.clientWidth, height: frame.clientHeight }))
    await fitPage()
  } else {
    const viewport = saved?.camera ? viewportFromCamera(saved.camera, { width: frame.clientWidth, height: frame.clientHeight }) : undefined
    if (viewport) await setViewport(viewport)
    else if (nodes.value.length) await fitView({ padding: .14, maxZoom: 1, duration: 0 })
    else await setViewport({ x: frame.clientWidth / 2, y: frame.clientHeight / 2, zoom: 1 })
  }
  if (request !== viewportRequest || id !== activeId.value || instance !== activeInstance.value.id) return
  pendingViewport = ''
  cameraFrame = canvasFrame(frame)
  navigation.restored(requested, currentLocation())
}
let pendingNoteFocus = ''
function focusNewNote(attempt = 0) {
  if (!pendingNoteFocus) return
  if (!currentCanvas.value?.nodes.some(node => node.id === pendingNoteFocus)) { pendingNoteFocus = ''; return }
  const editor = document.querySelector<HTMLTextAreaElement>(`[data-note-id="${pendingNoteFocus}"] textarea`)
  if (editor?.checkVisibility()) {
    editor.focus()
    if (document.activeElement === editor) { pendingNoteFocus = ''; return }
  }
  if (attempt < 30) requestAnimationFrame(() => focusNewNote(attempt + 1))
}
function focusCreatedWindow(attempt = 0, target = pendingCreatedWindow.value) {
  if (!target || target !== pendingCreatedWindow.value || target.canvasId !== activeId.value || !createdCameraReady) return
  const maximized = focused.value?.sourceId === target.sourceId && focused.value.windowId === target.windowId
  if (!modalOpen.value && (maximized || windowGeometry.has(`${target.sourceId}/${target.windowId}`))) {
    if (!maximized) {
      const page = pages.value.find(page => page.id === `${target.sourceId}/${target.windowId}`)
      if (!page || Math.abs(page.height - windowHeight({ ...target, ...windowSize(target) })) > .02) {
        if (attempt < 30) requestAnimationFrame(() => focusCreatedWindow(attempt + 1, target))
        return
      }
      if (!paging.value && graphSurface.value) {
        void setViewport(pageViewport(page, { width: graphSurface.value.clientWidth, height: graphSurface.value.clientHeight }))
      }
    }
    const card = document.querySelector<HTMLElement>(`[data-source-id="${target.sourceId}"][data-window-id="${target.windowId}"].terminal-card`)
    if (card?.checkVisibility() && (mobile.value || focusWindow(target.sourceId, target.spaceId, target.windowId))) {
      if (mobile.value) card.focus({ preventScroll: true })
      void nextTick().then(() => {
        if (pendingCreatedWindow.value !== target) return
        if (card.contains(document.activeElement)) pendingCreatedWindow.value = undefined
        else if (attempt < 30) requestAnimationFrame(() => focusCreatedWindow(attempt + 1, target))
      })
      return
    }
  }
  if (attempt < 30) requestAnimationFrame(() => focusCreatedWindow(attempt + 1, target))
}
function nodesInitialized() {
  if (pendingViewport === activeId.value) void restoreViewport()
  // VueFlow mounts new node components after its own node-store update.
  // Waiting for that mount keeps focus from falling back to the document body.
  void nextTick().then(() => { focusNewNote(); focusCreatedWindow() })
}
function saveViewport() {
  if (pendingViewport || hasFocus.value || !authenticated.value || !resourcesLoaded.value) return
  const frame = canvasFrame(graphSurface.value)
  if (mobile.value && (!frame || cameraFrame && Math.abs(cameraFrame.layoutWidth - frame.layoutWidth) >= 1)) {
    queueCameraResize(); return
  }
  if (frame) cameraFrame = frame
  navigation.save(currentLocation())
}

async function refreshResources(silent = false): Promise<void> {
  if (resourceRequest) {
    if (silent) return
    await resourceRequest
    return refreshResources()
  }
  if (!authenticated.value || unknownInstance.value) return
  loading.value = !silent
  const context = apiContext()
  const sourceConfiguration = JSON.stringify(sources.value)
  resourceRequest = (async () => {
    try {
      const body = await api<{ sources: SourceResource[] }>('/api/resources')
      if (sourceConfiguration !== JSON.stringify(sources.value)) return
      body.sources = body.sources.map(source => source.error ? {
        ...source, spaces: (resources.value.find(previous => previous.id === source.id)?.spaces || []).flatMap(space => {
          const windows = space.windows.filter(window => hasLiveTerminal(source.id, window.id))
          return windows.length ? [{ ...space, windows }] : []
        }),
      } : source)
      const freshnessChanged = !resourcesFresh.value
      resourcesFresh.value = true; resourcesLoaded.value = true
      const signature = JSON.stringify(body.sources)
      if (signature !== resourceSignature || freshnessChanged) {
        const layoutSignature = JSON.stringify(body.sources.map(source => {
          const config = sources.value.find(item => item.id === source.id)
          return [source.id, config?.transport, config?.target, source.spaces.map(space => [space.id, space.windows.map(window => window.id)])]
        }))
        const overviewChanged = isOverview.value && overviewLayoutKey(visibleOverview.value) !== overviewLayoutKey(overviewResources(body.sources, overviewSelected.value, overviewOrder.value, overviewInteraction.value))
        resources.value = body.sources
        resourceSignature = signature
        if (layoutSignature !== resourceLayoutSignature || overviewChanged) { if (!layoutGesture) rebuildNodes() }
        else {
          // Status updates must preserve the current drag, selection and card geometry.
          const updated = new Map((isOverview.value ? overviewNodes() : (currentCanvas.value?.nodes || []).map(flowNode)).map(node => [node.id, node.data]))
          nodes.value = nodes.value.map(node => ({ ...node, data: updated.get(node.id) || node.data }))
        }
        resourceLayoutSignature = layoutSignature
      }
      refreshedAt.value = Date.now()
    } catch (reason) {
      if (isCurrentApi(context)) {
        resourcesFresh.value = false; resourcesLoaded.value = true
        if (!silent) showError(reason)
      }
    }
    finally {
      if (isCurrentApi(context)) {
        loading.value = false; resourceRequest = undefined
        if (sourceConfiguration !== JSON.stringify(sources.value)) void refreshResources(true)
      }
    }
  })()
  return resourceRequest
}
async function load() {
  const context = apiContext()
  await syncState()
  await fontApplication
  requireCurrentApi(context)
  await refreshResources()
  requireCurrentApi(context)
  rebuildNodes()
  if (navigation.requested.value) await applyRequestedLocation()
  else await restoreViewport()
  requireCurrentApi(context)
  startStateEvents()
}
async function login() {
  const context = apiContext()
  busy.value = true; loginFailure.value = undefined
  try {
    const session = await api<{ token: string }>('/api/login', { method: 'POST', body: JSON.stringify({ username: username.value, password: password.value }) }, context)
    requireCurrentApi(context)
    setSessionToken(session.token); password.value = ''; authenticated.value = true
    await load()
  } catch (reason) { if (context.id === activeInstance.value.id && !(reason instanceof Error && reason.name === 'AbortError')) loginFailure.value = reason }
  finally { if (context.id === activeInstance.value.id) busy.value = false }
}
async function flushInstanceEdits() {
  if (!authenticated.value) return true
  const context = apiContext()
  await flushNotes()
  if (!isCurrentApi(context) || pendingNotes.size || savingNotes.size) return false
  try {
    for (const [canvasId, patches] of pendingLayouts) {
      clearTimeout(saveTimers.get(canvasId)); saveTimers.delete(canvasId)
      await api(`/api/canvases/${segment(canvasId)}/layout`, { method: 'PATCH', body: JSON.stringify({ nodes: [...patches].map(([id, patch]) => ({ id, ...patch })) }) }, context)
      pendingLayouts.delete(canvasId)
    }
    return true
  } catch (reason) { showError(reason); return false }
}
async function beforeInstanceChange() {
  if (!await flushInstanceEdits()) return false
  rememberCurrentLocation()
  return true
}
async function logout() {
  if (!await flushInstanceEdits()) return
  const context = apiContext()
  await exitFullscreen()
  requireCurrentApi(context)
  await write('/api/logout', 'POST'); unauthorized()
}
function clearInstanceRuntime() {
  stopStateEvents(); resetApiRequests(); clearTerminals(); hideMobileKeyboard(); void exitFullscreen()
  for (const timer of saveTimers.values()) clearTimeout(timer)
  saveTimers.clear(); pendingLayouts.clear(); clearNoteEdits(); noteSave = undefined
  authenticated.value = false; focused.value = null; focusedCardId.value = ''; scanTarget.value = null
  sourceDialog.value = false; sourcePanel.value = false; canvasDialog.value = false; actionDialog.value = null
  addDialog.value = false; windowMenu.value = null; backgroundCanvas.value = null; settingsDialog.value = false
  sidebarOpen.value = false; overviewMenuOpen.value = false; canvasMenu.value = false
  settings.value = null; fontRevision++; fontSignature = ''; fontLoading.value = false; latestState = undefined
  sources.value = []; resources.value = []; canvases.value = []; nodes.value = []; windowSizes.value = {}
  resourcesFresh.value = false; resourcesLoaded.value = false
  overviewBackground.value = null; windowGeometry.clear(); resourceSignature = ''; resourceLayoutSignature = ''; resourceRequest = undefined
  currentPage.value = undefined; overviewPaged.value = false; preferredPageX.value = undefined
  pendingViewport = ''; viewportRequest++; cancelCreatedReveal(); lastOverviewInteraction = undefined
  layoutGesture = ''; saveState.value = ''; activeId.value = 'overview'; graphKey.value++
  refreshedAt.value = 0; loading.value = false; error.value = ''; success.value = ''; busy.value = false
  username.value = ''; password.value = ''; loginFailure.value = undefined
}
function visibilityChanged() {
  pageVisible.value = !document.hidden
  if (!document.hidden) { resourcesFresh.value = false; void refreshResources(true) }
}
function unauthorized() { setSessionToken(''); clearInstanceRuntime(); checkingInstance.value = false; void exitFullscreen() }
async function activateInstance() {
  const activation = ++instanceActivation
  clearInstanceRuntime(); ready.value = true; checkingInstance.value = true; instanceUnavailable.value = false; instanceSetupMessage.value = ''
  const context = apiContext()
  try {
    const session = await api<{ authenticated: boolean; username?: string }>('/api/session', { signal: AbortSignal.timeout(15_000) }, context)
    requireCurrentApi(context)
    if (!isCanvasSession(session)) throw new Error('Invalid Canvas session')
    rememberInstance()
    if (!session.authenticated && context.token) setSessionToken('')
    authenticated.value = session.authenticated; username.value = session.username || ''
    if (authenticated.value) await load()
  } catch (reason) {
    if (activation === instanceActivation && isCurrentApi(context)) {
      if (!authenticated.value) { instanceUnavailable.value = true; instanceSetupMessage.value = instances.value.length ? 'instances.unavailable' : '' }
      else loginFailure.value = reason
    }
  } finally { if (activation === instanceActivation) checkingInstance.value = false }
}
function connectInstance() { if (!checkingInstance.value) void activateInstance() }
function sessionChanged() {
  if (authenticated.value) { rememberCurrentLocation(); navigation.visit(activeInstance.value.id, activeId.value) }
  void activateInstance()
}
watch(() => `${activeInstance.value.id}:${activeInstance.value.base}`, () => {
  if (!instanceBooted) return
  if (navigation.requested.value?.location.instance !== activeInstance.value.id) navigation.visit(activeInstance.value.id, 'overview')
  void activateInstance()
}, { flush: 'sync' })

watch(locale, () => {
  ariaLiveMessage.value = ''
  nodes.value = nodes.value.map(node => {
    if (node.type === 'terminal') return accessibleNode({ ...node, data: terminalData(node.data, isOverview.value) })
    if (node.type === 'group' && node.data.kind === 'source') {
      const source = sources.value.find(source => `source:${source.id}` === node.id)
      return accessibleNode({ ...node, data: { ...node.data, subtitle: source?.transport === 'local' ? t('app.local') : 'SSH' } })
    }
    return accessibleNode(node)
  })
  if (backgroundCanvas.value?.id === 'overview') backgroundCanvas.value = { ...backgroundCanvas.value, name: t('app.overview') }
})
watch([navigation.requested, resourcesLoaded], () => { void applyRequestedLocation() })
watchDebounced(getViewport, saveViewport, { debounce: 160 })
watch(unknownInstance, async value => {
  if (!value) return
  const actual = currentLocation()
  if (!await flushInstanceEdits()) { navigation.cancel(actual); return }
  if (unknownInstance.value !== value) return
  clearInstanceRuntime(); checkingInstance.value = false; ready.value = true
})
watch(freshStatuses, () => {
  nodes.value = nodes.value.map(node => node.type === 'terminal' ? { ...node, data: terminalData(node.data, isOverview.value) } : node)
})
watch(pageLayout, async () => { if (paging.value) { await nextTick(); await fitPage() } })
watch(overviewInteraction, value => { if (value) lastOverviewInteraction = value; if (isOverview.value) rebuildNodes() })
watch([overviewSelected, overviewOrder], async () => { preferredPageX.value = undefined; if (isOverview.value) { rebuildNodes(); await nextTick(); if (paging.value) await fitPage(); else void fitView({ padding: .14, maxZoom: 1, duration: 150 }) } })
watch(activeId, async () => { if (!authenticated.value) return; scanTarget.value = null; preferredPageX.value = undefined; cancelCreatedReveal(); lastOverviewInteraction = undefined; overviewMenuOpen.value = false; layoutGesture = ''; focused.value = null; focusedCardId.value = ''; canvasMenu.value = false; saveState.value = ''; rebuildNodes(); await restoreViewport() })
function switchCanvas(id: string) {
  sidebarOpen.value = false
  if (id === activeId.value && !unknownInstance.value && !navigation.requested.value) return
  void flushNotes(activeId.value); saveViewport(); navigation.visit(activeInstance.value.id, id)
}
function backgroundSaved(_updated: Canvas) { void syncState().catch(showError) }
function openSettings() { sidebarOpen.value = false; canvasMenu.value = false; sourcePanel.value = false; settingsDialog.value = true }
function settingsSaved(_settings: GlobalSettings) { void syncState().catch(showError) }
function openBackground() { canvasMenu.value = false; backgroundCanvas.value = isOverview.value ? { id: 'overview', name: t('app.overview'), nodes: [], background: overviewBackground.value } : currentCanvas.value || null }
function closeBackgroundDialog() {
  backgroundCanvas.value = null
  void nextTick(() => canvasMenuElement.value?.querySelector<HTMLButtonElement>('.canvas-menu-trigger')?.focus())
}
function outsideCanvasMenu(event: PointerEvent) { if (!canvasMenuElement.value?.contains(event.target as HTMLElement)) canvasMenu.value = false }
async function toggleCanvasMenu() {
  canvasMenu.value = !canvasMenu.value
  if (canvasMenu.value) { await nextTick(); canvasMenuElement.value?.querySelector<HTMLButtonElement>('.canvas-menu button')?.focus() }
}
function openCanvasDialog(canvas?: Canvas) { sidebarOpen.value = false; canvasDraft.id = canvas?.id || ''; canvasDraft.name = canvas?.name || ''; dialogError.value = ''; canvasDialog.value = true }
async function submitCanvas() {
  if (!canvasDraft.name.trim()) return
  busy.value = true; dialogError.value = ''
  try {
    if (canvasDraft.id) {
      await write(`/api/canvases/${segment(canvasDraft.id)}`, 'PATCH', { name: canvasDraft.name.trim() })
      await syncState()
    } else {
      const canvas = await write<Canvas>('/api/canvases', 'POST', { name: canvasDraft.name.trim(), nodes: [] })
      await syncState(); switchCanvas(canvas.id)
    }
    canvasDialog.value = false
  } catch (reason) { dialogError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
function deleteCanvas() {
  const canvas = currentCanvas.value
  if (!canvas) return
  actionDialog.value = { get title() { return t('app.deleteNamed', { name: canvas.name }) }, get description() { return t('app.deleteCanvasDescription') }, value: '', danger: true, get button() { return t('app.deleteCanvas') }, submit: async () => { clearTimeout(saveTimers.get(canvas.id)); saveTimers.delete(canvas.id); pendingLayouts.delete(canvas.id); clearNoteEdits(canvas.id); await write(`/api/canvases/${segment(canvas.id)}`, 'DELETE'); await syncState(); switchCanvas('overview') } }
}
function openSource(source?: Source) {
  sidebarOpen.value = false
  Object.assign(sourceDraft, { id: '', name: '', transport: 'local', target: '', herdrSession: '', herdrSocket: '', sshIdentityFile: '', sshKnownHostsFile: '' }, source || {})
  dialogError.value = ''; sourceDialog.value = true
}
async function submitSource() {
  busy.value = true; dialogError.value = ''
  try {
    const body = { ...sourceDraft, name: sourceDraft.name.trim(), target: sourceDraft.target?.trim() }
    body.herdrSession = body.herdrSession?.trim() || ''
    body.herdrSocket = body.herdrSocket?.trim() || ''
    if (body.transport === 'ssh' && !body.target) throw new Error(t('app.sshRequired'))
    if (body.id) {
      await write<Source>(`/api/sources/${segment(body.id)}`, 'PATCH', body)
    } else { const { id, ...newSource } = body; await write<Source>('/api/sources', 'POST', newSource) }
    await syncState()
    sourceDialog.value = false; resourceSignature = ''; await refreshResources(); await restoreViewport(); notify(t('app.connectionSaved'))
  } catch (reason) { dialogError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
function deleteSource(source: Source) {
  actionDialog.value = { get title() { return t('app.removeNamed', { name: source.name }) }, get description() { return t('app.removeConnectionDescription') }, value: '', danger: true, get button() { return t('app.removeConnection') }, submit: async () => { await write(`/api/sources/${segment(source.id)}`, 'DELETE'); await syncState(); await refreshResources() } }
}
function basePath(sourceId: string) { return `/api/sources/${segment(sourceId)}` }
async function createResource(sourceId: string, spaceId?: string, name?: string, destination?: CanvasTabDestination) {
  const id = creationId(sourceId, spaceId)
  if (creating.has(id)) return
  creating.add(id)
  cancelCreatedReveal()
  const intent = creationIntent
  const origin = destination?.canvasId || activeId.value, pageBefore = currentPage.value?.id
  const context = overviewInteraction.value || lastOverviewInteraction
  const reference = context?.sourceId === sourceId ? context.windowId : nodes.value.find(node => `${node.data.sourceId}/${node.data.windowId}` === currentPage.value?.id && node.data.sourceId === sourceId)?.data.windowId
  const sourceSpaceId = reference ? resources.value.find(source => source.id === sourceId)?.spaces.find(space => space.windows.some(window => window.id === reference))?.id : undefined
  try {
    const created = destination?.created || await write<{ spaceId: string; windowId: string }>(`${basePath(sourceId)}/spaces${spaceId ? `/${segment(spaceId)}/windows` : ''}`, 'POST', { ...(name?.trim() ? { name: name.trim() } : {}), ...(!spaceId && sourceSpaceId ? { sourceSpaceId } : {}) })
    if (destination) {
      if (!destination.created) {
        const { anchor } = destination
        let x = anchor.x + anchor.width + 24
        const occupied = canvases.value.find(canvas => canvas.id === origin)?.nodes || []
        for (const node of [...occupied].sort((a, b) => a.x - b.x)) {
          if (node.y < anchor.y + anchor.height && node.y + node.height > anchor.y && node.x < x + anchor.width + 24 && node.x + node.width + 24 > x) x = node.x + node.width + 24
        }
        // Retain the native result so retrying a failed canvas write cannot create another tab.
        destination.created = { type: 'terminal', id: uuid(), sourceId, spaceId: created.spaceId, windowId: created.windowId,
          x, y: anchor.y, width: anchor.width, height: anchor.height }
      }
      await write(`/api/canvases/${segment(origin)}/nodes`, 'POST', { nodes: [destination.created] })
      await syncState()
    }
    const target = { canvasId: origin, sourceId, spaceId: created.spaceId, windowId: created.windowId }
    const reveal = () => intent === creationIntent && origin === activeId.value &&
      (destination ? focused.value?.id === destination.focusedId : origin === 'overview' && currentPage.value?.id === pageBefore && !focused.value)
    if (reveal()) { createdCameraReady = false; pendingCreatedWindow.value = target }
    await refreshResources()
    if (!reveal() || pendingCreatedWindow.value !== target) return
    rebuildNodes()
    if (destination?.focusedId && destination.created) focused.value = destination.created
    await nextTick()
    const page = pages.value.find(page => page.id === `${sourceId}/${created.windowId}`)
    if (!focused.value && page && graphSurface.value) {
      if (isOverview.value) selectPage(page)
      if (paging.value) await fitPage(true)
      else void setViewport(pageViewport(page, { width: graphSurface.value.clientWidth, height: graphSurface.value.clientHeight }), { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200, interpolate: 'linear' })
    }
    createdCameraReady = true
    focusCreatedWindow()
  } finally { creating.delete(id) }
}
function createTab(sourceId: string, spaceId: string, destination?: CanvasTabDestination) {
  if (creating.has(creationId(sourceId, spaceId))) return
  const source = resources.value.find(item => item.id === sourceId)
  actionDialog.value = { get title() { return t('app.newTab') }, description: [source?.name, source?.spaces.find(space => space.id === spaceId)?.name].filter(Boolean).join(' / '), get label() { return t('app.name') }, optional: true, value: '', get button() { return t('app.newTab') }, submit: name => createResource(sourceId, spaceId, name, destination) }
}
function spaceAction(source: SourceResource, spaceId: string | undefined, operation: 'create' | 'rename' | 'close') {
  if (operation === 'create') { void createResource(source.id).catch(showError); return }
  const space = source.spaces.find(item => item.id === spaceId)
  actionDialog.value = { get title() { return t(operation === 'rename' ? 'app.renameSpace' : 'app.closeSpace') }, get description() { return operation === 'close' ? t('app.closeSpaceDescription', { name: space?.name || '' }) : source.name }, get label() { return operation === 'close' ? undefined : t('app.name') }, value: operation === 'rename' ? space?.name || '' : '', danger: operation === 'close', get button() { return t(operation === 'rename' ? 'app.renameSpace' : 'app.closeSpace') }, submit: async name => { await write(`${basePath(source.id)}/spaces${spaceId ? `/${segment(spaceId)}` : ''}`, operation === 'rename' ? 'PATCH' : 'DELETE', operation === 'close' ? undefined : { name }); await refreshResources() } }
}
function windowAction(node: TerminalCanvasNode, operation: 'create' | 'rename' | 'close', destination?: CanvasTabDestination) {
  if (operation === 'create') {
    const source = resources.value.find(source => source.id === node.sourceId)
    const spaceId = source?.spaces.find(space => space.windows.some(window => window.id === node.windowId))?.id || node.spaceId
    createTab(node.sourceId, spaceId, destination); return
  }
  const { source, space, window } = resourceFor(node)
  windowMenu.value = null
  actionDialog.value = { get title() { return t(operation === 'rename' ? 'app.renameWindow' : 'app.closeWindow') }, get description() { return operation === 'close' ? t('app.closeWindowDescription', { name: window?.name || '' }) : `${source?.name || ''} / ${space?.name || ''}` }, get label() { return operation === 'close' ? undefined : t('app.windowName') }, value: operation === 'rename' ? window?.name || '' : '', danger: operation === 'close', get button() { return t(operation === 'rename' ? 'app.renameWindow' : 'app.closeWindow') }, submit: async name => { await write(`${basePath(node.sourceId)}/spaces/${segment(node.spaceId)}/windows/${segment(node.windowId)}`, operation === 'rename' ? 'PATCH' : 'DELETE', operation === 'close' ? undefined : { name }); await refreshResources() } }
}
function scanWindowContent(node: TerminalCanvasNode, name: string) {
  const source = resources.value.find(item => item.id === node.sourceId)
  const spaceId = source?.spaces.find(space => space.windows.some(window => window.id === node.windowId))?.id || node.spaceId
  const canvas = currentCanvas.value
  const anchor = canvas?.nodes.find(item => isTerminalNode(item) && item.sourceId === node.sourceId && item.windowId === node.windowId)
  scanTarget.value = { sourceId: node.sourceId, spaceId, windowId: node.windowId, name,
    context: !isOverview.value && canvas && anchor ? { canvasId: canvas.id, anchorId: anchor.id } : {} }
  windowMenu.value = null; sourcePanel.value = false
}
async function submitAction() {
  const dialog = actionDialog.value
  if (!dialog || busy.value) return
  busy.value = true; dialogError.value = ''
  try { await dialog.submit(dialog.value.trim()); if (actionDialog.value === dialog) actionDialog.value = null }
  catch (reason) { if (actionDialog.value === dialog) dialogError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
watch(actionDialog, () => { dialogError.value = '' })
function getCanvasNode(id: string): TerminalCanvasNode | undefined {
  const node = nodes.value.find(item => item.id === id)
  return node?.type === 'terminal' ? { type: 'terminal', id, sourceId: node.data.sourceId, spaceId: node.data.spaceId, windowId: node.data.windowId, x: node.position.x, y: node.position.y, width: node.data.width, height: node.data.height } : undefined
}
function terminalAction(action: string, id: string) {
  const node = getCanvasNode(id) || focused.value
  if (!node) return
  if (action === 'add') openAdd(node)
  else if (action === 'remove') void removeNode(id)
  else if (action === 'focus') {
    if (paging.value) selectPage(pages.value.find(page => page.id === `${node.sourceId}/${node.windowId}`))
    sidebarOpen.value = false; sourcePanel.value = false; windowResize(); saveViewport(); focused.value = node
  }
  else if (action === 'unfocus') void closeFocus()
  else if (action === 'menu') windowMenu.value = { node, name: resourceFor(node).window?.name || t('app.window') }
}
async function closeFocus() {
  if (document.activeElement instanceof HTMLElement && focusViewportElement.value?.contains(document.activeElement)) document.activeElement.blur()
  focused.value = null; graphKey.value++; await nextTick(); await restoreViewport()
}
function cardAction(action: string, id: string) {
  if (action === 'settings') { openSettings(); return }
  if (action === 'unfocus') { void closeCardFocus(); return }
  if (action !== 'focus' || !mobile.value || !currentCanvas.value?.nodes.some(node => node.id === id && node.type !== 'terminal')) return
  sidebarOpen.value = false; sourcePanel.value = false; canvasMenu.value = false
  hideMobileKeyboard(); saveViewport(); focusedCardId.value = id
}
async function closeCardFocus() {
  if (document.activeElement instanceof HTMLElement && focusViewportElement.value?.contains(document.activeElement)) document.activeElement.blur()
  void flushNotes(activeId.value)
  focusedCardId.value = ''; graphKey.value++
  await nextTick()
  await restoreViewport()
}
watch(focusedCard, card => { if (focusedCardId.value && !card) void closeCardFocus() })
async function removeNode(id: string) {
  const canvas = currentCanvas.value
  if (!canvas) return
  try {
    await write(`/api/canvases/${segment(canvas.id)}/nodes/${segment(id)}`, 'DELETE')
    pendingLayouts.get(canvas.id)?.delete(id)
    clearNoteEdits(canvas.id, id)
    await syncState()
  } catch (reason) { showError(reason) }
}
function openAdd(node?: TerminalCanvasNode) {
  const candidates = node ? canvases.value.filter(canvas => !canvas.nodes.some(item => isTerminalNode(item) && item.sourceId === node.sourceId && item.windowId === node.windowId)) : canvases.value
  addTarget.value = candidates.find(canvas => canvas.id === currentCanvas.value?.id)?.id || candidates[0]?.id || ''
  selectedWindows.value = node ? [`${node.sourceId}/${node.spaceId}/${node.windowId}`] : []
  addSearch.value = ''; addDialog.value = true; dialogError.value = ''
}
async function submitAdd() {
  const chosen = selectedAddWindows.value
  if (!chosen.length || busy.value) return
  busy.value = true; dialogError.value = ''
  try {
    let canvas = canvases.value.find(item => item.id === addTarget.value)
    if (!canvas) { canvas = await write<Canvas>('/api/canvases', 'POST', { name: t('app.myCanvas'), nodes: [] }); canvas.nodes ||= [] }
    let index = canvas.nodes.length
    const additions: CanvasNode[] = []
    for (const item of chosen) {
      if (canvas.nodes.some(node => isTerminalNode(node) && node.sourceId === item.source.id && node.windowId === item.window.id)) continue
      additions.push({ type: 'terminal', id: uuid(), sourceId: item.source.id, spaceId: item.space.id, windowId: item.window.id, x: (index % 3) * 580, y: Math.floor(index / 3) * 390, width: 552, height: 352 }); index++
    }
    await write(`/api/canvases/${segment(canvas.id)}/nodes`, 'POST', { nodes: additions })
    await syncState()
    addDialog.value = false; switchCanvas(canvas.id); rebuildNodes(); void fitView({ padding: .15, maxZoom: 1, duration: 200 }); notify(t('app.addedToCanvas', { name: canvas.name }))
  } catch (reason) { dialogError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
function noteKey(canvasId: string, id: string) { return `${canvasId}/${id}` }
function clearNoteEdits(canvasId?: string, id?: string) {
  for (const [key, edit] of pendingNotes) if ((!canvasId || edit.canvasId === canvasId) && (!id || edit.id === id)) {
    clearTimeout(noteTimers.get(key)); noteTimers.delete(key); pendingNotes.delete(key)
  }
  for (const [key, edit] of savingNotes) if ((!canvasId || edit.canvasId === canvasId) && (!id || edit.id === id)) savingNotes.delete(key)
}
function editNote(canvasId: string, id: string, patch: NotePatch) {
  const node = canvases.value.find(canvas => canvas.id === canvasId)?.nodes.find(node => node.id === id)
  if (!node || node.type !== 'note') return
  const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => node[key as keyof NotePatch] !== value)) as NotePatch
  if (!Object.keys(changed).length) return
  Object.assign(node, changed)
  const key = noteKey(canvasId, id)
  pendingNotes.set(key, { canvasId, id, patch: { ...pendingNotes.get(key)?.patch, ...changed } })
  clearTimeout(noteTimers.get(key))
  noteTimers.set(key, setTimeout(() => { noteTimers.delete(key); void flushNotes(canvasId) }, 400))
  if (activeId.value === canvasId) {
    saveState.value = 'saving'
    nodes.value = nodes.value.map(flow => flow.id === id ? { ...flow, data: { ...flow.data, ...changed }, style: changed.minimized === undefined ? flow.style : { ...flow.style, height: `${changed.minimized ? 30 : node.height}px` } } : flow)
  }
}
async function flushNotes(canvasId?: string): Promise<void> {
  const context = apiContext()
  if (noteSave) { await noteSave; if (!isCurrentApi(context)) return; if ([...pendingNotes.values()].some(edit => !canvasId || edit.canvasId === canvasId)) return flushNotes(canvasId); return }
  const batch = [...pendingNotes.entries()].filter(([, edit]) => !canvasId || edit.canvasId === canvasId)
  if (!batch.length) return
  for (const [key, edit] of batch) {
    clearTimeout(noteTimers.get(key)); noteTimers.delete(key); pendingNotes.delete(key); savingNotes.set(key, edit)
  }
  noteSave = (async () => {
    let failed = false
    for (const [key, edit] of batch) {
      try {
        await api(`/api/canvases/${segment(edit.canvasId)}/notes/${segment(edit.id)}`, { method: 'PATCH', body: JSON.stringify(edit.patch) }, context)
        if (savingNotes.get(key) === edit) savingNotes.delete(key)
      } catch (reason) {
        if (!isCurrentApi(context)) return
        failed = true
        if (savingNotes.get(key) === edit) {
          savingNotes.delete(key)
          if (canvases.value.find(canvas => canvas.id === edit.canvasId)?.nodes.some(node => node.id === edit.id)) pendingNotes.set(key, { ...edit, patch: { ...edit.patch, ...pendingNotes.get(key)?.patch } })
        }
        showError(reason)
      }
    }
    if (!isCurrentApi(context)) return
    await syncState().catch(showError)
    if (!canvasId || activeId.value === canvasId) saveState.value = failed ? 'saveFailed' : 'saved'
  })()
  try { await noteSave } finally { if (isCurrentApi(context)) noteSave = undefined }
}
function scheduleSave() {
  const context = apiContext()
  const canvas = currentCanvas.value
  if (!canvas) return
  clearTimeout(saveTimers.get(canvas.id)); saveState.value = 'saving'
  saveTimers.set(canvas.id, setTimeout(async () => {
    saveTimers.delete(canvas.id)
    const batch = new Map(pendingLayouts.get(canvas.id))
    if (!batch.size) return
    try {
      await api(`/api/canvases/${segment(canvas.id)}/layout`, { method: 'PATCH', body: JSON.stringify({ nodes: [...batch].map(([id, patch]) => ({ id, ...patch })) }) }, context)
      const pending = pendingLayouts.get(canvas.id)
      for (const [id, patch] of batch) if (pending?.get(id) === patch) pending.delete(id)
      if (!pending?.size) pendingLayouts.delete(canvas.id)
      await syncState()
      if (activeId.value === canvas.id) saveState.value = 'saved'
    }
    catch (reason) { if (!isCurrentApi(context)) return; if (activeId.value === canvas.id) saveState.value = 'saveFailed'; showError(reason) }
  }, 450))
}
async function addNote() {
  const canvas = currentCanvas.value
  if (!canvas || busy.value) return
  busy.value = true
  const viewport = getViewport(), area = document.querySelector('.graph-wrap')?.getBoundingClientRect()
  const x = Math.round(((area?.width || 800) / 2 - viewport.x) / viewport.zoom - 160)
  const y = Math.round(((area?.height || 600) / 2 - viewport.y) / viewport.zoom - 120)
  try {
    const previous = new Set(canvas.nodes.map(node => node.id))
    const result = await write<Canvas>(`/api/canvases/${segment(canvas.id)}/notes`, 'POST', { x, y })
    await syncState()
    const added = result.nodes.find(node => !previous.has(node.id))
    if (added && activeId.value === canvas.id) {
      if (mobile.value) { cardAction('focus', added.id); return }
      pendingNoteFocus = added.id
      await nextTick()
      nodes.value = nodes.value.map(node => ({ ...node, selected: node.id === added.id }))
      await nextTick()
      requestAnimationFrame(() => focusNewNote())
    }
  } catch (reason) { showError(reason) }
  finally { busy.value = false }
}
function removeFile(id: string) {
  const node = currentCanvas.value?.nodes.find(item => item.id === id)
  if (!node || node.type !== 'file') return
  actionDialog.value = { get title() { return t('app.deleteNamed', { name: node.asset.filename }) }, get description() { return t('app.deleteFileDescription') }, value: '', danger: true, get button() { return t('app.deleteFile') }, submit: async () => { await removeNode(id) } }
}
function removeNote(id: string) {
  const node = currentCanvas.value?.nodes.find(item => item.id === id)
  if (!node || node.type !== 'note') return
  if (!node.content.trim()) { void removeNode(id); return }
  actionDialog.value = { get title() { return t('app.deleteNamed', { name: node.title || t('app.note') }) }, description: '', value: '', danger: true, get button() { return t('app.deleteNote') }, submit: async () => { await removeNode(id) } }
}
async function toggleSnap() {
  const canvas = currentCanvas.value
  if (!canvas) return
  try { await write(`/api/canvases/${segment(canvas.id)}`, 'PATCH', { snapToGrid: !canvas.snapToGrid }); await syncState() }
  catch (reason) { showError(reason) }
}
function layoutStarted() { if (!mobile.value) layoutGesture = activeId.value }
function editLayout(id: string, patch: LayoutPatch) {
  const canvas = currentCanvas.value
  const node = canvas?.nodes.find(item => item.id === id)
  if (!canvas || !node) return
  const pending = pendingLayouts.get(canvas.id) || new Map<string, LayoutPatch>()
  pending.set(id, { ...pending.get(id), ...patch })
  pendingLayouts.set(canvas.id, pending)
  Object.assign(node, patch)
  scheduleSave()
}
function dragStopped(event: { node: Node }) {
  if (mobile.value) return
  layoutGesture = ''
  editLayout(event.node.id, { x: event.node.position.x, y: event.node.position.y })
  rebuildNodes()
}
function resizeNode(id: string, width: number, height: number, x?: number, y?: number) {
  if (mobile.value) return
  layoutGesture = ''
  const node = currentCanvas.value?.nodes.find(item => item.id === id)
  if (node) {
    const size = { width: Math.round(width), height: Math.max(160, Math.min(3000, Math.round(height))) }
    if (isTerminalNode(node)) windowSizes.value[`${node.sourceId}/${node.windowId}`] = size
    editLayout(id, { ...size, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) })
  }
  rebuildNodes()
}
function keydown(event: KeyboardEvent) {
  if (directoryRequest.value || urlRequest.value) return
  if (downloadPreview.value) return
  if (backgroundCanvas.value) return
  if (settingsDialog.value) return
  if (scanTarget.value) return
  if ((event.target as HTMLElement)?.closest('.xterm, .note-card input, .note-card textarea') && !modalOpen.value) return
  if (paging.value && !focused.value && !modalOpen.value && !overviewMenuOpen.value && !canvasMenu.value && !sidebarOpen.value && !sourcePanel.value &&
      !event.ctrlKey && !event.altKey && !event.metaKey && !(event.target as HTMLElement)?.closest('input, textarea, select, button, a, [contenteditable="true"]')) {
    const direction = pageDirections.value.find(item => item.key === event.key)?.direction
    if (direction) { event.preventDefault(); if (!event.repeat) movePage(direction); return }
  }
  if (event.key === 'Escape') {
    if (sidebarOpen.value) sidebarOpen.value = false
    else if (canvasMenu.value) { canvasMenu.value = false; canvasMenuElement.value?.querySelector<HTMLButtonElement>('.canvas-menu-trigger')?.focus() }
    else if (overviewMenuOpen.value) overviewMenuOpen.value = false
    else if (windowMenu.value) windowMenu.value = null
    else if (actionDialog.value) { if (!busy.value) actionDialog.value = null }
    else if (sourceDialog.value) sourceDialog.value = false
    else if (canvasDialog.value) canvasDialog.value = false
    else if (addDialog.value) addDialog.value = false
    else if (focused.value) void closeFocus()
    else if (focusedCardId.value) void closeCardFocus()
    else sourcePanel.value = false
  }
}
function outsideOverviewMenu(event: PointerEvent) {
  if (!overviewMenuOpen.value) return
  const target = event.target instanceof Element ? event.target : undefined
  if (!target?.closest('.overview-display-menu, .overview-display-trigger')) overviewMenuOpen.value = false
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (!pendingNotes.size && !savingNotes.size) return
  void flushNotes()
  event.preventDefault()
  event.returnValue = ''
}
function windowResize() {
  queueCameraResize()
  if (!mobile.value) {
    focusedSize.width = window.innerWidth - 32; focusedSize.height = window.innerHeight - 32
  }
}
function queueCameraResize() {
  cancelAnimationFrame(cameraResize)
  cameraResize = requestAnimationFrame(() => {
    if (paging.value) { void fitPage(); return }
    if (!mobile.value || hasFocus.value || pendingViewport) return
    const frame = canvasFrame(graphSurface.value)
    if (!frame) return
    const previous = cameraFrame
    cameraFrame = frame
    const current = getViewport()
    const next = preserveCanvasCenter(current, previous, frame)
    if (next !== current) {
      const id = activeId.value
      void setViewport(next).then(() => { if (id === activeId.value && !hasFocus.value) saveViewport() })
    }
  })
}
watch([modalOpen, directoryRequest, downloadPreview, urlRequest], ([modal, directory, preview, url]) => {
  if (modal || directory || preview || url) hideMobileKeyboard()
})
watch(graphSurface, element => {
  cameraObserver?.disconnect()
  if (element) {
    cameraObserver = new ResizeObserver(queueCameraResize)
    cameraObserver.observe(element)
  }
})
watch(visibleViewport, () => { if (mobile.value) void nextTick(windowResize) })
watch(mobile, () => { sidebarOpen.value = false; if (!mobile.value && focusedCardId.value) void closeCardFocus(); canvasTouchCancel(); rebuildNodes() })
watch(sourcePanel, value => { if (value && mobile.value) sidebarOpen.value = false })
watch(sidebarOpen, value => { if (value) canvasMenu.value = false })
watch(canvasFullscreen, async () => { await nextTick(); cameraFrame = canvasFrame(graphSurface.value) })
setDownloadContext(resource => {
  if (isOverview.value) return undefined
  const canvas = currentCanvas.value
  const anchor = canvas?.nodes.find(node => isTerminalNode(node) && node.sourceId === resource.sourceId && node.windowId === resource.windowId)
  return canvas && anchor ? { canvasId: canvas.id, anchorId: anchor.id } : undefined
})
onMounted(async () => {
  for (const event of ['pointerdown', 'keydown', 'wheel', 'touchmove']) window.addEventListener(event, creationNavigation, { capture: true, passive: true })
  window.addEventListener('canvas:unauthorized', unauthorized)
  window.addEventListener('canvas:session-changed', sessionChanged)
  window.addEventListener('canvas:error', requestError)
  window.addEventListener('keydown', keydown)
  window.addEventListener('resize', windowResize)
  window.addEventListener('beforeunload', beforeUnload)
  document.addEventListener('pointerdown', outsideCanvasMenu)
  document.addEventListener('pointerdown', outsideOverviewMenu, true)
  navigation.read()
  instanceBooted = true
  if (unknownInstance.value || invalidInstanceLink) ready.value = true
  else await activateInstance()
  document.addEventListener('visibilitychange', visibilityChanged)
  refreshTimer = setInterval(() => { if (!document.hidden) void refreshResources(true) }, 2000)
})
onBeforeUnmount(() => { document.removeEventListener('visibilitychange', visibilityChanged); for (const event of ['pointerdown', 'keydown', 'wheel', 'touchmove']) window.removeEventListener(event, creationNavigation, true); fontRevision++; cameraObserver?.disconnect(); cancelAnimationFrame(cameraResize); setDownloadContext(); stopStateEvents(); cancelAnimationFrame(geometryFrame); clearInterval(refreshTimer); for (const timer of saveTimers.values()) clearTimeout(timer); clearTimeout(noticeTimer); for (const timer of noteTimers.values()) clearTimeout(timer); clearTerminals(); window.removeEventListener('canvas:unauthorized', unauthorized); window.removeEventListener('canvas:session-changed', sessionChanged); window.removeEventListener('canvas:error', requestError); window.removeEventListener('keydown', keydown); window.removeEventListener('resize', windowResize); window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('pointerdown', outsideCanvasMenu); document.removeEventListener('pointerdown', outsideOverviewMenu, true) })
</script>

<template>
  <UApp :locale="uiLocale" :portal="appElement || false" :toaster="null">
  <PwaUpdatePrompt :portal="appElement" />
  <div v-if="!ready" class="boot-screen"><span class="spinner" />{{ t('common.loading') }}</div>
  <div v-else-if="!authenticated || unknownInstance" class="login-screen" :class="{ 'mobile-layout': mobile }" :style="mobileViewportStyle">
    <main class="login-content">
      <div class="brand login-brand"><span class="brand-symbol"><Icon name="canvas" :size="27" /></span><span class="brand-name">canvas</span><LanguageSelect class="login-language" /></div>
      <InstancePicker v-if="instances.length" :disabled="busy" />
      <div v-if="unknownInstance" class="login-form"><p class="form-error" role="status">{{ t('canvasUi.unknownInstance') }}</p><button class="button primary login-button" @click="navigation.visit(activeInstance.id, 'overview'); activateInstance()">{{ t('canvasUi.openInstance') }}</button></div>
      <div v-else-if="checkingInstance" class="instance-checking" role="status"><span class="spinner" />{{ t('common.loading') }}</div>
      <InstanceSetup v-else-if="instanceUnavailable" :message="instanceSetupMessage ? t(instanceSetupMessage) : ''" @connect="connectInstance" />
      <form v-else class="login-form" @submit.prevent="login">
        <p class="login-address" :title="activeInstance.base">{{ activeInstance.base }}</p>
        <label>{{ t('app.username') }}<input v-model="username" name="username" autocomplete="username" required autofocus /></label>
        <label>{{ t('app.passwordLabel') }}<input v-model="password" name="password" type="password" autocomplete="current-password" required /></label>
        <p v-if="loginError" class="form-error" role="alert">{{ loginError }}</p>
        <button class="button primary login-button" :disabled="busy || checkingInstance" type="submit"><span v-if="busy || checkingInstance" class="spinner" />{{ busy ? t('app.signingIn') : t('app.signIn') }}</button>
      </form>
    </main>
  </div>
  <div v-else ref="appElement" class="app-shell" :class="{ 'canvas-fullscreen': canvasFullscreen, 'mobile-layout': mobile, 'has-display-cutout': hasSafeTop, 'cutout-preview-active': settingsDialog && mobile && hasSafeTop }" :style="[mobileViewportStyle, contentFontStyle]" :data-content-font="appliedContentFont">
    <button v-if="mobile && sidebarOpen" class="sidebar-backdrop" :aria-label="t('app.closeCanvasList')" @click="sidebarOpen = false" />
    <aside v-show="!mobile || sidebarOpen" :inert="!!focusedCard || undefined" :aria-hidden="!!focusedCard || undefined" id="canvas-sidebar" class="sidebar" :class="{ 'sidebar-open': sidebarOpen }">
      <div class="brand"><span class="brand-symbol"><Icon name="canvas" :size="24" /></span><span class="brand-name">canvas</span><button v-if="mobile" class="icon-button sidebar-close" :aria-label="t('app.closeCanvasList')" @click="sidebarOpen = false"><Icon name="close" :size="19" /></button></div>
      <div class="sidebar-instance"><InstancePicker :portal="appElement" :before-change="beforeInstanceChange" :disabled="busy" /></div>
      <div class="nav-section-label canvas-label"><span>{{ t('app.canvases') }}</span><button class="icon-button" :title="t('app.newCanvas')" :aria-label="t('app.newCanvas')" @click="openCanvasDialog()"><Icon name="plus" :size="14" /></button></div>
      <nav class="canvas-nav" :aria-label="t('app.canvases')">
        <CanvasNavItem :name="t('app.overview')" overview :active="isOverview" :indicator="indicators.overview" @select="switchCanvas('overview')" />
        <CanvasNavItem v-for="canvas in canvases" :key="canvas.id" :name="canvas.name" :active="activeId === canvas.id" :indicator="indicators[canvas.id]" @select="switchCanvas(canvas.id)" />
      </nav>
      <div class="sidebar-divider" />
      <div class="nav-section-label"><span>{{ t('app.connections') }}</span><button class="icon-button" :title="t('app.addConnection')" :aria-label="t('app.addConnection')" @click="openSource()"><Icon name="plus" :size="16" /></button></div>
      <div class="source-nav"><button v-for="source in sources" :key="source.id" class="source-nav-item" :title="`${source.name} · ${source.transport === 'local' ? t('app.local') : source.target?.replace(/^ssh:\/\//, '')}`" @click="sourcePanel = true; expandedSource = source.id"><Icon class="source-nav-icon" name="server" :size="16" /><span class="source-nav-name">{{ source.name }}</span><span class="source-nav-status"><span class="connection-dot" :class="resources.find(item => item.id === source.id)?.error ? 'disconnected' : 'connected'" /></span></button><button v-if="!sources.length" class="source-empty" @click="openSource()"><Icon name="plus" :size="15" />{{ t('app.addConnection') }}</button></div>
      <div class="sidebar-footer"><button class="icon-button sidebar-settings" :title="t('common.settings')" :aria-label="t('common.settings')" :aria-busy="fontLoading" :disabled="!settings" @click="openSettings"><span v-if="fontLoading" class="spinner" /><svg v-else width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 3-.6 2.3-2 .9-2.1-.7-2.5 4.3 1.7 1.6v2.3L2.3 15l2.5 4.3 2.1-.7 2 .9.6 2.3h5l.6-2.3 2-.9 2.1.7 2.5-4.3-1.7-1.6v-2.3l1.7-1.6-2.5-4.3-2.1.7-2-.9-.6-2.3z" /><circle cx="12" cy="12" r="3" /></svg></button><button class="icon-button" :title="t('app.signOut')" :aria-label="t('app.signOut')" @click="logout"><Icon name="logout" :size="17" /></button></div>
    </aside>
    <main class="workspace" :inert="!!focusedCard || undefined" :aria-hidden="!!focusedCard || undefined">
      <header class="workspace-header">
        <div class="header-context"><button v-if="mobile" class="icon-button mobile-menu-trigger" :aria-label="t('app.openCanvasList')" aria-controls="canvas-sidebar" :aria-expanded="sidebarOpen" @click="sidebarOpen = !sidebarOpen"><Icon name="menu" :size="21" /></button><div class="breadcrumb"><h1 :title="currentName">{{ currentName }}</h1></div><span class="header-counts">{{ canvasCounts }}</span><button class="icon-button refresh-button" :title="refreshedAt ? t('app.refreshUpdated', { time: refreshedTime }) : t('app.refresh')" :aria-label="t('app.refresh')" :disabled="loading" @click="refreshResources()"><Icon name="refresh" :size="14" :class="{ spinning: loading }" /></button></div>
        <div class="header-actions">
          <UDropdownMenu v-if="isOverview" v-model:open="overviewMenuOpen" :items="overviewMenu" :portal="appElement || false" :content="{ align: 'end' }" :ui="{ content: 'overview-display-menu', item: 'overview-display-item', label: 'overview-display-label' }">
            <button class="icon-button overview-display-trigger" :class="{ active: overviewChanged }" :title="t('app.filterSort')" :aria-label="t('app.overviewFilterSort')"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg><i v-if="overviewChanged" /></button>
            <template #item-leading="{ item }"><span class="overview-display-leading" aria-hidden="true"><i v-if="item.status" class="program-dot" :style="{ '--program-color': statusColor(item.status) }" /></span></template>
          </UDropdownMenu>
          <button v-if="!isOverview" class="button subtle" :title="t('app.addNote')" :aria-label="t('app.addNote')" :disabled="busy" @click="addNote"><Icon name="note" :size="14" />{{ t('app.note') }}</button>
          <span v-if="!isOverview && saveState" class="save-state" :title="t(`app.${saveState}`)" :aria-label="t(`app.${saveState}`)"><span v-if="saveState === 'saving'" class="spinner" /><Icon v-else :name="saveState === 'saved' ? 'check' : 'info'" :size="13" /></span>
          <div ref="canvasMenuElement" class="canvas-menu-wrap"><button class="icon-button canvas-menu-trigger" :title="t('app.canvasSettings')" :aria-label="t('app.canvasSettings')" :aria-expanded="canvasMenu" aria-controls="canvas-menu" @click="toggleCanvasMenu"><Icon name="more" :size="17" /></button><div v-if="canvasMenu" id="canvas-menu" class="canvas-menu"><template v-if="mobile"><button @click="canvasMenu = false; refreshResources()"><Icon name="refresh" :size="15" />{{ t('app.refresh') }}</button><button @click="canvasMenu = false; sourcePanel = true"><Icon name="server" :size="15" />{{ t('app.connections') }}</button><button v-if="!isOverview" @click="canvasMenu = false; addNote()"><Icon name="note" :size="15" />{{ t('app.addNote') }}</button><button v-if="!isOverview" @click="canvasMenu = false; openAdd()"><Icon name="plus" :size="15" />{{ t('app.addWindows') }}</button></template><button @click="openBackground"><Icon name="image" :size="15" />{{ t('app.background') }}</button><button :aria-pressed="showMinimap" @click="showMinimap = !showMinimap"><Icon name="map" :size="15" />{{ t('app.minimap') }}<Icon class="canvas-menu-check" :class="{ unchecked: !showMinimap }" name="check" :size="15" /></button><button :aria-pressed="showNavigation" @click="showNavigation = !showNavigation"><Icon name="navigation" :size="15" />{{ t('app.navigation') }}<Icon class="canvas-menu-check" :class="{ unchecked: !showNavigation }" name="check" :size="15" /></button><button v-if="!isOverview" @click="canvasMenu = false; openCanvasDialog(currentCanvas)"><Icon name="edit" :size="15" />{{ t('app.renameCanvas') }}</button><button v-if="!isOverview" class="danger-text" @click="canvasMenu = false; deleteCanvas()"><Icon name="trash" :size="15" />{{ t('app.deleteCanvas') }}</button></div></div>
          <button class="button subtle" :title="t('app.connections')" :aria-label="t('app.connections')" @click="sourcePanel = true"><Icon name="server" :size="15" />{{ t('app.connections') }}</button>
          <button v-if="isOverview" class="button primary" :title="t('app.addConnection')" :aria-label="t('app.addConnection')" @click="openSource()"><Icon name="plus" :size="15" />{{ t('app.addConnection') }}</button><button v-else class="button primary" :title="t('app.addWindows')" :aria-label="t('app.addWindows')" @click="openAdd()"><Icon name="plus" :size="15" />{{ t('app.addWindows') }}</button>
        </div>
      </header>
      <div ref="graphSurface" class="graph-wrap" :class="{ 'has-background': currentBackground, paged: paging }" :data-page-window="paging ? currentPage?.id : undefined" @mousedown.capture="guardPageDrag" @wheel.capture="canvasWheel" @touchstart.capture="canvasTouchStart" @touchmove.capture="canvasTouchMove" @touchend.capture="canvasTouchEnd" @touchcancel.capture="canvasTouchCancel" @click.capture="canvasClick">
        <CanvasFileDrop :canvas-id="currentCanvas?.id" :get-viewport="getViewport" />
        <img v-if="currentBackground && backgroundUrl" class="canvas-background" :src="backgroundUrl" :style="{ opacity: currentBackground.opacity }" alt="" aria-hidden="true" />
        <span id="canvas-card-select-help" hidden>{{ t('app.cardSelectHelp') }}</span>
        <span id="canvas-card-move-help" hidden>{{ t('app.cardMoveHelp') }}</span>
        <VueFlow :snap-to-grid="!isOverview && !!currentCanvas?.snapToGrid" :snap-grid="[24, 24]" v-if="nodes.length && !hasFocus" :key="graphKey" v-model:nodes="nodes" :min-zoom="0.08" :max-zoom="2" :nodes-connectable="false" :nodes-draggable="!isOverview && !mobile" :elements-selectable="!mobile" :zoom-on-double-click="false" :zoom-on-scroll="false" :zoom-on-pinch="false" :pan-on-scroll="false" :delete-key-code="null" :selection-key-code="null" :pan-on-drag="!mobile && !paging" :pan-activation-key-code="paging ? null : 'Space'" :prevent-scrolling="true" @node-drag-start="layoutStarted" @node-drag-stop="dragStopped" @move-end="saveViewport" @init="restoreViewport" @nodes-initialized="nodesInitialized" @nodes-change="announceNodeMove"><template #node-terminal="nodeProps"><TerminalNode v-bind="nodeProps" /></template><template #node-note="nodeProps"><NoteNode v-bind="nodeProps" /></template><template #node-file="nodeProps"><FileNode v-bind="nodeProps" /></template><template #node-group="nodeProps"><GroupNode v-bind="nodeProps" /></template><template #node-create="nodeProps"><OverviewCreateNode v-bind="nodeProps" /></template><MiniMap v-if="showMinimap" :aria-label="t('app.windowNavigation')" @node-click="navigateMinimap" :node-class-name="node => node.type === 'terminal' ? `minimap-window${node.data.statusFresh && needsAttention(node.data.status) ? ' minimap-pulse' : ''}${paging && currentPage?.id === `${node.data.sourceId}/${node.data.windowId}` ? ' minimap-current' : ''}` : 'minimap-decoration'" :pannable="!paging" :zoomable="!mobile && !paging" :node-color="node => node.type === 'terminal' ? statusColor(node.data.status) : node.type === 'note' ? noteColor(node.data.color) : node.type === 'file' ? '#8796b3' : 'transparent'" :node-stroke-width="0" :mask-color="'rgba(17,19,23,.7)'" /></VueFlow>
        <div v-if="!nodes.length && isOverview" class="empty-state"><Icon name="server" :size="32" /><h2>{{ windowCount && overviewFiltered ? t('app.noMatchingWindows') : sources.length ? t('app.noWindows') : t('app.noConnections') }}</h2><button v-if="windowCount && overviewFiltered" class="button subtle" @click="overviewSelected = [...overviewStatuses]">{{ t('app.clearFilters') }}</button><button v-else class="button primary" @click="sources.length ? sourcePanel = true : openSource()"><Icon :name="sources.length ? 'server' : 'plus'" :size="17" />{{ sources.length ? t('app.connections') : t('app.addConnection') }}</button></div>
        <div v-if="!nodes.length && !isOverview" class="empty-state"><Icon name="canvas" :size="32" /><h2>{{ t('app.emptyCanvas') }}</h2><button class="button primary" @click="openAdd()"><Icon name="plus" :size="17" />{{ t('app.addWindows') }}</button></div>
        <button v-if="canvasFullscreen && !showNavigation && !focused" class="icon-button canvas-fullscreen-exit" :title="t('app.exitFullscreen')" :aria-label="t('app.exitFullscreen')" @click="exitFullscreen"><Icon name="collapse" :size="19" /></button>
        <div v-if="showNavigation && !focused" class="canvas-toolbar"><button v-if="canvasFullscreen" :title="t('app.globalSettings')" :aria-label="t('app.globalSettings')" :disabled="!settings" @click="openSettings"><Icon name="settings" :size="17" /></button><button :title="canvasFullscreen ? t('app.exitFullscreen') : t('app.fullscreen')" :aria-label="canvasFullscreen ? t('app.exitFullscreen') : t('app.fullscreen')" :aria-pressed="canvasFullscreen" @click="toggleFullscreen"><Icon :name="canvasFullscreen ? 'collapse' : 'expand'" :size="17" /></button><button v-if="isOverview" :title="t('app.pagedBrowsing')" :aria-label="t('app.pagedBrowsing')" :aria-pressed="overviewPaged" @click="togglePaging"><Icon name="pages" :size="17" /></button><button v-if="!isOverview" :title="t('app.snapToGrid')" :aria-label="t('app.snapToGrid')" :aria-pressed="!!currentCanvas?.snapToGrid" @click="toggleSnap"><Icon name="grid" :size="15" /></button><template v-if="paging"><button v-for="item in pageDirections" :key="item.direction" :title="item.label" :aria-label="item.label" :disabled="!pageNeighbor(item.direction)" @pointerdown.prevent @click="movePage(item.direction)"><Icon :name="item.icon" :size="16" :style="{ transform: item.rotation }" /></button></template><button v-if="!paging" :title="t('app.zoomOut')" :aria-label="t('app.zoomOut')" @click="zoomOut({ duration: 150 })"><Icon name="minus" :size="17" /></button><button :title="paging ? t('app.centerWindow') : t('app.fitCanvas')" :aria-label="paging ? t('app.centerWindow') : t('app.fitCanvas')" @click="fitCanvas"><Icon name="fit" :size="17" /></button><button v-if="!paging" :title="t('app.zoomIn')" :aria-label="t('app.zoomIn')" @click="zoomIn({ duration: 150 })"><Icon name="plus" :size="17" /></button></div>
      </div>
    </main>
    <Transition name="slide"><aside v-if="sourcePanel" class="source-panel"><header><div><h2>{{ t('app.connectionsWindows') }}</h2></div><button class="icon-button" :aria-label="t('app.closeConnections')" @click="sourcePanel = false"><Icon name="close" /></button></header><button class="button primary full-width" @click="openSource()"><Icon name="plus" :size="16" />{{ t('app.addConnection') }}</button><div class="source-panel-content"><div v-for="source in sources" :key="source.id" class="source-detail"><div class="source-detail-header"><button class="source-expand" @click="expandedSource = expandedSource === source.id ? '' : source.id"><Icon name="chevron" :size="15" :class="{ rotated: expandedSource === source.id }" /><span>{{ source.name }}<small>{{ source.transport === 'local' ? t('app.local') : source.target }}</small></span></button><button class="icon-button" :title="t('app.editConnection')" :aria-label="t('app.editConnection')" @click="openSource(source)"><Icon name="edit" :size="14" /></button><button class="icon-button" :title="t('app.removeConnection')" :aria-label="t('app.removeConnection')" @click="deleteSource(source)"><Icon name="trash" :size="14" /></button></div><template v-if="expandedSource === source.id"><div v-if="resources.find(item => item.id === source.id)?.error" class="source-error">{{ resources.find(item => item.id === source.id)?.error }}</div><div v-for="space in resources.find(item => item.id === source.id)?.spaces || []" :key="space.id" class="space-detail"><div class="space-detail-header"><Icon name="layers" :size="14" /><strong>{{ space.name }}</strong><button class="icon-button" :title="t('app.newWindow')" :aria-label="t('app.newWindow')" @click="windowAction({ type: 'terminal', id: '', sourceId: source.id, spaceId: space.id, windowId: '', x: 0, y: 0, width: 0, height: 0 }, 'create')"><Icon name="plus" :size="14" /></button><button class="icon-button" :title="t('app.renameSpace')" :aria-label="t('app.renameSpace')" @click="spaceAction(resources.find(item => item.id === source.id)!, space.id, 'rename')"><Icon name="edit" :size="13" /></button><button class="icon-button danger-hover" :title="t('app.closeSpace')" :aria-label="t('app.closeSpace')" @click="spaceAction(resources.find(item => item.id === source.id)!, space.id, 'close')"><Icon name="close" :size="14" /></button></div><div v-for="window in space.windows" :key="window.id" class="window-detail"><span class="program-dot" :style="{ '--program-color': statusColor(window.status) }" :title="statusLabel(window.status)" /><span>{{ window.name }}</span><button class="icon-button" :title="t('app.addToCanvas')" :aria-label="t('app.addToCanvas')" @click="openAdd({ type: 'terminal', id: '', sourceId: source.id, spaceId: space.id, windowId: window.id, x: 0, y: 0, width: 480, height: 302 })"><Icon name="plus" :size="14" /></button><button class="icon-button" :title="t('app.windowActions')" :aria-label="t('app.windowActions')" @click="windowMenu = { name: window.name, node: { type: 'terminal', id: '', sourceId: source.id, spaceId: space.id, windowId: window.id, x: 0, y: 0, width: 480, height: 302 } }"><Icon name="more" :size="15" /></button></div></div><button class="source-new-space" @click="spaceAction(resources.find(item => item.id === source.id) || { ...source, status: '', spaces: [] }, undefined, 'create')"><Icon name="plus" :size="14" />{{ t('app.newSpace') }}</button></template></div><p v-if="!sources.length" class="panel-empty">{{ t('app.noConnections') }}</p></div></aside></Transition>
    <div v-if="focused || focusedCard" ref="focusViewportElement" class="focus-overlay" :class="{ 'card-focus-overlay': focusedCard }">
      <TerminalNode v-if="focused" :key="focused.id" :id="focused.id" :data="{ ...terminalData(focused, isOverview), ...focusedSize, overview: isOverview, focus: true }" />
      <NoteNode v-else-if="focusedCard?.type === 'note'" :key="focusedCard.id" :id="focusedCard.id" :selected="false" :data="noteData(focusedCard, true)" />
      <FileNode v-else-if="focusedCard?.type === 'file'" :key="focusedCard.id" :id="focusedCard.id" :selected="false" :data="fileData(focusedCard, true)" />
    </div>
    <BackgroundDialog v-if="backgroundCanvas" :canvas="backgroundCanvas" @close="closeBackgroundDialog" @saved="backgroundSaved" />
    <ViewportDiagnostics v-if="developerMode" :settings="settings" :portal="appElement" :reload-blocked="!!modalOpen" />
    <DirectoryDialog :portal="appElement" />
    <UrlDialog :portal="appElement" />
    <DownloadPreviewDialog :portal="appElement" />
    <WindowContentDialog :target="scanTarget" :canvases="canvases" :portal="appElement" @close="scanTarget = null" />
    <SettingsDialog v-if="settings" :open="settingsDialog" :settings="settings" :has-display-cutout="hasSafeTop" :portal="appElement" @close="settingsDialog = false" @saved="settingsSaved" @error="showError" />
    <CutoutPreview v-if="settingsDialog && mobile && hasSafeTop" />
    <div v-if="modalOpen && !backgroundCanvas && !settingsDialog && !scanTarget" class="modal-backdrop" @click.self="!busy && (sourceDialog = false, canvasDialog = false, actionDialog = null, addDialog = false, windowMenu = null)">
      <section v-if="sourceDialog" class="modal source-modal" role="dialog" aria-modal="true" aria-labelledby="source-title"><header><div><h2 id="source-title">{{ sourceDraft.id ? t('app.editConnection') : t('app.addConnection') }}</h2></div><button class="icon-button" :aria-label="t('app.closeDialog')" @click="sourceDialog = false"><Icon name="close" /></button></header><form @submit.prevent="submitSource"><label>{{ t('app.connectionName') }}<input v-model="sourceDraft.name" name="sourceName" required :placeholder="t('app.connectionNamePlaceholder')" /></label><div class="segmented-control"><button type="button" :class="{ selected: sourceDraft.transport === 'local' }" @click="sourceDraft.transport = 'local'"><Icon name="server" :size="15" />{{ t('app.local') }}</button><button type="button" :class="{ selected: sourceDraft.transport === 'ssh' }" @click="sourceDraft.transport = 'ssh'"><Icon name="globe" :size="15" />{{ t('app.remoteSsh') }}</button></div><label v-if="sourceDraft.transport === 'ssh'">{{ t('app.sshAddress') }}<input v-model="sourceDraft.target" name="target" placeholder="ssh://user@hostname:22" :required="sourceDraft.transport === 'ssh'" /></label><label>{{ t('app.session') }} <span class="optional">{{ t('app.optional') }}</span><input v-model="sourceDraft.herdrSession" name="herdrSession" placeholder="default" /></label><details><summary>{{ t('app.advanced') }}</summary><template v-if="sourceDraft.transport === 'ssh'"><label>{{ t('app.sshIdentity') }} <span class="optional">{{ t('app.optional') }}</span><input v-model="sourceDraft.sshIdentityFile" name="sshIdentityFile" placeholder="/path/to/id_ed25519" /></label><label>{{ t('app.sshKnownHosts') }} <span class="optional">{{ t('app.optional') }}</span><input v-model="sourceDraft.sshKnownHostsFile" name="sshKnownHostsFile" placeholder="/path/to/known_hosts" /></label></template><label>{{ t('app.socketPath') }} <span class="optional">{{ t('app.optional') }}</span><input v-model="sourceDraft.herdrSocket" name="herdrSocket" placeholder="/path/to/herdr.sock" /></label></details><p v-if="dialogError" class="form-error" role="alert">{{ dialogError }}</p><footer><button class="button subtle" type="button" @click="sourceDialog = false">{{ t('common.cancel') }}</button><button class="button primary" type="submit" :disabled="busy"><span v-if="busy" class="spinner" />{{ busy ? t('app.saving') : t('common.save') }}</button></footer></form></section>
      <section v-else-if="canvasDialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="canvas-title"><header><div><h2 id="canvas-title">{{ canvasDraft.id ? t('app.renameCanvas') : t('app.newCanvas') }}</h2></div><button class="icon-button" :aria-label="t('app.closeDialog')" @click="canvasDialog = false"><Icon name="close" /></button></header><form @submit.prevent="submitCanvas"><label>{{ t('app.canvasName') }}<input v-model="canvasDraft.name" name="canvasName" required autofocus :placeholder="t('app.canvasNamePlaceholder')" maxlength="80" /></label><p v-if="dialogError" class="form-error">{{ dialogError }}</p><footer><button class="button subtle" type="button" @click="canvasDialog = false">{{ t('common.cancel') }}</button><button class="button primary" :disabled="busy" type="submit">{{ canvasDraft.id ? t('common.save') : t('app.createCanvas') }}</button></footer></form></section>
      <section v-else-if="actionDialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="action-title"><header><h2 id="action-title">{{ actionDialog.title }}</h2><button class="icon-button" :aria-label="t('app.closeDialog')" :disabled="busy" @click="actionDialog = null"><Icon name="close" /></button></header><p v-if="actionDialog.description">{{ actionDialog.description }}</p><form @submit.prevent="submitAction"><label v-if="actionDialog.label">{{ actionDialog.label }}<input v-model="actionDialog.value" name="resourceName" :required="!actionDialog.optional" :placeholder="actionDialog.optional ? t('app.automaticName') : undefined" autofocus maxlength="100" /></label><p v-if="dialogError" class="form-error" role="alert">{{ dialogError }}</p><footer><button class="button subtle" type="button" :disabled="busy" @click="actionDialog = null">{{ t('common.cancel') }}</button><button class="button" :class="actionDialog.danger ? 'danger' : 'primary'" :disabled="busy" type="submit">{{ actionDialog.button }}</button></footer></form></section>
      <section v-else-if="addDialog" class="modal add-modal" role="dialog" aria-modal="true" aria-labelledby="add-title"><header><div><h2 id="add-title">{{ t('app.addWindows') }}</h2></div><button class="icon-button" :aria-label="t('app.closeDialog')" @click="addDialog = false"><Icon name="close" /></button></header><label>{{ t('app.targetCanvas') }}<select v-model="addTarget"><option v-for="canvas in canvases" :key="canvas.id" :value="canvas.id">{{ canvas.name }}</option><option value="">{{ t('app.newMyCanvas') }}</option></select></label><div class="search-field"><Icon name="search" :size="16" /><input v-model="addSearch" :aria-label="t('app.searchWindows')" :placeholder="t('app.searchPlaceholder')" /></div><WindowPickerTree v-model:selected="selectedWindows" :sources="sources" :resources="resources" :query="addSearch" :existing="existingAddWindows" /><p v-if="dialogError" class="form-error">{{ dialogError }}</p><footer><span class="selection-count">{{ t('app.selectedWindows', selectedAddWindows.length) }}</span><button class="button primary" :disabled="busy || !selectedAddWindows.length" @click="submitAdd">{{ t('app.addToCanvas') }}<Icon name="arrow" :size="16" /></button></footer></section>
      <section v-else-if="windowMenu" class="modal window-menu" role="dialog" aria-modal="true" aria-labelledby="window-title"><header><h2 id="window-title">{{ windowMenu.name }}</h2><button class="icon-button" :aria-label="t('app.closeDialog')" @click="windowMenu = null"><Icon name="close" /></button></header><button v-if="mobile" @click="windowMenu = null; openSettings()"><Icon name="canvas" />{{ t('common.settings') }}</button><button v-if="mobile && !isOverview && windowMenu.node.id" :disabled="!terminalData(windowMenu.node).available" @click="terminalData(windowMenu.node).newTab?.create(); windowMenu = null"><Icon name="plus" />{{ t('app.newTab') }}</button><button v-if="copiedFile" :title="t('fileTransfer.pasteNamed', { name: copiedFile.filename })" :disabled="!hasLiveTerminal(windowMenu.node.sourceId, windowMenu.node.windowId)" @click="pasteFileIntoWindow(windowMenu.node.sourceId, windowMenu.node.windowId); windowMenu = null"><Icon name="file" />{{ t('fileTransfer.paste') }}</button><button :disabled="!hasLiveTerminal(windowMenu.node.sourceId, windowMenu.node.windowId)" @click="scanWindowContent(windowMenu.node, windowMenu.name)"><Icon name="search" />{{ t('panels.scan.title') }}</button><button @click="openAdd(windowMenu.node); windowMenu = null"><Icon name="plus" />{{ t('app.addToOtherCanvas') }}</button><button @click="windowAction(windowMenu.node, 'rename')"><Icon name="edit" />{{ t('app.renameWindow') }}</button><button class="danger-text" @click="windowAction(windowMenu.node, 'close')"><Icon name="trash" />{{ t('app.closeWindow') }}</button></section>
    </div>
    <div v-if="error || success" class="toast" :class="{ 'error-toast': error }" role="status"><Icon :name="error ? 'info' : 'check'" :size="17" /><span>{{ error || success }}</span><button class="icon-button" :aria-label="t('app.closeNotification')" @click="error = ''; success = ''"><Icon name="close" :size="15" /></button></div>
  </div>
  </UApp>
</template>
