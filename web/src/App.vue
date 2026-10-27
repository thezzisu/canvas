<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { VueFlow, useVueFlow, type Node } from '@vue-flow/core'
import { MiniMap } from '@vue-flow/minimap'
import Icon from './components/Icon.vue'
import TerminalNode from './components/TerminalNode.vue'
import GroupNode from './components/GroupNode.vue'
import { api, segment, uuid, write } from './api'
import { clearTerminals } from './terminals'
import type { Canvas, CanvasNode, Source, SourceResource, TerminalData } from './types'

const { fitView, zoomIn, zoomOut, setViewport, getViewport } = useVueFlow()
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
const activeId = ref('overview')
const nodes = shallowRef<Node[]>([])
const graphKey = ref(0)
const refreshedAt = ref('')
const loading = ref(false)
const sourcePanel = ref(false)
const expandedSource = ref('')
const sourceDialog = ref(false)
const sourceDraft = reactive<Source>({ id: '', name: '', type: 'tmux', transport: 'local', target: '', binary: '', tmuxSocket: '', herdrSession: '', sshIdentityFile: '', sshKnownHostsFile: '' })
const canvasDialog = ref(false)
const canvasDraft = reactive({ id: '', name: '' })
const dialogError = ref('')
const actionDialog = ref<{ title: string; description: string; label?: string; value: string; danger?: boolean; button: string; submit: (value: string) => Promise<void> } | null>(null)
const addDialog = ref(false)
const addTarget = ref('')
const addSearch = ref('')
const selectedWindows = ref<string[]>([])
const windowMenu = ref<{ node: CanvasNode; name: string } | null>(null)
const focused = ref<CanvasNode | null>(null)
const focusedSize = reactive({ width: window.innerWidth - 72, height: window.innerHeight - 108 })
const saveState = ref('')
let refreshTimer: ReturnType<typeof setInterval>
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
let noticeTimer: ReturnType<typeof setTimeout>
let resourceSignature = ''
const currentCanvas = computed(() => canvases.value.find(canvas => canvas.id === activeId.value))
const isOverview = computed(() => activeId.value === 'overview')
const currentName = computed(() => isOverview.value ? '总览' : currentCanvas.value?.name || '画布')
const allWindows = computed(() => resources.value.flatMap(source => source.spaces.flatMap(space => space.windows.map(window => ({ source, space, window, key: `${source.id}/${space.id}/${window.id}` })))))
const windowCount = computed(() => allWindows.value.length)
const onlineCount = computed(() => resources.value.filter(source => !source.error && !['offline', 'error', 'disconnected'].includes(source.status)).length)
const filteredWindows = computed(() => allWindows.value.filter(item => `${item.source.name} ${item.space.name} ${item.window.name}`.toLowerCase().includes(addSearch.value.toLowerCase())))
const modalOpen = computed(() => sourceDialog.value || canvasDialog.value || actionDialog.value || addDialog.value || windowMenu.value)

