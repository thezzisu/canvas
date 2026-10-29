<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import { NodeResizer } from '@vue-flow/node-resizer'
import Icon from './Icon.vue'
import PaneIndicators from './PaneIndicators.vue'
import { statusColor } from '../status'
import { mountTerminal, type TerminalStatus } from '../terminals'
import type { TerminalData } from '../types'
const props = defineProps<Pick<NodeProps<TerminalData>, 'id' | 'data'> & Partial<Omit<NodeProps<TerminalData>, 'id' | 'data'>>>()
const host = ref<HTMLElement>()
const status = ref<TerminalStatus>({ status: 'connecting' })
const maximizedElsewhere = computed(() => !!status.value.presentation?.maximized && (!status.value.presentation.owned || !props.data.focus))
const frameStatus = computed(() => !props.data.available || status.value.status === 'disconnected' ? 'error' : status.value.status === 'connecting' ? 'unknown' : props.data.status)
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
const resizeNotes: Record<string, string> = { 'external-resize': '尺寸由外部终端调整', superseded: '尺寸由其他视图调整', unavailable: '终端暂不支持调整尺寸' }
const title = computed(() => [props.data.name, props.data.subtitle, props.data.focus && resizeNotes[status.value.focusResize?.reason || '']].filter(Boolean).join('\n'))
let terminal: ReturnType<typeof mountTerminal> | undefined
let ownedPresentation = false
function mount() {
  if (host.value && props.data.available) terminal = mountTerminal(host.value, props.data, state => {
    const superseded = ownedPresentation && state.presentation?.maximized && !state.presentation.owned
    ownedPresentation = props.data.focus && state.presentation?.owned === true
    status.value = state
    if (superseded) props.data.onAction('unfocus', props.id)
  }, geometry => {
    if (props.data.focus || maximizedElsewhere.value) return
    const element = host.value
    const card = element?.closest<HTMLElement>('.terminal-card')
    if (!element || !card) return
    const style = getComputedStyle(element)
    const insetX = card.offsetWidth - element.clientWidth + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    const insetY = card.offsetHeight - element.clientHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    props.data.onGeometry(props.data.sourceId, props.data.windowId, geometry.height / geometry.width, insetX, insetY)
  }, { magnified: props.data.focus })
}
onMounted(mount)
watch(() => props.data.available, async () => { terminal?.dispose(); terminal = undefined; await nextTick(); mount() })
onBeforeUnmount(() => terminal?.dispose())
function action(name: string) {
  if (name === 'reconnect') terminal?.reconnect()
  else props.data.onAction(name, props.id)
}
async function resized(event: { params: { width: number; height: number; x: number; y: number } }) {
  if (props.data.overview || props.data.focus) return
  await nextTick()
  // Read the user's final rectangle before normalizing its view to the new grid.
  terminal?.resize()
  props.data.onResize(props.id, event.params.width, event.params.height, event.params.x, event.params.y)
}
</script>
<template>
  <NodeResizer v-if="!data.overview && !data.focus && !maximizedElsewhere" :is-visible="selected" :min-width="360" :min-height="220" :max-width="4000" :max-height="3000" @resize-start="data.onLayoutStart" @resize-end="resized" />
  <article class="terminal-card" :class="[{ selected, unavailable: !data.available, focused: data.focus }, `program-${frameStatus}`]" :data-source-id="data.sourceId" :data-space-id="data.spaceId" :data-window-id="data.windowId" :data-connection-status="data.available ? status.status : 'unavailable'" :data-presentation="maximizedElsewhere ? 'paused' : data.focus ? 'maximized' : 'normal'" :data-program-status="data.status" :data-resize-state="resizeState" :data-resize-reason="status.focusResize?.reason" :style="{ '--program-color': statusColor(frameStatus), width: dimensions ? '100%' : `${data.width}px`, height: dimensions ? '100%' : `${data.height}px` }" :aria-label="`${data.name} · ${data.subtitle}`">
    <header class="terminal-header drag-handle">
      <PaneIndicators :panes="data.panes" :status="data.status" :available="data.available" :connection="status.status" :error="status.error" :read-only="status.readOnly" />
      <span class="terminal-name" :title="title">{{ data.name }}</span>
      <div class="terminal-actions nodrag">
        <button v-if="data.overview" title="加入画布" aria-label="加入画布" @click.stop="action('add')"><Icon name="plus" :size="15" /></button>
        <button v-else title="从画布移除" aria-label="从画布移除" @click.stop="action('remove')"><Icon name="minus" :size="15" /></button>
        <button v-if="!data.focus" title="聚焦窗口" aria-label="聚焦窗口" @click.stop="action('focus')"><Icon name="expand" :size="14" /></button>
        <button title="窗口操作" aria-label="窗口操作" @click.stop="action('menu')"><Icon name="more" :size="17" /></button>
        <button v-if="data.focus" title="退出放大" aria-label="退出放大" @click.stop="action('unfocus')"><Icon name="collapse" :size="15" /></button>
      </div>
    </header>
    <div v-if="data.available" ref="host" class="terminal-host nodrag nopan nowheel" :class="{ 'terminal-paused': maximizedElsewhere, 'terminal-drop-target': status.draggingFile }" :style="data.focus ? { overflow: 'auto' } : undefined" @pointerdown.stop="terminal?.focus()" @mousedown.stop @wheel.stop @dblclick.stop />
    <div v-if="status.draggingFile" class="terminal-file-drop" aria-hidden="true">上传文件</div>
    <span v-if="status.clipboardError" class="terminal-copy-notice" :class="{ 'copy-failed': status.clipboardError === '复制失败' }" role="status">{{ status.clipboardError }}</span>
    <div v-if="status.upload" class="terminal-upload nodrag nopan" :class="{ 'upload-failed': status.upload.state === 'failed' }" :data-upload-id="status.upload.id" :data-upload-state="status.upload.state" @pointerdown.stop @mousedown.stop>
      <div class="terminal-upload-row"><span class="terminal-upload-name" :title="status.upload.name">{{ status.upload.name }}</span><small v-if="status.upload.queued">+{{ status.upload.queued }}</small><span class="terminal-upload-status" role="status">{{ uploadLabel }}</span><button :aria-label="uploadActive ? '取消上传' : '关闭上传状态'" :disabled="status.upload.cancelling" @click.stop="terminal?.cancelUpload()"><Icon name="close" :size="13" /></button></div>
      <div v-if="uploadActive" class="terminal-upload-track" role="progressbar" :aria-valuenow="status.upload.transferred" :aria-valuemin="0" :aria-valuemax="status.upload.total" :aria-valuetext="`${uploadPercent}%`" aria-label="文件上传进度"><span :style="{ width: `${uploadPercent}%` }" /></div>
    </div>
    <div v-if="data.available && maximizedElsewhere" class="terminal-maximized">已最大化</div>
    <div v-if="!data.available" class="terminal-unavailable"><Icon name="terminal" :size="28" /><strong>窗口不可用</strong></div>
    <div v-if="data.available && status.status === 'disconnected'" class="terminal-disconnected nodrag"><span>{{ status.error || '终端连接已断开' }}</span><button @click.stop="action('reconnect')"><Icon name="refresh" :size="13" />重连</button></div>
    <div v-if="data.available && status.status === 'connecting'" class="terminal-loading nodrag"><span class="spinner" />连接中</div>
  </article>
</template>

<style scoped>
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
</style>
