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
const frameStatus = computed(() => !props.data.available || status.value.status === 'disconnected' ? 'error' : status.value.status === 'connecting' ? 'unknown' : props.data.status)
const resizeState = computed(() => !props.data.focus ? 'passive' : !status.value.focusResize ? 'pending' : status.value.focusResize.owned ? 'owned' : 'passive')
const resizeNotes: Record<string, string> = { 'external-resize': '尺寸由外部终端调整', superseded: '尺寸由其他视图调整', unavailable: '终端暂不支持调整尺寸' }
const title = computed(() => [props.data.name, props.data.subtitle, props.data.focus && resizeNotes[status.value.focusResize?.reason || '']].filter(Boolean).join('\n'))
let terminal: ReturnType<typeof mountTerminal> | undefined
function mount() {
  if (host.value && props.data.available) terminal = mountTerminal(host.value, props.data, state => {
    status.value = state
    if (props.data.focus && state.focusResize?.reason === 'superseded' && !state.focusResize.owned) props.data.onAction('unfocus', props.id)
  }, geometry => {
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
  <NodeResizer v-if="!data.overview && !data.focus" :is-visible="selected" :min-width="360" :min-height="220" :max-width="4000" :max-height="3000" @resize-start="data.onLayoutStart" @resize-end="resized" />
  <article class="terminal-card" :class="[{ selected, unavailable: !data.available, focused: data.focus }, `program-${frameStatus}`]" :data-source-id="data.sourceId" :data-space-id="data.spaceId" :data-window-id="data.windowId" :data-connection-status="data.available ? status.status : 'unavailable'" :data-program-status="data.status" :data-resize-state="resizeState" :data-resize-reason="status.focusResize?.reason" :style="{ '--program-color': statusColor(frameStatus), width: dimensions ? '100%' : `${data.width}px`, height: dimensions ? '100%' : `${data.height}px` }" :aria-label="`${data.name} · ${data.subtitle}`">
    <header class="terminal-header drag-handle">
      <PaneIndicators :panes="data.panes" :status="data.status" :available="data.available" :connection="status.status" :error="status.error" :read-only="status.readOnly" />
      <span class="terminal-name" :title="title">{{ data.name }}</span>
      <div class="terminal-actions nodrag">
        <button v-if="data.overview" title="加入画布" aria-label="加入画布" @click.stop="action('add')"><Icon name="plus" :size="15" /></button>
        <button v-else title="从画布移除" aria-label="从画布移除" @click.stop="action('remove')"><Icon name="minus" :size="15" /></button>
        <button v-if="!data.focus" title="聚焦窗口" aria-label="聚焦窗口" @click.stop="action('focus')"><Icon name="expand" :size="14" /></button>
        <button title="窗口操作" aria-label="窗口操作" @click.stop="action('menu')"><Icon name="more" :size="17" /></button>
        <button v-if="data.focus" title="返回画布" aria-label="返回画布" @click.stop="action('unfocus')"><Icon name="close" :size="15" /></button>
      </div>
    </header>
    <div v-if="data.available" ref="host" class="terminal-host nodrag nowheel" :style="data.focus ? { overflow: 'auto' } : undefined" @pointerdown.stop="terminal?.focus()" @wheel.stop @dblclick.stop />
    <div v-else class="terminal-unavailable"><Icon name="terminal" :size="28" /><strong>窗口不可用</strong></div>
    <div v-if="data.available && status.status === 'disconnected'" class="terminal-disconnected nodrag"><span>{{ status.error || '终端连接已断开' }}</span><button @click.stop="action('reconnect')"><Icon name="refresh" :size="13" />重连</button></div>
    <div v-if="data.available && status.status === 'connecting'" class="terminal-loading nodrag"><span class="spinner" />连接中</div>
  </article>
</template>