function notify(message: string) { success.value = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { success.value = '' }, 3500) }
function showError(reason: unknown) { error.value = reason instanceof Error ? reason.message : String(reason) }
function resourceFor(node: CanvasNode) {
  const source = resources.value.find(item => item.id === node.sourceId)
  const space = source?.spaces.find(item => item.id === node.spaceId)
  const window = space?.windows.find(item => item.id === node.windowId)
  // tmux windows may be linked into more than one session.
  const linked = window || source?.spaces.flatMap(item => item.windows).find(item => item.id === node.windowId)
  return { source, space, window: linked }
}
function terminalData(node: CanvasNode, overview = false): TerminalData {
  const found = resourceFor(node)
  const sourceConfig = sources.value.find(source => source.id === node.sourceId)
  return { ...node, name: found.window?.name || '已关闭的窗口', subtitle: `${found.source?.name || sourceConfig?.name || '未知连接'} / ${found.space?.name || 'space'}`, type: found.source?.type || sourceConfig?.type || 'tmux', available: !!found.window && !found.source?.error, overview, focus: false, onAction: terminalAction, onResize: resizeNode }
}
function terminalFlowNode(node: CanvasNode, overview = false): Node {
  return { id: node.id, type: 'terminal', position: { x: node.x, y: node.y }, data: terminalData(node, overview), style: { width: `${node.width}px`, height: `${node.height}px` }, draggable: !overview, selectable: true, dragHandle: '.drag-handle' }
}
function overviewNodes(): Node[] {
  const result: Node[] = []
  const machines = new Map<string, SourceResource[]>()
  for (const source of resources.value) {
    const config = sources.value.find(item => item.id === source.id)
    const host = config?.transport === 'local' ? 'local' : config?.target || source.host || 'remote'
    machines.set(host, [...(machines.get(host) || []), source])
  }
  let y = 0
  for (const [host, machineSources] of machines) {
    const maxWindows = Math.max(1, ...machineSources.flatMap(source => source.spaces.map(space => space.windows.length)))
    const width = maxWindows * 496 + 32
    const count = machineSources.reduce((total, source) => total + source.spaces.reduce((sum, space) => sum + space.windows.length, 0), 0)
    const rows = machineSources.flatMap(source => source.spaces.map(space => ({ source, space })))
    const height = Math.max(132, 78 + rows.reduce((sum, { space }) => sum + (space.windows.length ? 356 : 66), 0))
    result.push({ id: `machine:${host}`, type: 'group', position: { x: 0, y }, data: { kind: 'machine', name: host === 'local' ? '本机' : host.replace(/^ssh:\/\//, ''), subtitle: host === 'local' ? 'LOCAL' : 'SSH', count, width, height }, draggable: false, selectable: false, style: { width: `${width}px`, height: `${height}px`, zIndex: '-1', pointerEvents: 'none' } })
    let rowY = y + 68
    for (const { source, space } of rows) {
      result.push({ id: `space:${source.id}:${space.id}`, type: 'group', position: { x: 24, y: rowY }, data: { kind: 'space', name: space.name, subtitle: `${source.name} · ${source.type}`, count: space.windows.length }, draggable: false, selectable: false, style: { width: `${width - 48}px`, pointerEvents: 'none' } })
      for (const [index, window] of space.windows.entries()) result.push(terminalFlowNode({ id: `window:${source.id}:${space.id}:${window.id}`, sourceId: source.id, spaceId: space.id, windowId: window.id, x: 24 + index * 496, y: rowY + 34, width: 480, height: 302 }, true))
      rowY += space.windows.length ? 356 : 66
    }
    y += height + 48
  }
  return result
}
function rebuildNodes() { nodes.value = isOverview.value ? overviewNodes() : (currentCanvas.value?.nodes || []).map(node => terminalFlowNode(node)) }
async function restoreViewport() {
  await nextTick()
  const stored = localStorage.getItem(`canvas:viewport:${activeId.value}`)
  if (stored) { try { void setViewport(JSON.parse(stored)); return } catch {} }
  void fitView({ padding: .14, maxZoom: 1, duration: 180 })
}
function saveViewport() { localStorage.setItem(`canvas:viewport:${activeId.value}`, JSON.stringify(getViewport())) }
async function refreshResources(silent = false) {
  if (loading.value || !authenticated.value) return
  loading.value = !silent
  try {
    const body = await api<{ sources: SourceResource[] }>('/api/resources')
    const signature = JSON.stringify(body.sources)
    if (signature !== resourceSignature) { resources.value = body.sources; resourceSignature = signature; rebuildNodes() }
    refreshedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch (reason) { if (!silent) showError(reason) }
  finally { loading.value = false }
}
async function load() {
  const state = await api<{ sources: Source[]; canvases: Canvas[] }>('/api/state')
  sources.value = state.sources
  canvases.value = state.canvases.map(canvas => ({ ...canvas, nodes: canvas.nodes || [] }))
  await refreshResources()
  rebuildNodes()
  await restoreViewport()
}
async function login() {
  busy.value = true; loginError.value = ''
  try { await write('/api/login', 'POST', { username: username.value, password: password.value }); password.value = ''; authenticated.value = true; await load() }
  catch (reason) { loginError.value = reason instanceof Error ? reason.message : '登录失败' }
  finally { busy.value = false }
}
async function logout() { await write('/api/logout', 'POST'); authenticated.value = false; clearTerminals() }
function unauthorized() { authenticated.value = false; clearTerminals() }
watch(activeId, async () => { focused.value = null; rebuildNodes(); await restoreViewport() })
function switchCanvas(id: string) { saveViewport(); activeId.value = id }
function openCanvasDialog(canvas?: Canvas) { canvasDraft.id = canvas?.id || ''; canvasDraft.name = canvas?.name || ''; dialogError.value = ''; canvasDialog.value = true }
async function submitCanvas() {
  if (!canvasDraft.name.trim()) return
  busy.value = true; dialogError.value = ''
  try {
    if (canvasDraft.id) {
      await write(`/api/canvases/${segment(canvasDraft.id)}`, 'PATCH', { name: canvasDraft.name.trim() })
      const canvas = canvases.value.find(item => item.id === canvasDraft.id)
      if (canvas) canvas.name = canvasDraft.name.trim()
    } else {
      const canvas = await write<Canvas>('/api/canvases', 'POST', { name: canvasDraft.name.trim(), nodes: [] })
      canvases.value.push({ ...canvas, nodes: canvas.nodes || [] }); switchCanvas(canvas.id)
    }
    canvasDialog.value = false
  } catch (reason) { dialogError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
function deleteCanvas() {
  const canvas = currentCanvas.value
  if (!canvas) return
  actionDialog.value = { title: `删除「${canvas.name}」`, description: '只会删除此画布和其中的窗口引用。终端窗口仍保留在原来的连接中。', value: '', danger: true, button: '删除画布', submit: async () => { clearTimeout(saveTimers.get(canvas.id)); saveTimers.delete(canvas.id); await write(`/api/canvases/${segment(canvas.id)}`, 'DELETE'); canvases.value = canvases.value.filter(item => item.id !== canvas.id); switchCanvas('overview') } }
}
function openSource(source?: Source) {
  Object.assign(sourceDraft, { id: '', name: '', type: 'tmux', transport: 'local', target: '', binary: '', tmuxSocket: '', herdrSession: '', sshIdentityFile: '', sshKnownHostsFile: '' }, source || {})
  dialogError.value = ''; sourceDialog.value = true
}
async function submitSource() {
  busy.value = true; dialogError.value = ''
  try {
    const body = { ...sourceDraft, name: sourceDraft.name.trim(), target: sourceDraft.target?.trim() }
    if (body.transport === 'ssh' && !body.target) throw new Error('请输入 SSH 地址')
    if (body.id) {
      const source = await write<Source>(`/api/sources/${segment(body.id)}`, 'PATCH', body)
      sources.value = sources.value.map(item => item.id === body.id ? source : item)
    } else { const { id, ...newSource } = body; sources.value.push(await write<Source>('/api/sources', 'POST', newSource)) }
    sourceDialog.value = false; resourceSignature = ''; await refreshResources(); await restoreViewport(); notify('连接已保存')
  } catch (reason) { dialogError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
function deleteSource(source: Source) {
  actionDialog.value = { title: `移除「${source.name}」`, description: '移除连接配置。此机器上运行的 herdr / tmux 会话会继续保留。', value: '', danger: true, button: '移除连接', submit: async () => { await write(`/api/sources/${segment(source.id)}`, 'DELETE'); sources.value = sources.value.filter(item => item.id !== source.id); await refreshResources() } }
}
function basePath(sourceId: string) { return `/api/sources/${segment(sourceId)}` }
function spaceAction(source: SourceResource, spaceId: string | undefined, operation: 'create' | 'rename' | 'close') {
  const space = source.spaces.find(item => item.id === spaceId)
  const noun = source.type === 'tmux' ? 'session' : 'space'
  const actionName = operation === 'create' ? '新建' : operation === 'rename' ? '重命名' : '关闭'
  actionDialog.value = { title: `${actionName} ${noun}`, description: operation === 'close' ? `将关闭「${space?.name}」及其中运行的窗口。` : `在 ${source.name} 上${actionName} ${noun}。`, label: operation === 'close' ? undefined : '名称', value: operation === 'rename' ? space?.name || '' : '', danger: operation === 'close', button: `${actionName} ${noun}`, submit: async name => { await write(`${basePath(source.id)}/spaces${spaceId ? `/${segment(spaceId)}` : ''}`, operation === 'create' ? 'POST' : operation === 'rename' ? 'PATCH' : 'DELETE', operation === 'close' ? undefined : { name }); await refreshResources() } }
}
function windowAction(node: CanvasNode, operation: 'create' | 'rename' | 'close') {
  const { source, space, window } = resourceFor(node)
  const actionName = operation === 'create' ? '新建' : operation === 'rename' ? '重命名' : '关闭'
  windowMenu.value = null
  actionDialog.value = { title: `${actionName}窗口`, description: operation === 'close' ? `将结束「${window?.name}」及其所有 pane 中的进程。` : `${source?.name || ''} / ${space?.name || ''}`, label: operation === 'close' ? undefined : '窗口名称', value: operation === 'rename' ? window?.name || '' : '', danger: operation === 'close', button: `${actionName}窗口`, submit: async name => { await write(`${basePath(node.sourceId)}/spaces/${segment(node.spaceId)}/windows${operation === 'create' ? '' : `/${segment(node.windowId)}`}`, operation === 'create' ? 'POST' : operation === 'rename' ? 'PATCH' : 'DELETE', operation === 'close' ? undefined : { name }); await refreshResources() } }
}
async function submitAction() {
  const dialog = actionDialog.value
  if (!dialog) return
  busy.value = true; dialogError.value = ''
  try { await dialog.submit(dialog.value.trim()); actionDialog.value = null; notify('操作已完成') }
  catch (reason) { dialogError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
watch(actionDialog, () => { dialogError.value = '' })
function getCanvasNode(id: string): CanvasNode | undefined {
  const node = nodes.value.find(item => item.id === id)
  return node ? { id, sourceId: node.data.sourceId, spaceId: node.data.spaceId, windowId: node.data.windowId, x: node.position.x, y: node.position.y, width: node.data.width, height: node.data.height } : undefined
}
function terminalAction(action: string, id: string) {
  const node = getCanvasNode(id) || focused.value
  if (!node) return
  if (action === 'add') openAdd(node)
  else if (action === 'remove') { if (currentCanvas.value) currentCanvas.value.nodes = currentCanvas.value.nodes.filter(item => item.id !== id); rebuildNodes(); scheduleSave() }
  else if (action === 'focus') { saveViewport(); focused.value = node }
  else if (action === 'menu') windowMenu.value = { node, name: resourceFor(node).window?.name || '窗口' }
}
async function closeFocus() { focused.value = null; graphKey.value++; await nextTick(); await restoreViewport() }
function openAdd(node?: CanvasNode) {
  addTarget.value = currentCanvas.value?.id || canvases.value[0]?.id || ''
  selectedWindows.value = node ? [`${node.sourceId}/${node.spaceId}/${node.windowId}`] : []
  addSearch.value = ''; addDialog.value = true; dialogError.value = ''
}
function toggleSelection(key: string) { selectedWindows.value = selectedWindows.value.includes(key) ? selectedWindows.value.filter(item => item !== key) : [...selectedWindows.value, key] }
async function submitAdd() {
  busy.value = true; dialogError.value = ''
  try {
    let canvas = canvases.value.find(item => item.id === addTarget.value)
    if (!canvas) { canvas = await write<Canvas>('/api/canvases', 'POST', { name: '我的画布', nodes: [] }); canvas.nodes ||= []; canvases.value.push(canvas) }
    let index = canvas.nodes.length
    const chosen = allWindows.value.filter(item => selectedWindows.value.includes(item.key))
    for (const item of chosen) {
      if (canvas.nodes.some(node => node.sourceId === item.source.id && node.windowId === item.window.id)) continue
      canvas.nodes.push({ id: uuid(), sourceId: item.source.id, spaceId: item.space.id, windowId: item.window.id, x: (index % 3) * 580, y: Math.floor(index / 3) * 390, width: 552, height: 352 }); index++
    }
    await write(`/api/canvases/${segment(canvas.id)}`, 'PATCH', { nodes: canvas.nodes })
    addDialog.value = false; switchCanvas(canvas.id); rebuildNodes(); void fitView({ padding: .15, maxZoom: 1, duration: 200 }); notify(`已加入「${canvas.name}」`)
  } catch (reason) { dialogError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
function scheduleSave() {
  const canvas = currentCanvas.value
  if (!canvas) return
  clearTimeout(saveTimers.get(canvas.id)); saveState.value = '正在保存…'
  saveTimers.set(canvas.id, setTimeout(async () => {
    saveTimers.delete(canvas.id)
    try { await write(`/api/canvases/${segment(canvas.id)}`, 'PATCH', { nodes: canvas.nodes }); if (activeId.value === canvas.id) saveState.value = '已保存' }
    catch (reason) { if (activeId.value === canvas.id) saveState.value = '保存失败'; showError(reason) }
  }, 450))
}
function dragStopped(event: { node: Node }) {
  const node = currentCanvas.value?.nodes.find(item => item.id === event.node.id)
  if (node) { node.x = event.node.position.x; node.y = event.node.position.y; scheduleSave() }
}
function resizeNode(id: string, width: number, height: number, x?: number, y?: number) {
  const node = currentCanvas.value?.nodes.find(item => item.id === id)
  if (node) { node.width = Math.round(width); node.height = Math.round(height); if (x !== undefined) node.x = x; if (y !== undefined) node.y = y; rebuildNodes(); scheduleSave() }
}
function keydown(event: KeyboardEvent) {
  if ((event.target as HTMLElement)?.closest('.xterm') && !modalOpen.value) return
  if (event.key === 'Escape') {
    if (windowMenu.value) windowMenu.value = null
    else if (actionDialog.value) actionDialog.value = null
    else if (sourceDialog.value) sourceDialog.value = false
    else if (canvasDialog.value) canvasDialog.value = false
    else if (addDialog.value) addDialog.value = false
    else if (focused.value) void closeFocus()
    else sourcePanel.value = false
  }
}
function windowResize() { focusedSize.width = window.innerWidth - 72; focusedSize.height = window.innerHeight - 108 }
onMounted(async () => {
  window.addEventListener('canvas:unauthorized', unauthorized)
  window.addEventListener('keydown', keydown)
  window.addEventListener('resize', windowResize)
  try { const session = await api<{ authenticated: boolean; username?: string }>('/api/session'); authenticated.value = session.authenticated; username.value = session.username || ''; if (authenticated.value) await load() }
  catch (reason) { showError(reason) }
  finally { ready.value = true }
  refreshTimer = setInterval(() => { void refreshResources(true) }, 8000)
})
onBeforeUnmount(() => { clearInterval(refreshTimer); for (const timer of saveTimers.values()) clearTimeout(timer); clearTimeout(noticeTimer); clearTerminals(); window.removeEventListener('canvas:unauthorized', unauthorized); window.removeEventListener('keydown', keydown); window.removeEventListener('resize', windowResize) })
</script>

<template>
  <div v-if="!ready" class="boot-screen"><span class="spinner" />正在打开 Canvas</div>
  <div v-else-if="!authenticated" class="login-screen">
    <div class="login-art" aria-hidden="true"><div class="art-window art-one"><span /><i /><i /><i /></div><div class="art-window art-two"><span /><i /><i /></div><div class="art-window art-three"><span /><i /><i /><i /></div><div class="art-axis axis-x" /><div class="art-axis axis-y" /><div class="art-caption">ONE WORKSPACE. EVERY TERMINAL.</div></div>
    <main class="login-content"><div class="brand login-brand"><span class="brand-symbol"><Icon name="canvas" :size="27" /></span><span>canvas<span class="brand-period">.</span></span></div><span class="eyebrow">你的终端工作台</span><h1>把所有窗口，<br />放在一起。</h1><p class="login-description">在一张无限画布上，连接并使用你的<br />herdr 和 tmux。无论它们在哪里。</p><form class="login-form" @submit.prevent="login"><label>用户名<input v-model="username" name="username" autocomplete="username" required autofocus placeholder="用户名" /></label><label>密码<input v-model="password" name="password" type="password" autocomplete="current-password" required placeholder="输入密码" /></label><p v-if="loginError" class="form-error" role="alert">{{ loginError }}</p><button class="button primary login-button" :disabled="busy" type="submit"><span v-if="busy" class="spinner" /><span>{{ busy ? '正在登录' : '进入工作台' }}</span><Icon name="arrow" /></button></form><span class="login-note"><Icon name="lock" :size="13" />你的机器，你的工作空间。</span></main>
  </div>
  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-symbol"><Icon name="canvas" :size="24" /></span><span>canvas<span class="brand-period">.</span></span><span class="version-badge">01</span></div>
      <div class="nav-section-label">工作空间</div>
      <button class="nav-item" :class="{ active: isOverview }" @click="switchCanvas('overview')"><Icon name="grid" /><span>总览</span><span class="nav-count">{{ windowCount }}</span></button>
      <div class="nav-section-label canvas-label"><span>我的画布</span><button class="icon-button" title="新建画布" aria-label="新建画布" @click="openCanvasDialog()"><Icon name="plus" :size="16" /></button></div>
      <div class="canvas-nav"><button v-for="canvas in canvases" :key="canvas.id" class="nav-item" :class="{ active: activeId === canvas.id }" @click="switchCanvas(canvas.id)"><Icon name="canvas" /><span>{{ canvas.name }}</span><span class="nav-count">{{ canvas.nodes.length }}</span></button><div v-if="!canvases.length" class="nav-empty">为不同的工作，<br />留一张自己的画布。</div></div>
      <div class="sidebar-divider" />
      <div class="nav-section-label"><span>连接</span><button class="icon-button" title="添加连接" aria-label="添加连接" @click="openSource()"><Icon name="plus" :size="16" /></button></div>
      <div class="source-nav"><button v-for="source in sources" :key="source.id" class="source-nav-item" @click="sourcePanel = true; expandedSource = source.id"><span class="source-badge" :class="source.type">{{ source.type === 'tmux' ? 'T' : 'H' }}</span><span class="source-nav-name">{{ source.name }}<small>{{ source.transport === 'local' ? '本机' : source.target?.replace(/^ssh:\/\//, '') }}</small></span><span class="connection-dot" :class="resources.find(item => item.id === source.id)?.error ? 'disconnected' : 'connected'" /></button><button v-if="!sources.length" class="source-empty" @click="openSource()"><Icon name="plus" :size="15" />添加第一台机器</button></div>
      <div class="sidebar-footer"><button class="sidebar-account" @click="sourcePanel = true"><span class="avatar">{{ username.slice(0, 1).toUpperCase() || 'C' }}</span><span>{{ username || '工作台' }}<small>{{ onlineCount }} 个连接在线</small></span></button><button class="icon-button" title="退出登录" aria-label="退出登录" @click="logout"><Icon name="logout" :size="17" /></button></div>
    </aside>
    <main class="workspace">
      <header class="workspace-header"><div class="breadcrumb"><Icon :name="isOverview ? 'grid' : 'canvas'" :size="18" /><h1>{{ currentName }}</h1><span class="header-divider" /><span class="header-description">{{ isOverview ? '所有机器，一个视野' : '自由排列你的工作窗口' }}</span></div><div class="header-actions"><span v-if="!isOverview && saveState" class="save-state"><Icon v-if="saveState === '已保存'" name="check" :size="13" />{{ saveState }}</span><button v-if="!isOverview" class="icon-button" title="重命名画布" aria-label="重命名画布" @click="openCanvasDialog(currentCanvas)"><Icon name="edit" :size="17" /></button><button v-if="!isOverview" class="icon-button" title="删除画布" aria-label="删除画布" @click="deleteCanvas"><Icon name="trash" :size="17" /></button><button class="button subtle" @click="sourcePanel = true"><Icon name="server" :size="16" />连接</button><button v-if="isOverview" class="button primary" @click="openSource()"><Icon name="plus" :size="16" />添加连接</button><button v-else class="button primary" @click="openAdd()"><Icon name="plus" :size="16" />加入窗口</button></div></header>
      <div class="workspace-subheader"><div><span class="live-dot" /><span>{{ isOverview ? `${sources.length} 个连接 · ${windowCount} 个窗口` : `${currentCanvas?.nodes.length || 0} 个窗口引用` }}</span><span class="muted-dot">·</span><span>{{ isOverview ? '按机器与 Space 自动排列' : '拖动标题栏排列，选中窗口后拖动边缘调整大小' }}</span></div><button class="text-button" :disabled="loading" @click="refreshResources()"><Icon name="refresh" :size="13" :class="{ spinning: loading }" />{{ refreshedAt ? `${refreshedAt} 更新` : '刷新' }}</button></div>
      <div class="graph-wrap">
        <VueFlow v-if="nodes.length && !focused" :key="graphKey" v-model:nodes="nodes" :min-zoom="0.08" :max-zoom="2" :nodes-connectable="false" :nodes-draggable="!isOverview" :zoom-on-double-click="false" :delete-key-code="null" :selection-key-code="null" :pan-on-drag="true" :prevent-scrolling="true" @node-drag-stop="dragStopped" @move-end="saveViewport" @init="restoreViewport"><template #node-terminal="nodeProps"><TerminalNode v-bind="nodeProps" /></template><template #node-group="nodeProps"><GroupNode v-bind="nodeProps" /></template><MiniMap :pannable="true" :zoomable="true" :node-color="node => node.type === 'terminal' ? '#4c545f' : 'transparent'" :node-stroke-width="0" :mask-color="'rgba(17,19,23,.7)'" /></VueFlow>
        <div v-if="!nodes.length && isOverview" class="empty-state"><span class="empty-illustration"><Icon name="server" :size="36" /><i class="empty-orbit one" /><i class="empty-orbit two" /></span><span class="eyebrow">从一台机器开始</span><h2>{{ sources.length ? '连接已添加，准备打开窗口' : '让你的终端，各就各位。' }}</h2><p>{{ sources.length ? '在连接面板中创建一个 space / session，或检查连接状态。' : '添加本机或远程的 herdr / tmux，所有窗口将在这里自动展开。' }}</p><button class="button primary" @click="sources.length ? sourcePanel = true : openSource()"><Icon :name="sources.length ? 'server' : 'plus'" :size="17" />{{ sources.length ? '打开连接面板' : '添加第一个连接' }}</button><span class="empty-note">LOCAL · SSH &nbsp; / &nbsp; HERDR · TMUX</span></div>
        <div v-if="!nodes.length && !isOverview" class="empty-state"><span class="empty-illustration"><Icon name="canvas" :size="40" /></span><span class="eyebrow">留给专注的空间</span><h2>这张画布，等你来安排。</h2><p>从总览中选一些窗口，按自己的方式摆放。<br />同一个窗口可以出现在不同画布中。</p><button class="button primary" @click="openAdd()"><Icon name="plus" :size="17" />加入窗口</button></div>
        <div v-if="nodes.length && !focused" class="canvas-toolbar"><button title="缩小" aria-label="缩小" @click="zoomOut({ duration: 150 })"><Icon name="minus" :size="17" /></button><button title="适合画布" aria-label="适合画布" @click="fitView({ padding: .14, maxZoom: 1, duration: 200 })"><Icon name="expand" :size="17" /></button><button title="放大" aria-label="放大" @click="zoomIn({ duration: 150 })"><Icon name="plus" :size="17" /></button><span /><small>滚轮缩放 · 拖动空白平移</small></div>
        <div class="canvas-watermark">canvas<span>.</span></div>
      </div>
    </main>
    <Transition name="slide"><aside v-if="sourcePanel" class="source-panel"><header><div><span class="eyebrow">CONNECTIONS</span><h2>连接与窗口</h2></div><button class="icon-button" aria-label="关闭连接面板" @click="sourcePanel = false"><Icon name="close" /></button></header><button class="button primary full-width" @click="openSource()"><Icon name="plus" :size="16" />添加连接</button><div class="source-panel-content"><div v-for="source in sources" :key="source.id" class="source-detail"><div class="source-detail-header"><button class="source-expand" @click="expandedSource = expandedSource === source.id ? '' : source.id"><Icon name="chevron" :size="15" :class="{ rotated: expandedSource === source.id }" /><span class="source-badge" :class="source.type">{{ source.type === 'tmux' ? 'T' : 'H' }}</span><span>{{ source.name }}<small>{{ source.type }} · {{ source.transport === 'local' ? '本机' : source.target }}</small></span></button><button class="icon-button" title="编辑连接" aria-label="编辑连接" @click="openSource(source)"><Icon name="edit" :size="14" /></button><button class="icon-button" title="移除连接" aria-label="移除连接" @click="deleteSource(source)"><Icon name="trash" :size="14" /></button></div><template v-if="expandedSource === source.id"><div v-if="resources.find(item => item.id === source.id)?.error" class="source-error">{{ resources.find(item => item.id === source.id)?.error }}</div><div v-for="space in resources.find(item => item.id === source.id)?.spaces || []" :key="space.id" class="space-detail"><div class="space-detail-header"><Icon name="layers" :size="14" /><strong>{{ space.name }}</strong><button class="icon-button" title="新建窗口" aria-label="新建窗口" @click="windowAction({ id: '', sourceId: source.id, spaceId: space.id, windowId: '', x: 0, y: 0, width: 0, height: 0 }, 'create')"><Icon name="plus" :size="14" /></button><button class="icon-button" title="重命名 Space" aria-label="重命名 Space" @click="spaceAction(resources.find(item => item.id === source.id)!, space.id, 'rename')"><Icon name="edit" :size="13" /></button><button class="icon-button danger-hover" title="关闭 Space" aria-label="关闭 Space" @click="spaceAction(resources.find(item => item.id === source.id)!, space.id, 'close')"><Icon name="close" :size="14" /></button></div><div v-for="window in space.windows" :key="window.id" class="window-detail"><Icon name="terminal" :size="14" /><span>{{ window.name }}</span><button class="icon-button" title="加入画布" aria-label="加入画布" @click="openAdd({ id: '', sourceId: source.id, spaceId: space.id, windowId: window.id, x: 0, y: 0, width: 480, height: 302 })"><Icon name="plus" :size="14" /></button><button class="icon-button" title="窗口操作" aria-label="窗口操作" @click="windowMenu = { name: window.name, node: { id: '', sourceId: source.id, spaceId: space.id, windowId: window.id, x: 0, y: 0, width: 480, height: 302 } }"><Icon name="more" :size="15" /></button></div></div><button class="source-new-space" @click="spaceAction(resources.find(item => item.id === source.id) || { ...source, host: '', status: '', spaces: [] }, undefined, 'create')"><Icon name="plus" :size="14" />新建 {{ source.type === 'tmux' ? 'session' : 'space' }}</button></template></div><p v-if="!sources.length" class="panel-empty">还没有连接。添加本机或 SSH 机器开始使用。</p></div><footer><Icon name="info" :size="14" /><span>连接指向现有的 herdr / tmux server。移除连接不会关闭远端进程。</span></footer></aside></Transition>
    <div v-if="focused" class="focus-overlay"><header><div><Icon name="expand" :size="17" /><strong>聚焦模式</strong><span>点击返回画布，退出聚焦</span></div><button class="button subtle" @click="closeFocus"><Icon name="close" :size="16" />返回画布</button></header><TerminalNode :id="focused.id" :data="{ ...terminalData(focused, true), width: focusedSize.width, height: focusedSize.height, overview: true }" /></div>
    <div v-if="modalOpen" class="modal-backdrop" @click.self="!busy && (sourceDialog = false, canvasDialog = false, actionDialog = null, addDialog = false, windowMenu = null)">
      <section v-if="sourceDialog" class="modal source-modal" role="dialog" aria-modal="true" aria-labelledby="source-title"><header><div><span class="eyebrow">CONNECT A SOURCE</span><h2 id="source-title">{{ sourceDraft.id ? '编辑连接' : '添加连接' }}</h2></div><button class="icon-button" aria-label="关闭对话框" @click="sourceDialog = false"><Icon name="close" /></button></header><form @submit.prevent="submitSource"><div class="type-options"><button v-for="type in (['tmux', 'herdr'] as const)" :key="type" type="button" :class="{ selected: sourceDraft.type === type }" @click="sourceDraft.type = type"><span class="source-badge" :class="type">{{ type === 'tmux' ? 'T' : 'H' }}</span><strong>{{ type }}</strong><Icon v-if="sourceDraft.type === type" name="check" :size="16" /></button></div><label>连接名称<input v-model="sourceDraft.name" name="sourceName" required placeholder="例如：开发机器" /></label><div class="segmented-control"><button type="button" :class="{ selected: sourceDraft.transport === 'local' }" @click="sourceDraft.transport = 'local'"><Icon name="server" :size="15" />本机</button><button type="button" :class="{ selected: sourceDraft.transport === 'ssh' }" @click="sourceDraft.transport = 'ssh'"><Icon name="globe" :size="15" />远程 SSH</button></div><label v-if="sourceDraft.transport === 'ssh'">SSH 地址<input v-model="sourceDraft.target" name="target" placeholder="ssh://user@hostname:22" :required="sourceDraft.transport === 'ssh'" /><span class="field-help">使用 Canvas Server 所在机器的 SSH 密钥与配置。</span></label><p v-else class="field-help local-help">连接 Canvas Server 所在机器上的 {{ sourceDraft.type }}。</p><label v-if="sourceDraft.type === 'tmux'">Socket 名称或路径 <span class="optional">可选</span><input v-model="sourceDraft.tmuxSocket" name="tmuxSocket" placeholder="default" /><span class="field-help">自定义 server 填名称（-L），绝对路径使用 -S。</span></label><label v-else>herdr session <span class="optional">可选</span><input v-model="sourceDraft.herdrSession" name="herdrSession" placeholder="default" /></label><details><summary>高级设置</summary><template v-if="sourceDraft.transport === 'ssh'"><label>SSH 私钥路径 <span class="optional">可选</span><input v-model="sourceDraft.sshIdentityFile" name="sshIdentityFile" placeholder="/path/to/id_ed25519" /><span class="field-help">Canvas Server 所在机器上的密钥文件路径。</span></label><label>SSH known_hosts 路径 <span class="optional">可选</span><input v-model="sourceDraft.sshKnownHostsFile" name="sshKnownHostsFile" placeholder="/path/to/known_hosts" /></label></template><label>程序路径 <span class="optional">可选</span><input v-model="sourceDraft.binary" name="binary" :placeholder="sourceDraft.type" /><span class="field-help">程序在目标机器上的绝对路径。</span></label></details><p v-if="dialogError" class="form-error" role="alert">{{ dialogError }}</p><footer><button class="button subtle" type="button" @click="sourceDialog = false">取消</button><button class="button primary" type="submit" :disabled="busy"><span v-if="busy" class="spinner" />{{ busy ? '正在连接…' : '保存连接' }}</button></footer></form></section>
      <section v-else-if="canvasDialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="canvas-title"><header><div><span class="eyebrow">YOUR SPACE</span><h2 id="canvas-title">{{ canvasDraft.id ? '重命名画布' : '新建画布' }}</h2></div><button class="icon-button" aria-label="关闭对话框" @click="canvasDialog = false"><Icon name="close" /></button></header><p>为一组窗口留出专属空间，随时回到你的工作状态。</p><form @submit.prevent="submitCanvas"><label>画布名称<input v-model="canvasDraft.name" name="canvasName" required autofocus placeholder="例如：日常开发" maxlength="80" /></label><p v-if="dialogError" class="form-error">{{ dialogError }}</p><footer><button class="button subtle" type="button" @click="canvasDialog = false">取消</button><button class="button primary" :disabled="busy" type="submit">{{ canvasDraft.id ? '保存' : '创建画布' }}</button></footer></form></section>
      <section v-else-if="actionDialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="action-title"><header><h2 id="action-title">{{ actionDialog.title }}</h2><button class="icon-button" aria-label="关闭对话框" @click="actionDialog = null"><Icon name="close" /></button></header><p>{{ actionDialog.description }}</p><form @submit.prevent="submitAction"><label v-if="actionDialog.label">{{ actionDialog.label }}<input v-model="actionDialog.value" name="resourceName" required autofocus maxlength="120" /></label><p v-if="dialogError" class="form-error" role="alert">{{ dialogError }}</p><footer><button class="button subtle" type="button" @click="actionDialog = null">取消</button><button class="button" :class="actionDialog.danger ? 'danger' : 'primary'" :disabled="busy" type="submit">{{ actionDialog.button }}</button></footer></form></section>
      <section v-else-if="addDialog" class="modal add-modal" role="dialog" aria-modal="true" aria-labelledby="add-title"><header><div><span class="eyebrow">BUILD YOUR WORKSPACE</span><h2 id="add-title">加入窗口</h2></div><button class="icon-button" aria-label="关闭对话框" @click="addDialog = false"><Icon name="close" /></button></header><p>加入的是窗口引用。原来的位置、会话和进程都保留。</p><label>目标画布<select v-model="addTarget"><option v-for="canvas in canvases" :key="canvas.id" :value="canvas.id">{{ canvas.name }}</option><option value="">新建「我的画布」</option></select></label><div class="search-field"><Icon name="search" :size="16" /><input v-model="addSearch" aria-label="搜索窗口" placeholder="搜索连接、Space 或窗口…" /></div><div class="window-picker"><button v-for="item in filteredWindows" :key="item.key" class="window-pick" :class="{ selected: selectedWindows.includes(item.key) }" @click="toggleSelection(item.key)"><span class="checkbox"><Icon v-if="selectedWindows.includes(item.key)" name="check" :size="12" /></span><span class="source-badge" :class="item.source.type">{{ item.source.type === 'tmux' ? 'T' : 'H' }}</span><span><strong>{{ item.window.name }}</strong><small>{{ item.source.name }} / {{ item.space.name }}</small></span></button><p v-if="!filteredWindows.length" class="panel-empty">{{ windowCount ? '没有匹配的窗口' : '还没有可用窗口，请先添加连接并创建窗口。' }}</p></div><p v-if="dialogError" class="form-error">{{ dialogError }}</p><footer><span class="selection-count">已选 {{ selectedWindows.length }} 个窗口</span><button class="button primary" :disabled="busy || !selectedWindows.length" @click="submitAdd">加入画布<Icon name="arrow" :size="16" /></button></footer></section>
      <section v-else-if="windowMenu" class="modal window-menu" role="dialog" aria-modal="true" aria-labelledby="window-title"><header><h2 id="window-title">{{ windowMenu.name }}</h2><button class="icon-button" aria-label="关闭对话框" @click="windowMenu = null"><Icon name="close" /></button></header><button @click="openAdd(windowMenu.node); windowMenu = null"><Icon name="plus" />加入其他画布</button><button @click="windowAction(windowMenu.node, 'rename')"><Icon name="edit" />重命名窗口</button><button class="danger-text" @click="windowAction(windowMenu.node, 'close')"><Icon name="trash" />关闭窗口<span>结束窗口中的进程</span></button></section>
    </div>
    <div v-if="error || success" class="toast" :class="{ 'error-toast': error }" role="status"><Icon :name="error ? 'info' : 'check'" :size="17" /><span>{{ error || success }}</span><button class="icon-button" aria-label="关闭通知" @click="error = ''; success = ''"><Icon name="close" :size="15" /></button></div>
  </div>
</template>
