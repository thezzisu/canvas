<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { VueFlow, useVueFlow, type Node } from '@vue-flow/core'
import { useActiveElement, useStorage } from '@vueuse/core'
import { MiniMap } from '@vue-flow/minimap'
import UApp from '@nuxt/ui/components/App.vue'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import { zh_cn } from '@nuxt/ui/locale'
import Icon from './components/Icon.vue'
import TerminalNode from './components/TerminalNode.vue'
import NoteNode from './components/NoteNode.vue'
import FileNode from './components/FileNode.vue'
import { downloadPreview, setDownloadContext } from './downloads'
import { isTerminalNode } from './types'
import GroupNode from './components/GroupNode.vue'
import BackgroundDialog from './components/BackgroundDialog.vue'
import DirectoryDialog from './components/DirectoryDialog.vue'
import DownloadPreviewDialog from './components/DownloadPreviewDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import { directoryRequest } from './directories'
import { api, segment, uuid, write } from './api'
import { clearTerminals, setContentFont } from './terminals'
import { buildFontPresentation, ensureContentFont } from './fonts'
import type { GlobalSettings } from '../../shared/settings'
import { useCanvasNavigation } from './canvas-navigation'
import { useMobileLayout } from './mobile-layout'
import { canvasFrame, preserveCanvasCenter, useMobileViewport, type CanvasFrame } from './viewport'
import { statusColor, statusLabel } from './status'
import { overviewResources, overviewLayoutKey, overviewStatuses, type OverviewInteraction, type OverviewOrder } from './overview'
import { adjacentPage, pageViewport, retainPage, type OverviewPage, type PageDirection } from './overview-paging'
import type { ProgramStatus } from '../../shared/status'
import type { Canvas, CanvasNode, FileData, NoteData, NotePatch, SharedState, Source, SourceResource, TerminalCanvasNode, TerminalData, WindowSize } from './types'

const { fitView, zoomIn, zoomOut, setViewport, getViewport, getNodesInitialized } = useVueFlow()
const mobile = useMobileLayout()
const { viewport: visibleViewport, style: mobileViewportStyle } = useMobileViewport(mobile)
const sidebarOpen = ref(false)
const focusViewportElement = ref<HTMLElement>()
let focusObserver: ResizeObserver | undefined
let cameraObserver: ResizeObserver | undefined
let cameraFrame: CanvasFrame | undefined
let cameraResize = 0
const ready = ref(false)
const authenticated = ref(false)
const username = ref('')
const password = ref('')
const busy = ref(false)
const loginError = ref('')
const error = ref('')
const success = ref('')
const sources = ref<Source[]>([])
const resources = ref<SourceResource[]>([])
const canvases = ref<Canvas[]>([])
const windowSizes = ref<Record<string, WindowSize>>({})
const overviewBackground = ref<Canvas['background']>(null)
const activeId = ref('overview')
const nodes = shallowRef<Node[]>([])
const graphKey = ref(0)
const refreshedAt = ref('')
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
const actionDialog = ref<{ title: string; description: string; label?: string; value: string; danger?: boolean; button: string; submit: (value: string) => Promise<void> } | null>(null)
const addDialog = ref(false)
const addTarget = ref('')
const addSearch = ref('')
const selectedWindows = ref<string[]>([])
const windowMenu = ref<{ node: TerminalCanvasNode; name: string } | null>(null)
const focused = ref<TerminalCanvasNode | null>(null)
const focusedSize = reactive({ width: mobile.value ? visibleViewport.value.width : window.innerWidth - 32, height: mobile.value ? visibleViewport.value.height : window.innerHeight - 32 })
type WindowGeometry = { ratio: number; insetX: number; insetY: number }
const windowGeometry = reactive(new Map<string, WindowGeometry>())
let geometryFrame = 0
const saveState = ref('')
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
let stateEvents: EventSource | undefined
let noticeTimer: ReturnType<typeof setTimeout>
let resourceSignature = ''
let resourceLayoutSignature = ''
let resourceRequest: Promise<void> | undefined
let pendingViewport = ''
let viewportRequest = 0
const currentCanvas = computed(() => canvases.value.find(canvas => canvas.id === activeId.value))
const isOverview = computed(() => activeId.value === 'overview')
const overviewPaged = ref(false)
const paging = computed(() => isOverview.value && overviewPaged.value)
const currentPage = shallowRef<OverviewPage>()
const pages = computed<OverviewPage[]>(() => nodes.value.filter(node => node.type === 'terminal').map(node => ({
  id: `${node.data.sourceId}/${node.data.windowId}`, row: `${node.data.sourceId}/${node.data.spaceId}`,
  ...node.position, width: node.data.width, height: node.data.height,
})))
const pageLayout = computed(() => paging.value ? JSON.stringify(pages.value) : '')
const pageDirections = [
  { direction: 'left', key: 'ArrowLeft', label: '上一个窗口', icon: 'chevron', rotation: 'rotate(180deg)' },
  { direction: 'up', key: 'ArrowUp', label: '上一个 Space', icon: 'down', rotation: 'rotate(180deg)' },
  { direction: 'down', key: 'ArrowDown', label: '下一个 Space', icon: 'down', rotation: '' },
  { direction: 'right', key: 'ArrowRight', label: '下一个窗口', icon: 'chevron', rotation: '' },
] as const
function pageNeighbor(direction: PageDirection) { return adjacentPage(pages.value, currentPage.value?.id || '', direction) }
async function fitPage(animate = false) {
  resetPagingFeedback()
  const frame = graphSurface.value
  if (!paging.value || focused.value || !frame?.clientWidth || !frame.clientHeight) return
  const page = retainPage(pages.value, currentPage.value?.id || '', currentPage.value, getViewport(), { width: frame.clientWidth, height: frame.clientHeight })
  currentPage.value = page
  if (!page) return
  const duration = animate && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 200 : 0
  const transition = setViewport(pageViewport(page, { width: frame.clientWidth, height: frame.clientHeight }), {
    duration, interpolate: 'linear', ease: value => 1 - (1 - value) ** 3,
  })
  // VueFlow does not resolve an interrupted animation. Only immediate camera
  // writes can be awaited by mode/fullscreen lifecycle code.
  if (!duration) await transition
}
function movePage(direction: PageDirection) {
  if (!paging.value || focused.value) return
  const page = pageNeighbor(direction)
  if (!page) return
  if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.terminal-host')) document.activeElement.blur()
  currentPage.value = page
  void fitPage(true)
}
async function togglePaging() {
  resetPagingFeedback()
  if (!overviewPaged.value) saveViewport()
  overviewPaged.value = !overviewPaged.value
  await nextTick()
  if (paging.value) await fitPage(true)
  else await restoreViewport()
}
function guardPageDrag(event: MouseEvent) {
  if (paging.value && event.button === 1 && !(event.target as Element)?.closest('.terminal-host')) {
    event.preventDefault(); event.stopPropagation()
  }
}
function fitCanvas() { if (paging.value) void fitPage(true); else void fitView({ padding: .14, maxZoom: 1, duration: 200 }) }

