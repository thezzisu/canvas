<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import { NodeResizer } from '@vue-flow/node-resizer'
import Icon from './Icon.vue'
import PaneIndicators from './PaneIndicators.vue'
import { paneLabel, statusColor, statusLabel } from '../status'
import { mountTerminal, type TerminalStatus } from '../terminals'
import type { TerminalData } from '../types'
const props = defineProps<Pick<NodeProps<TerminalData>, 'id' | 'data'> & Partial<Omit<NodeProps<TerminalData>, 'id' | 'data'>>>()
const host = ref<HTMLElement>()
const status = ref<TerminalStatus>({ status: 'connecting' })
let terminal: ReturnType<typeof mountTerminal> | undefined
function mount() {
  if (host.value && props.data.available) terminal = mountTerminal(host.value, props.data, state => { status.value = state })
}
onMounted(mount)
watch(() => props.data.available, async () => { terminal?.dispose(); terminal = undefined; await nextTick(); mount() })
onBeforeUnmount(() => terminal?.dispose())
function action(name: string) {
  if (name === 'reconnect') terminal?.reconnect()
  else props.data.onAction(name, props.id)
}
async function resized(event: { params: { width: number; height: number; x: number; y: number } }) {
  props.data.onResize(props.id, event.params.width, event.params.height, event.params.x, event.params.y)
  await nextTick()
  terminal?.resize()
}
</script>
<template>
  <NodeResizer v-if="!data.overview" :is-visible="selected" :min-width="360" :min-height="220" :max-width="4000" :max-height="3000" @resize-end="resized" />
  <article class="terminal-card" :class="[{ selected, unavailable: !data.available }, `program-${data.status}`]" :data-program-status="data.status" :style="{ '--program-color': statusColor(data.available ? data.status : 'unknown'), width: dimensions ? '100%' : `${data.width}px`, height: dimensions ? '100%' : `${data.height}px` }" :aria-label="`${data.subtitle} · ${data.name}`">
    <header class="terminal-header drag-handle">
      <span class="terminal-kind" :class="data.type">{{ data.type === 'tmux' ? 'T' : 'H' }}</span>
      <span class="terminal-name" :title="data.name">{{ data.name }}</span>
      <span v-if="data.available && data.status !== 'unknown'" class="terminal-program-status" :title="data.panes.length === 1 ? paneLabel(data.panes[0]!) : statusLabel(data.status)">{{ statusLabel(data.status) }}</span>
      <span class="terminal-subtitle" :title="data.subtitle">{{ data.subtitle }}</span>
      <span class="connection-dot" :class="data.available ? status.status : 'disconnected'" :title="status.error || status.status" />
      <div class="terminal-actions nodrag">
        <button v-if="data.overview" title="加入画布" aria-label="加入画布" @click.stop="action('add')"><Icon name="plus" :size="15" /></button>
        <button v-else title="从画布移除" aria-label="从画布移除" @click.stop="action('remove')"><Icon name="minus" :size="15" /></button>
        <button title="聚焦窗口" aria-label="聚焦窗口" @click.stop="action('focus')"><Icon name="expand" :size="14" /></button>
        <button title="窗口操作" aria-label="窗口操作" @click.stop="action('menu')"><Icon name="more" :size="17" /></button>
      </div>
    </header>
    <PaneIndicators v-if="data.available" :panes="data.panes" />
    <div v-if="data.available" ref="host" class="terminal-host nodrag nowheel" @pointerdown.stop="terminal?.focus()" @wheel.stop @dblclick.stop />
    <div v-else class="terminal-unavailable"><Icon name="terminal" :size="28" /><strong>窗口不可用</strong></div>
    <div v-if="data.available && status.status === 'disconnected'" class="terminal-disconnected nodrag"><span>{{ status.error || '终端连接已断开' }}</span><button @click.stop="action('reconnect')"><Icon name="refresh" :size="13" />重连</button></div>
    <div v-if="data.available && status.status === 'connecting'" class="terminal-loading nodrag"><span class="spinner" />连接中</div>
  </article>
</template>