const overviewSelected = useStorage<ProgramStatus[]>('canvas:overview:statuses', [...overviewStatuses])
const overviewOrder = useStorage<OverviewOrder>('canvas:overview:order', 'native')
const overviewMenuOpen = ref(false)
const overviewFiltered = computed(() => overviewSelected.value.length !== overviewStatuses.length)
const overviewChanged = computed(() => overviewFiltered.value || overviewOrder.value !== 'native')
const activeElement = useActiveElement({ triggerOnRemoval: true })
const overviewInteraction = computed<OverviewInteraction | undefined>(() => {
  if (!isOverview.value) return
  if (focused.value) return { sourceId: focused.value.sourceId, windowId: focused.value.windowId }
  const card = activeElement.value?.closest<HTMLElement>('.terminal-card')
  if (card?.dataset.sourceId && card.dataset.windowId) return { sourceId: card.dataset.sourceId, windowId: card.dataset.windowId }
})
const visibleOverview = computed(() => overviewResources(resources.value, overviewSelected.value, overviewOrder.value, overviewInteraction.value))
const visibleOverviewCount = computed(() => visibleOverview.value.reduce((total, source) => total + source.spaces.reduce((sum, space) => sum + space.windows.length, 0), 0))
function resetOverview() { overviewSelected.value = [...overviewStatuses]; overviewOrder.value = 'native' }
const overviewMenu = computed<DropdownMenuItem[][]>(() => [
  [{ type: 'label', label: '状态' },
    { type: 'checkbox', label: '全部状态', checked: !overviewFiltered.value, onSelect: event => event.preventDefault(), onUpdateChecked: checked => { overviewSelected.value = checked ? [...overviewStatuses] : [] } },
    ...overviewStatuses.map(status => ({ type: 'checkbox' as const, label: statusLabel(status), status, checked: overviewSelected.value.includes(status),
      onSelect: (event: Event) => event.preventDefault(), onUpdateChecked: (checked: boolean) => { overviewSelected.value = checked ? [...overviewSelected.value, status] : overviewSelected.value.filter(value => value !== status) } })),
  ],
  [{ type: 'label', label: '排序' }, ...(['native', 'status'] as const).map(order => ({ type: 'checkbox' as const,
    label: order === 'native' ? '原始顺序' : '状态优先', checked: overviewOrder.value === order, onSelect: (event: Event) => event.preventDefault(), onUpdateChecked: () => { overviewOrder.value = order } })),
  ],
  [{ label: '恢复默认', disabled: !overviewChanged.value, onSelect: resetOverview }],
])
const currentName = computed(() => isOverview.value ? '总览' : currentCanvas.value?.name || '画布')
const allWindows = computed(() => resources.value.flatMap(source => source.spaces.flatMap(space => space.windows.map(window => ({ source, space, window, key: `${source.id}/${space.id}/${window.id}` })))))
const windowCount = computed(() => allWindows.value.length)
const onlineCount = computed(() => resources.value.filter(source => !source.error && !['offline', 'error', 'disconnected'].includes(source.status)).length)
const filteredWindows = computed(() => allWindows.value.filter(item => `${item.source.name} ${item.space.name} ${item.window.name}`.toLowerCase().includes(addSearch.value.toLowerCase())))
const modalOpen = computed(() => sourceDialog.value || canvasDialog.value || actionDialog.value || addDialog.value || windowMenu.value || backgroundCanvas.value || settingsDialog.value)
const { surface: graphSurface, app: appElement, fullscreen: canvasFullscreen, resetPagingFeedback, wheel: canvasWheel, touchStart: canvasTouchStart, touchMove: canvasTouchMove, touchEnd: canvasTouchEnd, touchCancel: canvasTouchCancel, click: canvasClick, toggleFullscreen, exitFullscreen } = useCanvasNavigation({
  getCanvasId: () => activeId.value, getViewport, setViewport, saveViewport,
  blocked: () => overviewMenuOpen.value || !!modalOpen.value || !!directoryRequest.value || !!downloadPreview.value || !!focused.value || (mobile.value && (sidebarOpen.value || sourcePanel.value)),
  mobile: () => mobile.value,
  paging: { enabled: () => paging.value, canMove: direction => !!pageNeighbor(direction), move: movePage, recenter: fitPage },
  beforeFullscreen: () => { sourcePanel.value = false; sidebarOpen.value = false; canvasMenu.value = false },
})
const currentBackground = computed(() => isOverview.value ? overviewBackground.value : currentCanvas.value?.background)
const canvasCounts = computed(() => {
  if (isOverview.value) return overviewFiltered.value ? `${visibleOverviewCount.value} / ${windowCount.value} 个窗口` : `${sources.value.length} 个连接 · ${windowCount.value} 个窗口`
  const items = currentCanvas.value?.nodes || []
  const notes = items.filter(node => node.type === 'note').length
  const files = items.filter(node => node.type === 'file').length
  const windows = items.filter(isTerminalNode).length
  return [windows && `${windows} 个窗口`, notes && `${notes} 个便签`, files && `${files} 个文件`].filter(Boolean).join(' · ') || '空画布'
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
  })
}

function notify(message: string) { success.value = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { success.value = '' }, 3500) }
function showError(reason: unknown) { error.value = reason instanceof Error ? reason.message : String(reason) }
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
  return { ...node, name: found.window?.name || '已关闭的窗口', subtitle: `${found.source?.name || sourceConfig?.name || '未知连接'} / ${found.space?.name || 'space'}`, available: !!found.window && !found.source?.error, status: found.window?.status || 'unknown', panes: found.window?.panes || [], overview, focus: false, mobile: mobile.value, onAction: terminalAction, onResize: resizeNode, onLayoutStart: layoutStarted, onGeometry: recordGeometry }
}
function terminalFlowNode(node: TerminalCanvasNode, overview = false): Node {
  node = { ...node, ...windowSize(node) }
  node.height = windowHeight(node)
  return { id: node.id, type: 'terminal', position: { x: node.x, y: node.y }, data: terminalData(node, overview), style: { width: `${node.width}px`, height: `${node.height}px` }, draggable: !overview && !mobile.value, selectable: !mobile.value, dragHandle: '.drag-handle' }
}
function flowNode(node: CanvasNode): Node {
  if (isTerminalNode(node)) return terminalFlowNode(node)
  if (node.type === 'file') {
    const data: FileData = { ...node, onResize: resizeNode, onLayoutStart: layoutStarted, onRemove: removeFile }
    return { id: node.id, type: 'file', position: { x: node.x, y: node.y }, data,
      style: { width: `${node.width}px`, height: `${node.height}px` },
      draggable: !mobile.value, selectable: !mobile.value, dragHandle: '.drag-handle' }
  }
  const canvasId = activeId.value
  const data: NoteData = { ...node, onResize: resizeNode, onLayoutStart: layoutStarted,
    onChange: (id, patch) => editNote(canvasId, id, patch), onFlush: () => void flushNotes(canvasId),
    onAction: (action, id) => { if (action === 'remove') removeNote(id) } }
  return { id: node.id, type: 'note', position: { x: node.x, y: node.y }, data,
    style: { width: `${node.width}px`, height: `${node.minimized ? 30 : node.height}px` },
    draggable: !mobile.value, selectable: !mobile.value, dragHandle: '.drag-handle' }
}
function overviewNodes(): Node[] {
  const result: Node[] = []
  const machines = new Map<string, SourceResource[]>()
  for (const source of visibleOverview.value) {
    const config = sources.value.find(item => item.id === source.id)
    if (!config) continue
    const host = config.transport === 'local' ? 'local' : config.target!
    machines.set(host, [...(machines.get(host) || []), source])
  }
  let y = 0
  for (const [host, machineSources] of machines) {
    const rowWidth = (source: SourceResource, space: SourceResource['spaces'][number]) => space.windows.reduce((sum, window) => sum + windowSize({ sourceId: source.id, windowId: window.id }).width + 16, 0)
    const width = Math.max(528, ...machineSources.flatMap(source => source.spaces.map(space => rowWidth(source, space) + 32)))
    const count = machineSources.reduce((total, source) => total + source.spaces.reduce((sum, space) => sum + space.windows.length, 0), 0)
    const rows = machineSources.flatMap(source => source.spaces.map(space => ({ source, space, height: space.windows.length ? 54 + Math.max(...space.windows.map(window => windowHeight({ sourceId: source.id, windowId: window.id, ...windowSize({ sourceId: source.id, windowId: window.id }) }))) : 66 })))
    const height = Math.max(132, 78 + rows.reduce((sum, row) => sum + row.height, 0))
    result.push({ id: `machine:${host}`, type: 'group', position: { x: 0, y }, data: { kind: 'machine', name: host === 'local' ? '本机' : host.replace(/^ssh:\/\//, ''), subtitle: host === 'local' ? 'LOCAL' : 'SSH', count, width, height }, draggable: false, selectable: false, style: { width: `${width}px`, height: `${height}px`, zIndex: '-1', pointerEvents: 'none' } })
    let rowY = y + 68
    for (const { source, space, height: rowHeight } of rows) {
      result.push({ id: `space:${source.id}:${space.id}`, type: 'group', position: { x: 24, y: rowY }, data: { kind: 'space', name: space.name, subtitle: source.name, count: space.windows.length }, draggable: false, selectable: false, style: { width: `${width - 48}px`, pointerEvents: 'none' } })
      let windowX = 24
      for (const window of space.windows) {
        const target = { sourceId: source.id, windowId: window.id }
        result.push(terminalFlowNode({ type: 'terminal', id: `window:${source.id}:${space.id}:${window.id}`, ...target, spaceId: space.id, x: windowX, y: rowY + 34, ...windowSize(target) }, true))
        windowX += windowSize(target).width + 16
      }
      rowY += rowHeight
    }
    y += height + 48
  }
  return result
}
function rebuildNodes() {
  const previous = new Map(nodes.value.map(node => [node.id, node as Node & { selected?: boolean }]))
  nodes.value = (isOverview.value ? overviewNodes() : (currentCanvas.value?.nodes || []).map(flowNode)).map(node => ({ ...node, selected: previous.get(node.id)?.selected }))
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
  if (!isOverview.value && !currentCanvas.value) switchCanvas('overview')
  else {
    if (!isOverview.value && focused.value && !currentCanvas.value?.nodes.some(node => node.id === focused.value?.id)) void closeFocus()
    if (!layoutGesture && (sizesChanged || previousNodes !== JSON.stringify(currentCanvas.value?.nodes))) rebuildNodes()
  }
  if (backgroundCanvas.value && backgroundCanvas.value.id !== 'overview' && !canvases.value.some(canvas => canvas.id === backgroundCanvas.value?.id)) backgroundCanvas.value = null
  if (sourceChanged) {
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
  const events = new EventSource('/api/events')
  stateEvents = events
  events.addEventListener('state', event => {
    if (events !== stateEvents) return
    try { applySharedState(JSON.parse((event as MessageEvent).data)) } catch { /* A reconnect sends a complete snapshot. */ }
  })
  events.addEventListener('unauthorized', unauthorized)
}
async function restoreViewport() {
  const id = activeId.value
  const request = ++viewportRequest
  pendingViewport = id
  await nextTick()
  if (paging.value) { pendingViewport = ''; await fitPage(); return }
  const initialized = new Set(getNodesInitialized.value.map(node => node.id))
  if (!nodes.value.length || nodes.value.some(node => !initialized.has(node.id))) return
  const stored = localStorage.getItem(`canvas:viewport:${id}`)
  let restored = false
  if (stored) {
    try {
      const saved = JSON.parse(stored)
      const frame = canvasFrame(graphSurface.value)
      const viewport = mobile.value && frame ? preserveCanvasCenter(saved, saved.frame, frame) : saved
      restored = await setViewport(viewport)
    } catch {}
  }
  if (!restored) await fitView({ padding: .14, maxZoom: 1, duration: 0 })
  if (request === viewportRequest && id === activeId.value) {
    pendingViewport = ''
    cameraFrame = canvasFrame(graphSurface.value)
    if (mobile.value) saveViewport()
  }
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
function nodesInitialized() {
  if (pendingViewport === activeId.value) void restoreViewport()
  // VueFlow mounts new node components after its own node-store update.
  // Waiting for that mount keeps focus from falling back to the document body.
  void nextTick().then(() => focusNewNote())
}
function saveViewport() {
  if (paging.value || pendingViewport || (mobile.value && focused.value)) return
  const frame = mobile.value ? canvasFrame(graphSurface.value) : undefined
  if (mobile.value && (!frame || (cameraFrame && Math.abs(cameraFrame.layoutWidth - frame.layoutWidth) >= 1))) {
    // VueFlow may publish a move-end while the viewport is resizing. Keep the
    // old frame until the camera has been translated into the settled layout.
    queueCameraResize()
    return
  }
  if (frame) cameraFrame = frame
  localStorage.setItem(`canvas:viewport:${activeId.value}`, JSON.stringify({ ...getViewport(), ...(frame ? { frame } : {}) }))
}

async function refreshResources(silent = false): Promise<void> {
  if (resourceRequest) {
    if (silent) return
    await resourceRequest
    return refreshResources()
  }
  if (!authenticated.value) return
  loading.value = !silent
  resourceRequest = (async () => {
    try {
      const body = await api<{ sources: SourceResource[] }>('/api/resources')
      const signature = JSON.stringify(body.sources)
      if (signature !== resourceSignature) {
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
      refreshedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    } catch (reason) { if (!silent) showError(reason) }
    finally { loading.value = false; resourceRequest = undefined }
  })()
  return resourceRequest
}
async function load() {
  await syncState()
  await fontApplication
  await refreshResources()
  rebuildNodes()
  await restoreViewport()
  startStateEvents()
}
async function login() {
  busy.value = true; loginError.value = ''
  try { await write('/api/login', 'POST', { username: username.value, password: password.value }); password.value = ''; authenticated.value = true; await load() }
  catch (reason) { loginError.value = reason instanceof Error ? reason.message : '登录失败' }
  finally { busy.value = false }
}
async function logout() {
  await flushNotes()
  if (pendingNotes.size || savingNotes.size) return
  await exitFullscreen()
  await write('/api/logout', 'POST'); unauthorized()
}
function unauthorized() { void exitFullscreen(); stopStateEvents(); for (const timer of saveTimers.values()) clearTimeout(timer); saveTimers.clear(); pendingLayouts.clear(); clearNoteEdits(); authenticated.value = false; focused.value = null; settingsDialog.value = false; settings.value = null; fontRevision++; fontSignature = ''; fontLoading.value = false; latestState = undefined; clearTerminals() }
watch(pageLayout, async () => { if (paging.value) { await nextTick(); await fitPage() } })
watch(overviewInteraction, () => { if (isOverview.value) rebuildNodes() })
watch([overviewSelected, overviewOrder], async () => { if (isOverview.value) { rebuildNodes(); await nextTick(); if (paging.value) await fitPage(); else void fitView({ padding: .14, maxZoom: 1, duration: 150 }) } })
watch(activeId, async () => { overviewMenuOpen.value = false; layoutGesture = ''; focused.value = null; canvasMenu.value = false; saveState.value = ''; rebuildNodes(); await restoreViewport() })
function switchCanvas(id: string) { sidebarOpen.value = false; void flushNotes(activeId.value); saveViewport(); activeId.value = id }
function backgroundSaved(_updated: Canvas) { void syncState().catch(showError) }
function openSettings() { sidebarOpen.value = false; canvasMenu.value = false; sourcePanel.value = false; settingsDialog.value = true }
function settingsSaved(_settings: GlobalSettings) { void syncState().catch(showError) }
function openBackground() { canvasMenu.value = false; backgroundCanvas.value = isOverview.value ? { id: 'overview', name: '总览', nodes: [], background: overviewBackground.value } : currentCanvas.value || null }
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
  actionDialog.value = { title: `删除「${canvas.name}」`, description: '删除画布及便签，保留终端窗口。', value: '', danger: true, button: '删除画布', submit: async () => { clearTimeout(saveTimers.get(canvas.id)); saveTimers.delete(canvas.id); pendingLayouts.delete(canvas.id); clearNoteEdits(canvas.id); await write(`/api/canvases/${segment(canvas.id)}`, 'DELETE'); await syncState(); switchCanvas('overview') } }
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
    if (body.transport === 'ssh' && !body.target) throw new Error('请输入 SSH 地址')
    if (body.id) {
      await write<Source>(`/api/sources/${segment(body.id)}`, 'PATCH', body)
    } else { const { id, ...newSource } = body; await write<Source>('/api/sources', 'POST', newSource) }
    await syncState()
    sourceDialog.value = false; resourceSignature = ''; await refreshResources(); await restoreViewport(); notify('连接已保存')
  } catch (reason) { dialogError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
function deleteSource(source: Source) {
  actionDialog.value = { title: `移除「${source.name}」`, description: '移除连接，保留运行中的会话。', value: '', danger: true, button: '移除连接', submit: async () => { await write(`/api/sources/${segment(source.id)}`, 'DELETE'); await syncState(); await refreshResources() } }
}
function basePath(sourceId: string) { return `/api/sources/${segment(sourceId)}` }
function spaceAction(source: SourceResource, spaceId: string | undefined, operation: 'create' | 'rename' | 'close') {
  const space = source.spaces.find(item => item.id === spaceId)
  const noun = 'space'
  const actionName = operation === 'create' ? '新建' : operation === 'rename' ? '重命名' : '关闭'
  actionDialog.value = { title: `${actionName} ${noun}`, description: operation === 'close' ? `将关闭「${space?.name}」及其中运行的窗口。` : source.name, label: operation === 'close' ? undefined : '名称', value: operation === 'rename' ? space?.name || '' : '', danger: operation === 'close', button: `${actionName} ${noun}`, submit: async name => { await write(`${basePath(source.id)}/spaces${spaceId ? `/${segment(spaceId)}` : ''}`, operation === 'create' ? 'POST' : operation === 'rename' ? 'PATCH' : 'DELETE', operation === 'close' ? undefined : { name }); await refreshResources() } }
}
function windowAction(node: TerminalCanvasNode, operation: 'create' | 'rename' | 'close') {
  const { source, space, window } = resourceFor(node)
  const actionName = operation === 'create' ? '新建' : operation === 'rename' ? '重命名' : '关闭'
  windowMenu.value = null
  actionDialog.value = { title: `${actionName}窗口`, description: operation === 'close' ? `将结束「${window?.name}」及其所有 pane 中的进程。` : `${source?.name || ''} / ${space?.name || ''}`, label: operation === 'close' ? undefined : '窗口名称', value: operation === 'rename' ? window?.name || '' : '', danger: operation === 'close', button: `${actionName}窗口`, submit: async name => { await write(`${basePath(node.sourceId)}/spaces/${segment(node.spaceId)}/windows${operation === 'create' ? '' : `/${segment(node.windowId)}`}`, operation === 'create' ? 'POST' : operation === 'rename' ? 'PATCH' : 'DELETE', operation === 'close' ? undefined : { name }); await refreshResources() } }
}
async function submitAction() {
  const dialog = actionDialog.value
  if (!dialog) return
  busy.value = true; dialogError.value = ''
  try { await dialog.submit(dialog.value.trim()); actionDialog.value = null }
  catch (reason) { dialogError.value = reason instanceof Error ? reason.message : String(reason) }
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
  else if (action === 'focus') { sidebarOpen.value = false; sourcePanel.value = false; windowResize(); saveViewport(); focused.value = node }
  else if (action === 'unfocus') void closeFocus()
  else if (action === 'menu') windowMenu.value = { node, name: resourceFor(node).window?.name || '窗口' }
}
async function closeFocus() {
  if (document.activeElement instanceof HTMLElement && focusViewportElement.value?.contains(document.activeElement)) document.activeElement.blur()
  focused.value = null; graphKey.value++; await nextTick(); await restoreViewport()
}
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
  addTarget.value = currentCanvas.value?.id || canvases.value[0]?.id || ''
  selectedWindows.value = node ? [`${node.sourceId}/${node.spaceId}/${node.windowId}`] : []
  addSearch.value = ''; addDialog.value = true; dialogError.value = ''
}
function toggleSelection(key: string) { selectedWindows.value = selectedWindows.value.includes(key) ? selectedWindows.value.filter(item => item !== key) : [...selectedWindows.value, key] }
async function submitAdd() {
  busy.value = true; dialogError.value = ''
  try {
    let canvas = canvases.value.find(item => item.id === addTarget.value)
    if (!canvas) { canvas = await write<Canvas>('/api/canvases', 'POST', { name: '我的画布', nodes: [] }); canvas.nodes ||= [] }
    let index = canvas.nodes.length
    const chosen = allWindows.value.filter(item => selectedWindows.value.includes(item.key))
    const additions: CanvasNode[] = []
    for (const item of chosen) {
      if (canvas.nodes.some(node => isTerminalNode(node) && node.sourceId === item.source.id && node.windowId === item.window.id)) continue
      additions.push({ type: 'terminal', id: uuid(), sourceId: item.source.id, spaceId: item.space.id, windowId: item.window.id, x: (index % 3) * 580, y: Math.floor(index / 3) * 390, width: 552, height: 352 }); index++
    }
    await write(`/api/canvases/${segment(canvas.id)}/nodes`, 'POST', { nodes: additions })
    await syncState()
    addDialog.value = false; switchCanvas(canvas.id); rebuildNodes(); void fitView({ padding: .15, maxZoom: 1, duration: 200 }); notify(`已加入「${canvas.name}」`)
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
    saveState.value = '正在保存…'
    nodes.value = nodes.value.map(flow => flow.id === id ? { ...flow, data: { ...flow.data, ...changed }, style: changed.minimized === undefined ? flow.style : { ...flow.style, height: `${changed.minimized ? 30 : node.height}px` } } : flow)
  }
}
async function flushNotes(canvasId?: string): Promise<void> {
  if (noteSave) { await noteSave; if ([...pendingNotes.values()].some(edit => !canvasId || edit.canvasId === canvasId)) return flushNotes(canvasId); return }
  const batch = [...pendingNotes.entries()].filter(([, edit]) => !canvasId || edit.canvasId === canvasId)
  if (!batch.length) return
  for (const [key, edit] of batch) {
    clearTimeout(noteTimers.get(key)); noteTimers.delete(key); pendingNotes.delete(key); savingNotes.set(key, edit)
  }
  noteSave = (async () => {
    let failed = false
    for (const [key, edit] of batch) {
      try {
        await write(`/api/canvases/${segment(edit.canvasId)}/notes/${segment(edit.id)}`, 'PATCH', edit.patch)
        if (savingNotes.get(key) === edit) savingNotes.delete(key)
      } catch (reason) {
        failed = true
        if (savingNotes.get(key) === edit) {
          savingNotes.delete(key)
          if (canvases.value.find(canvas => canvas.id === edit.canvasId)?.nodes.some(node => node.id === edit.id)) pendingNotes.set(key, { ...edit, patch: { ...edit.patch, ...pendingNotes.get(key)?.patch } })
        }
        showError(reason)
      }
    }
    await syncState().catch(showError)
    if (!canvasId || activeId.value === canvasId) saveState.value = failed ? '保存失败' : '已保存'
  })()
  try { await noteSave } finally { noteSave = undefined }
}
function scheduleSave() {
  const canvas = currentCanvas.value
  if (!canvas) return
  clearTimeout(saveTimers.get(canvas.id)); saveState.value = '正在保存…'
  saveTimers.set(canvas.id, setTimeout(async () => {
    saveTimers.delete(canvas.id)
    const batch = new Map(pendingLayouts.get(canvas.id))
    if (!batch.size) return
    try {
      await write(`/api/canvases/${segment(canvas.id)}/layout`, 'PATCH', { nodes: [...batch].map(([id, patch]) => ({ id, ...patch })) })
      const pending = pendingLayouts.get(canvas.id)
      for (const [id, patch] of batch) if (pending?.get(id) === patch) pending.delete(id)
      if (!pending?.size) pendingLayouts.delete(canvas.id)
      await syncState()
      if (activeId.value === canvas.id) saveState.value = '已保存'
    }
    catch (reason) { if (activeId.value === canvas.id) saveState.value = '保存失败'; showError(reason) }
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
  actionDialog.value = { title: `删除「${node.asset.filename}」`, description: '文件将从画布中移除。', value: '', danger: true, button: '删除文件', submit: async () => { await removeNode(id) } }
}
function removeNote(id: string) {
  const node = currentCanvas.value?.nodes.find(item => item.id === id)
  if (!node || node.type !== 'note') return
  if (!node.content.trim()) { void removeNode(id); return }
  actionDialog.value = { title: `删除「${node.title || '便签'}」`, description: '', value: '', danger: true, button: '删除便签', submit: async () => { await removeNode(id) } }
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
  if (directoryRequest.value) return
  if (downloadPreview.value) return
  if (backgroundCanvas.value) return
  if (settingsDialog.value) return
  if ((event.target as HTMLElement)?.closest('.xterm, .note-card input, .note-card textarea') && !modalOpen.value) return
  if (paging.value && !focused.value && !modalOpen.value && !overviewMenuOpen.value && !canvasMenu.value && !sidebarOpen.value && !sourcePanel.value &&
      !event.ctrlKey && !event.altKey && !event.metaKey && !(event.target as HTMLElement)?.closest('input, textarea, select, button, a, [contenteditable="true"]')) {
    const direction = pageDirections.find(item => item.key === event.key)?.direction
    if (direction) { event.preventDefault(); if (!event.repeat) movePage(direction); return }
  }
  if (event.key === 'Escape') {
    if (sidebarOpen.value) sidebarOpen.value = false
    else if (canvasMenu.value) { canvasMenu.value = false; canvasMenuElement.value?.querySelector<HTMLButtonElement>('.canvas-menu-trigger')?.focus() }
    else if (windowMenu.value) windowMenu.value = null
    else if (actionDialog.value) actionDialog.value = null
    else if (sourceDialog.value) sourceDialog.value = false
    else if (canvasDialog.value) canvasDialog.value = false
    else if (addDialog.value) addDialog.value = false
    else if (focused.value) void closeFocus()
    else sourcePanel.value = false
  }
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
    return
  }
  const element = focusViewportElement.value
  if (!element) {
    focusedSize.width = visibleViewport.value.width; focusedSize.height = visibleViewport.value.height
    return
  }
  const style = getComputedStyle(element)
  focusedSize.width = Math.max(1, element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
  focusedSize.height = Math.max(1, element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
}
function queueCameraResize() {
  cancelAnimationFrame(cameraResize)
  cameraResize = requestAnimationFrame(() => {
    if (paging.value) { void fitPage(); return }
    if (!mobile.value || focused.value || pendingViewport) return
    const frame = canvasFrame(graphSurface.value)
    if (!frame) return
    const previous = cameraFrame
    cameraFrame = frame
    const current = getViewport()
    const next = preserveCanvasCenter(current, previous, frame)
    if (next !== current) {
      const id = activeId.value
      void setViewport(next).then(() => { if (id === activeId.value && !focused.value) saveViewport() })
    }
  })
}
watch([focusViewportElement, mobile], async () => {
  focusObserver?.disconnect()
  if (focusViewportElement.value && mobile.value) {
    focusObserver = new ResizeObserver(windowResize)
    focusObserver.observe(focusViewportElement.value)
  }
  await nextTick(); windowResize()
})
watch(graphSurface, element => {
  cameraObserver?.disconnect()
  if (element) {
    cameraObserver = new ResizeObserver(queueCameraResize)
    cameraObserver.observe(element)
  }
})
watch(visibleViewport, () => { if (mobile.value) void nextTick(windowResize) })
watch(mobile, () => { sidebarOpen.value = false; canvasTouchCancel(); rebuildNodes() })
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
  window.addEventListener('canvas:unauthorized', unauthorized)
  window.addEventListener('keydown', keydown)
  window.addEventListener('resize', windowResize)
  window.addEventListener('beforeunload', beforeUnload)
  document.addEventListener('pointerdown', outsideCanvasMenu)
  try { const session = await api<{ authenticated: boolean; username?: string }>('/api/session'); authenticated.value = session.authenticated; username.value = session.username || ''; if (authenticated.value) await load() }
  catch (reason) { showError(reason) }
  finally { ready.value = true }
  refreshTimer = setInterval(() => { void refreshResources(true) }, 2000)
})
onBeforeUnmount(() => { fontRevision++; focusObserver?.disconnect(); cameraObserver?.disconnect(); cancelAnimationFrame(cameraResize); setDownloadContext(); stopStateEvents(); cancelAnimationFrame(geometryFrame); clearInterval(refreshTimer); for (const timer of saveTimers.values()) clearTimeout(timer); clearTimeout(noticeTimer); for (const timer of noteTimers.values()) clearTimeout(timer); clearTerminals(); window.removeEventListener('canvas:unauthorized', unauthorized); window.removeEventListener('keydown', keydown); window.removeEventListener('resize', windowResize); window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('pointerdown', outsideCanvasMenu) })
</script>

<template>
  <UApp :locale="zh_cn" :portal="appElement || false" :toaster="null">
  <div v-if="!ready" class="boot-screen"><span class="spinner" />加载中…</div>
  <div v-else-if="!authenticated" class="login-screen" :class="{ 'mobile-layout': mobile }" :style="mobileViewportStyle">
    <main class="login-content">
      <div class="brand login-brand"><span class="brand-symbol"><Icon name="canvas" :size="27" /></span><span>canvas</span></div>
      <form class="login-form" @submit.prevent="login">
        <label>用户名<input v-model="username" name="username" autocomplete="username" required autofocus /></label>
        <label>密码<input v-model="password" name="password" type="password" autocomplete="current-password" required /></label>
        <p v-if="loginError" class="form-error" role="alert">{{ loginError }}</p>
        <button class="button primary login-button" :disabled="busy" type="submit"><span v-if="busy" class="spinner" />{{ busy ? '登录中…' : '登录' }}</button>
      </form>
    </main>
  </div>
  <div v-else ref="appElement" class="app-shell" :class="{ 'canvas-fullscreen': canvasFullscreen, 'mobile-layout': mobile }" :style="[mobileViewportStyle, contentFontStyle]" :data-content-font="appliedContentFont">
    <button v-if="mobile && sidebarOpen" class="sidebar-backdrop" aria-label="关闭画布列表" @click="sidebarOpen = false" />
    <aside v-show="!mobile || sidebarOpen" id="canvas-sidebar" class="sidebar" :class="{ 'sidebar-open': sidebarOpen }">
      <div class="brand"><span class="brand-symbol"><Icon name="canvas" :size="24" /></span><span>canvas</span><button v-if="mobile" class="icon-button sidebar-close" aria-label="关闭画布列表" @click="sidebarOpen = false"><Icon name="close" :size="19" /></button></div>
      <div class="nav-section-label canvas-label"><span>画布</span><button class="icon-button" title="新建画布" aria-label="新建画布" @click="openCanvasDialog()"><Icon name="plus" :size="14" /></button></div>
      <nav class="canvas-nav" aria-label="画布">
        <button class="nav-item" :class="{ active: isOverview }" :aria-current="isOverview ? 'page' : undefined" title="总览" @click="switchCanvas('overview')"><Icon name="grid" :size="16" /><span>总览</span><span class="nav-count">{{ windowCount }}</span></button>
        <button v-for="canvas in canvases" :key="canvas.id" class="nav-item" :class="{ active: activeId === canvas.id }" :aria-current="activeId === canvas.id ? 'page' : undefined" :title="canvas.name" @click="switchCanvas(canvas.id)"><Icon name="canvas" :size="16" /><span>{{ canvas.name }}</span><span class="nav-count">{{ canvas.nodes.length }}</span></button>
      </nav>
      <div class="sidebar-divider" />
      <div class="nav-section-label"><span>连接</span><button class="icon-button" title="添加连接" aria-label="添加连接" @click="openSource()"><Icon name="plus" :size="16" /></button></div>
      <div class="source-nav"><button v-for="source in sources" :key="source.id" class="source-nav-item" :title="`${source.name} · ${source.transport === 'local' ? '本机' : source.target?.replace(/^ssh:\/\//, '')}`" @click="sourcePanel = true; expandedSource = source.id"><Icon class="source-nav-icon" name="server" :size="16" /><span class="source-nav-name">{{ source.name }}</span><span class="connection-dot" :class="resources.find(item => item.id === source.id)?.error ? 'disconnected' : 'connected'" /></button><button v-if="!sources.length" class="source-empty" @click="openSource()"><Icon name="plus" :size="15" />添加连接</button></div>
      <div class="sidebar-footer"><button class="sidebar-account" @click="sourcePanel = true"><span class="avatar">{{ username.slice(0, 1).toUpperCase() || 'C' }}</span><span>{{ username || '工作台' }}<small>{{ onlineCount }} 个连接在线</small></span></button><button class="icon-button sidebar-settings" title="设置" aria-label="设置" :aria-busy="fontLoading" :disabled="!settings" @click="openSettings"><span v-if="fontLoading" class="spinner" /><svg v-else width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 3-.6 2.3-2 .9-2.1-.7-2.5 4.3 1.7 1.6v2.3L2.3 15l2.5 4.3 2.1-.7 2 .9.6 2.3h5l.6-2.3 2-.9 2.1.7 2.5-4.3-1.7-1.6v-2.3l1.7-1.6-2.5-4.3-2.1.7-2-.9-.6-2.3z" /><circle cx="12" cy="12" r="3" /></svg></button><button class="icon-button" title="退出登录" aria-label="退出登录" @click="logout"><Icon name="logout" :size="17" /></button></div>
    </aside>
    <main class="workspace">
      <header class="workspace-header">
        <div class="header-context"><button v-if="mobile" class="icon-button mobile-menu-trigger" aria-label="打开画布列表" aria-controls="canvas-sidebar" :aria-expanded="sidebarOpen" @click="sidebarOpen = !sidebarOpen"><Icon name="menu" :size="21" /></button><div class="breadcrumb"><h1 :title="currentName">{{ currentName }}</h1></div><span class="header-counts">{{ canvasCounts }}</span><button class="icon-button refresh-button" :title="refreshedAt ? `刷新 · ${refreshedAt} 更新` : '刷新'" aria-label="刷新" :disabled="loading" @click="refreshResources()"><Icon name="refresh" :size="14" :class="{ spinning: loading }" /></button></div>
        <div class="header-actions">
          <UDropdownMenu v-if="isOverview" v-model:open="overviewMenuOpen" :items="overviewMenu" :portal="appElement || false" :content="{ align: 'end' }" :ui="{ content: 'overview-display-menu', item: 'overview-display-item', label: 'overview-display-label' }">
            <button class="icon-button overview-display-trigger" :class="{ active: overviewChanged }" title="筛选与排序" aria-label="总览筛选与排序"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg><i v-if="overviewChanged" /></button>
            <template #item-leading="{ item }"><span class="overview-display-leading" aria-hidden="true"><i v-if="item.status" class="program-dot" :style="{ '--program-color': statusColor(item.status) }" /></span></template>
          </UDropdownMenu>
          <button v-if="!isOverview" class="button subtle" title="添加便签" aria-label="添加便签" :disabled="busy" @click="addNote"><Icon name="note" :size="14" />便签</button>
          <span v-if="!isOverview && saveState" class="save-state" :title="saveState" :aria-label="saveState"><span v-if="saveState === '正在保存…'" class="spinner" /><Icon v-else :name="saveState === '已保存' ? 'check' : 'info'" :size="13" /></span>
          <div ref="canvasMenuElement" class="canvas-menu-wrap"><button class="icon-button canvas-menu-trigger" title="画布设置" aria-label="画布设置" :aria-expanded="canvasMenu" aria-controls="canvas-menu" @click="toggleCanvasMenu"><Icon name="more" :size="17" /></button><div v-if="canvasMenu" id="canvas-menu" class="canvas-menu"><template v-if="mobile"><button @click="canvasMenu = false; refreshResources()"><Icon name="refresh" :size="15" />刷新</button><button @click="canvasMenu = false; sourcePanel = true"><Icon name="server" :size="15" />连接与窗口</button><button v-if="!isOverview" @click="canvasMenu = false; addNote()"><Icon name="note" :size="15" />添加便签</button><button v-if="!isOverview" @click="canvasMenu = false; openAdd()"><Icon name="plus" :size="15" />加入窗口</button></template><button @click="openBackground"><Icon name="image" :size="15" />背景图片</button><button v-if="!isOverview" @click="canvasMenu = false; openCanvasDialog(currentCanvas)"><Icon name="edit" :size="15" />重命名画布</button><button v-if="!isOverview" class="danger-text" @click="canvasMenu = false; deleteCanvas()"><Icon name="trash" :size="15" />删除画布</button></div></div>
          <button class="button subtle" title="连接" aria-label="连接" @click="sourcePanel = true"><Icon name="server" :size="15" />连接</button>
          <button v-if="isOverview" class="button primary" title="添加连接" aria-label="添加连接" @click="openSource()"><Icon name="plus" :size="15" />添加连接</button><button v-else class="button primary" title="加入窗口" aria-label="加入窗口" @click="openAdd()"><Icon name="plus" :size="15" />加入窗口</button>
        </div>
      </header>
      <div ref="graphSurface" class="graph-wrap" :class="{ 'has-background': currentBackground, paged: paging }" :data-page-window="paging ? currentPage?.id : undefined" @mousedown.capture="guardPageDrag" @wheel.capture="canvasWheel" @touchstart.capture="canvasTouchStart" @touchmove.capture="canvasTouchMove" @touchend.capture="canvasTouchEnd" @touchcancel.capture="canvasTouchCancel" @click.capture="canvasClick">
        <img v-if="currentBackground" class="canvas-background" :src="currentBackground.url" :style="{ opacity: currentBackground.opacity }" alt="" aria-hidden="true" />
        <VueFlow :snap-to-grid="!isOverview && !!currentCanvas?.snapToGrid" :snap-grid="[24, 24]" v-if="nodes.length && !focused" :key="graphKey" v-model:nodes="nodes" :min-zoom="0.08" :max-zoom="2" :nodes-connectable="false" :nodes-draggable="!isOverview && !mobile" :elements-selectable="!mobile" :zoom-on-double-click="false" :zoom-on-scroll="false" :zoom-on-pinch="false" :pan-on-scroll="false" :delete-key-code="null" :selection-key-code="null" :pan-on-drag="!mobile && !paging" :pan-activation-key-code="paging ? null : 'Space'" :prevent-scrolling="true" @node-drag-start="layoutStarted" @node-drag-stop="dragStopped" @move-end="saveViewport" @init="restoreViewport" @nodes-initialized="nodesInitialized"><template #node-terminal="nodeProps"><TerminalNode v-bind="nodeProps" /></template><template #node-note="nodeProps"><NoteNode v-bind="nodeProps" /></template><template #node-file="nodeProps"><FileNode v-bind="nodeProps" /></template><template #node-group="nodeProps"><GroupNode v-bind="nodeProps" /></template><MiniMap v-if="!mobile && !paging" :pannable="true" :zoomable="true" :node-color="node => node.type === 'terminal' ? statusColor(node.data.status) : node.type === 'note' ? '#bba071' : node.type === 'file' ? '#8796b3' : 'transparent'" :node-stroke-width="0" :mask-color="'rgba(17,19,23,.7)'" /></VueFlow>
        <div v-if="!nodes.length && isOverview" class="empty-state"><Icon name="server" :size="32" /><h2>{{ windowCount && overviewFiltered ? '没有匹配的窗口' : sources.length ? '暂无窗口' : '暂无连接' }}</h2><button v-if="windowCount && overviewFiltered" class="button subtle" @click="overviewSelected = [...overviewStatuses]">清除筛选</button><button v-else class="button primary" @click="sources.length ? sourcePanel = true : openSource()"><Icon :name="sources.length ? 'server' : 'plus'" :size="17" />{{ sources.length ? '连接' : '添加连接' }}</button></div>
        <div v-if="!nodes.length && !isOverview" class="empty-state"><Icon name="canvas" :size="32" /><h2>空画布</h2><button class="button primary" @click="openAdd()"><Icon name="plus" :size="17" />加入窗口</button></div>
        <div v-if="!focused" class="canvas-toolbar"><button :title="canvasFullscreen ? '退出全屏画布' : '全屏画布'" :aria-label="canvasFullscreen ? '退出全屏画布' : '全屏画布'" :aria-pressed="canvasFullscreen" @click="toggleFullscreen"><Icon :name="canvasFullscreen ? 'collapse' : 'expand'" :size="17" /></button><button v-if="isOverview" title="逐窗浏览" aria-label="逐窗浏览" :aria-pressed="overviewPaged" @click="togglePaging"><Icon name="pages" :size="17" /></button><button v-if="!isOverview" title="网格吸附" aria-label="网格吸附" :aria-pressed="!!currentCanvas?.snapToGrid" @click="toggleSnap"><Icon name="grid" :size="15" /></button><template v-if="paging"><button v-for="item in pageDirections" :key="item.direction" :title="item.label" :aria-label="item.label" :disabled="!pageNeighbor(item.direction)" @pointerdown.prevent @click="movePage(item.direction)"><Icon :name="item.icon" :size="16" :style="{ transform: item.rotation }" /></button></template><button v-if="!paging" title="缩小" aria-label="缩小" @click="zoomOut({ duration: 150 })"><Icon name="minus" :size="17" /></button><button :title="paging ? '居中窗口' : '适合画布'" :aria-label="paging ? '居中窗口' : '适合画布'" @click="fitCanvas"><Icon name="fit" :size="17" /></button><button v-if="!paging" title="放大" aria-label="放大" @click="zoomIn({ duration: 150 })"><Icon name="plus" :size="17" /></button></div>
      </div>
    </main>
    <Transition name="slide"><aside v-if="sourcePanel" class="source-panel"><header><div><h2>连接与窗口</h2></div><button class="icon-button" aria-label="关闭连接面板" @click="sourcePanel = false"><Icon name="close" /></button></header><button class="button primary full-width" @click="openSource()"><Icon name="plus" :size="16" />添加连接</button><div class="source-panel-content"><div v-for="source in sources" :key="source.id" class="source-detail"><div class="source-detail-header"><button class="source-expand" @click="expandedSource = expandedSource === source.id ? '' : source.id"><Icon name="chevron" :size="15" :class="{ rotated: expandedSource === source.id }" /><span>{{ source.name }}<small>{{ source.transport === 'local' ? '本机' : source.target }}</small></span></button><button class="icon-button" title="编辑连接" aria-label="编辑连接" @click="openSource(source)"><Icon name="edit" :size="14" /></button><button class="icon-button" title="移除连接" aria-label="移除连接" @click="deleteSource(source)"><Icon name="trash" :size="14" /></button></div><template v-if="expandedSource === source.id"><div v-if="resources.find(item => item.id === source.id)?.error" class="source-error">{{ resources.find(item => item.id === source.id)?.error }}</div><div v-for="space in resources.find(item => item.id === source.id)?.spaces || []" :key="space.id" class="space-detail"><div class="space-detail-header"><Icon name="layers" :size="14" /><strong>{{ space.name }}</strong><button class="icon-button" title="新建窗口" aria-label="新建窗口" @click="windowAction({ type: 'terminal', id: '', sourceId: source.id, spaceId: space.id, windowId: '', x: 0, y: 0, width: 0, height: 0 }, 'create')"><Icon name="plus" :size="14" /></button><button class="icon-button" title="重命名 Space" aria-label="重命名 Space" @click="spaceAction(resources.find(item => item.id === source.id)!, space.id, 'rename')"><Icon name="edit" :size="13" /></button><button class="icon-button danger-hover" title="关闭 Space" aria-label="关闭 Space" @click="spaceAction(resources.find(item => item.id === source.id)!, space.id, 'close')"><Icon name="close" :size="14" /></button></div><div v-for="window in space.windows" :key="window.id" class="window-detail"><span class="program-dot" :style="{ '--program-color': statusColor(window.status) }" :title="statusLabel(window.status)" /><span>{{ window.name }}</span><button class="icon-button" title="加入画布" aria-label="加入画布" @click="openAdd({ type: 'terminal', id: '', sourceId: source.id, spaceId: space.id, windowId: window.id, x: 0, y: 0, width: 480, height: 302 })"><Icon name="plus" :size="14" /></button><button class="icon-button" title="窗口操作" aria-label="窗口操作" @click="windowMenu = { name: window.name, node: { type: 'terminal', id: '', sourceId: source.id, spaceId: space.id, windowId: window.id, x: 0, y: 0, width: 480, height: 302 } }"><Icon name="more" :size="15" /></button></div></div><button class="source-new-space" @click="spaceAction(resources.find(item => item.id === source.id) || { ...source, status: '', spaces: [] }, undefined, 'create')"><Icon name="plus" :size="14" />新建 space</button></template></div><p v-if="!sources.length" class="panel-empty">暂无连接</p></div></aside></Transition>
    <div v-if="focused" ref="focusViewportElement" class="focus-overlay"><TerminalNode :id="focused.id" :data="{ ...terminalData(focused, true), ...focusedSize, overview: true, focus: true }" /></div>
    <BackgroundDialog v-if="backgroundCanvas" :canvas="backgroundCanvas" @close="closeBackgroundDialog" @saved="backgroundSaved" />
    <DirectoryDialog :portal="appElement" />
    <DownloadPreviewDialog :portal="appElement" />
    <SettingsDialog v-if="settingsDialog && settings" :settings="settings" :portal="appElement" @close="settingsDialog = false" @saved="settingsSaved" />
    <div v-if="modalOpen && !backgroundCanvas && !settingsDialog" class="modal-backdrop" @click.self="!busy && (sourceDialog = false, canvasDialog = false, actionDialog = null, addDialog = false, windowMenu = null)">
      <section v-if="sourceDialog" class="modal source-modal" role="dialog" aria-modal="true" aria-labelledby="source-title"><header><div><h2 id="source-title">{{ sourceDraft.id ? '编辑连接' : '添加连接' }}</h2></div><button class="icon-button" aria-label="关闭对话框" @click="sourceDialog = false"><Icon name="close" /></button></header><form @submit.prevent="submitSource"><label>连接名称<input v-model="sourceDraft.name" name="sourceName" required placeholder="例如：开发机器" /></label><div class="segmented-control"><button type="button" :class="{ selected: sourceDraft.transport === 'local' }" @click="sourceDraft.transport = 'local'"><Icon name="server" :size="15" />本机</button><button type="button" :class="{ selected: sourceDraft.transport === 'ssh' }" @click="sourceDraft.transport = 'ssh'"><Icon name="globe" :size="15" />远程 SSH</button></div><label v-if="sourceDraft.transport === 'ssh'">SSH 地址<input v-model="sourceDraft.target" name="target" placeholder="ssh://user@hostname:22" :required="sourceDraft.transport === 'ssh'" /></label><label>Session <span class="optional">可选</span><input v-model="sourceDraft.herdrSession" name="herdrSession" placeholder="default" /></label><details><summary>高级设置</summary><template v-if="sourceDraft.transport === 'ssh'"><label>SSH 私钥路径（Server） <span class="optional">可选</span><input v-model="sourceDraft.sshIdentityFile" name="sshIdentityFile" placeholder="/path/to/id_ed25519" /></label><label>SSH known_hosts 路径（Server） <span class="optional">可选</span><input v-model="sourceDraft.sshKnownHostsFile" name="sshKnownHostsFile" placeholder="/path/to/known_hosts" /></label></template><label>Socket 路径 <span class="optional">可选</span><input v-model="sourceDraft.herdrSocket" name="herdrSocket" placeholder="/path/to/herdr.sock" /></label></details><p v-if="dialogError" class="form-error" role="alert">{{ dialogError }}</p><footer><button class="button subtle" type="button" @click="sourceDialog = false">取消</button><button class="button primary" type="submit" :disabled="busy"><span v-if="busy" class="spinner" />{{ busy ? '保存中…' : '保存' }}</button></footer></form></section>
      <section v-else-if="canvasDialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="canvas-title"><header><div><h2 id="canvas-title">{{ canvasDraft.id ? '重命名画布' : '新建画布' }}</h2></div><button class="icon-button" aria-label="关闭对话框" @click="canvasDialog = false"><Icon name="close" /></button></header><form @submit.prevent="submitCanvas"><label>画布名称<input v-model="canvasDraft.name" name="canvasName" required autofocus placeholder="例如：日常开发" maxlength="80" /></label><p v-if="dialogError" class="form-error">{{ dialogError }}</p><footer><button class="button subtle" type="button" @click="canvasDialog = false">取消</button><button class="button primary" :disabled="busy" type="submit">{{ canvasDraft.id ? '保存' : '创建画布' }}</button></footer></form></section>
      <section v-else-if="actionDialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="action-title"><header><h2 id="action-title">{{ actionDialog.title }}</h2><button class="icon-button" aria-label="关闭对话框" @click="actionDialog = null"><Icon name="close" /></button></header><p v-if="actionDialog.description">{{ actionDialog.description }}</p><form @submit.prevent="submitAction"><label v-if="actionDialog.label">{{ actionDialog.label }}<input v-model="actionDialog.value" name="resourceName" required autofocus maxlength="120" /></label><p v-if="dialogError" class="form-error" role="alert">{{ dialogError }}</p><footer><button class="button subtle" type="button" @click="actionDialog = null">取消</button><button class="button" :class="actionDialog.danger ? 'danger' : 'primary'" :disabled="busy" type="submit">{{ actionDialog.button }}</button></footer></form></section>
      <section v-else-if="addDialog" class="modal add-modal" role="dialog" aria-modal="true" aria-labelledby="add-title"><header><div><h2 id="add-title">加入窗口</h2></div><button class="icon-button" aria-label="关闭对话框" @click="addDialog = false"><Icon name="close" /></button></header><label>目标画布<select v-model="addTarget"><option v-for="canvas in canvases" :key="canvas.id" :value="canvas.id">{{ canvas.name }}</option><option value="">新建「我的画布」</option></select></label><div class="search-field"><Icon name="search" :size="16" /><input v-model="addSearch" aria-label="搜索窗口" placeholder="搜索连接、Space 或窗口…" /></div><div class="window-picker"><button v-for="item in filteredWindows" :key="item.key" class="window-pick" :class="{ selected: selectedWindows.includes(item.key) }" @click="toggleSelection(item.key)"><span class="checkbox"><Icon v-if="selectedWindows.includes(item.key)" name="check" :size="12" /></span><span><strong><i class="program-dot" :style="{ '--program-color': statusColor(item.window.status) }" :title="statusLabel(item.window.status)" />{{ item.window.name }}</strong><small>{{ item.source.name }} / {{ item.space.name }}</small></span></button><p v-if="!filteredWindows.length" class="panel-empty">{{ windowCount ? '没有匹配的窗口' : '暂无可用窗口' }}</p></div><p v-if="dialogError" class="form-error">{{ dialogError }}</p><footer><span class="selection-count">已选 {{ selectedWindows.length }} 个窗口</span><button class="button primary" :disabled="busy || !selectedWindows.length" @click="submitAdd">加入画布<Icon name="arrow" :size="16" /></button></footer></section>
      <section v-else-if="windowMenu" class="modal window-menu" role="dialog" aria-modal="true" aria-labelledby="window-title"><header><h2 id="window-title">{{ windowMenu.name }}</h2><button class="icon-button" aria-label="关闭对话框" @click="windowMenu = null"><Icon name="close" /></button></header><button @click="openAdd(windowMenu.node); windowMenu = null"><Icon name="plus" />加入其他画布</button><button @click="windowAction(windowMenu.node, 'rename')"><Icon name="edit" />重命名窗口</button><button class="danger-text" @click="windowAction(windowMenu.node, 'close')"><Icon name="trash" />关闭窗口</button></section>
    </div>
    <div v-if="error || success" class="toast" :class="{ 'error-toast': error }" role="status"><Icon :name="error ? 'info' : 'check'" :size="17" /><span>{{ error || success }}</span><button class="icon-button" aria-label="关闭通知" @click="error = ''; success = ''"><Icon name="close" :size="15" /></button></div>
  </div>
  </UApp>
</template>
