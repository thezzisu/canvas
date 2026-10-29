<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { paneLabel, paneName, statusColor, statusLabel } from '../status'
import type { PaneResource, ProgramStatus } from '../types'

const props = defineProps<{
  panes: PaneResource[]
  status: ProgramStatus
  available: boolean
  connection: 'connecting' | 'connected' | 'disconnected'
  error?: string
  readOnly?: boolean
}>()
const trigger = ref<HTMLButtonElement>()
const panel = ref<HTMLElement>()
const open = ref(false)
const pinned = ref(false)
const panelId = useId()
const position = ref({ left: '0px', top: '0px' })
const portal = computed(() => trigger.value?.closest('.app-shell') || document.body)
let leaveTimer: ReturnType<typeof setTimeout> | undefined
const summary = computed(() => !props.available ? '窗口不可用' : props.connection === 'connecting' ? '连接中' : props.connection === 'disconnected' ? '连接已断开' : statusLabel(props.status))
const color = computed(() => !props.available || props.connection === 'disconnected' ? statusColor('error') : props.connection === 'connecting' ? statusColor('working') : statusColor(props.status))

function contains(target: EventTarget | null) { return target instanceof Node && (trigger.value?.contains(target) || panel.value?.contains(target)) }
function close() { clearTimeout(leaveTimer); open.value = false; pinned.value = false }
function enter() { clearTimeout(leaveTimer); open.value = true }
function leave() { clearTimeout(leaveTimer); leaveTimer = setTimeout(() => { if (!pinned.value && !contains(document.activeElement)) open.value = false }, 100) }
function toggle() { clearTimeout(leaveTimer); pinned.value = !pinned.value; open.value = pinned.value }
function blur(event: FocusEvent) { if (!contains(event.relatedTarget) && (event.relatedTarget || !pinned.value)) close() }
function outside(event: PointerEvent) { if (!contains(event.target)) close() }
function outsideWheel(event: WheelEvent) { if (!contains(event.target)) close() }
function escape(event: KeyboardEvent) { if (pinned.value && event.key === 'Escape') { close(); event.preventDefault(); event.stopPropagation() } }
function positionPanel() {
  const anchor = trigger.value?.getBoundingClientRect()
  if (!anchor || !panel.value) return
  const width = panel.value.offsetWidth, height = panel.value.offsetHeight
  const viewport = window.visualViewport
  const x = viewport?.offsetLeft || 0, y = viewport?.offsetTop || 0
  const right = x + (viewport?.width || window.innerWidth), bottom = y + (viewport?.height || window.innerHeight)
  panel.value.style.maxHeight = `${Math.max(64, bottom - y - 16)}px`
  const left = Math.max(x + 8, Math.min(anchor.left - 8, right - width - 8))
  const top = anchor.bottom + height + 8 <= bottom ? anchor.bottom + 6 : Math.max(y + 8, anchor.top - height - 6)
  position.value = { left: `${left}px`, top: `${top}px` }
}
watch(open, async value => {
  if (value) {
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('wheel', outsideWheel, { capture: true, passive: true })
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', positionPanel)
    window.addEventListener('scroll', positionPanel, true)
    window.visualViewport?.addEventListener('resize', positionPanel)
    window.visualViewport?.addEventListener('scroll', positionPanel)
    await nextTick()
    positionPanel()
  } else {
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('wheel', outsideWheel, true)
    document.removeEventListener('keydown', escape, true)
    window.removeEventListener('resize', positionPanel)
    window.removeEventListener('scroll', positionPanel, true)
    window.visualViewport?.removeEventListener('resize', positionPanel)
    window.visualViewport?.removeEventListener('scroll', positionPanel)
  }
})
watch(() => [props.panes.length, props.error], async () => { if (open.value) { await nextTick(); positionPanel() } })
onBeforeUnmount(() => {
  clearTimeout(leaveTimer)
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('wheel', outsideWheel, true)
  document.removeEventListener('keydown', escape, true)
  window.removeEventListener('resize', positionPanel)
  window.removeEventListener('scroll', positionPanel, true)
  window.visualViewport?.removeEventListener('resize', positionPanel)
  window.visualViewport?.removeEventListener('scroll', positionPanel)
})
</script>

<template>
  <button ref="trigger" class="terminal-status-trigger nodrag" :class="{ connecting: available && connection === 'connecting' }" :style="{ '--status-color': color }" :data-connection-status="available ? connection : 'unavailable'" :aria-label="`窗口状态：${summary}`" :aria-expanded="open" :aria-controls="panelId" @pointerdown.stop @mouseenter="enter" @mouseleave="leave" @focus="enter" @blur="blur" @click.stop="toggle" @keydown.esc.stop.prevent="close"><i /></button>
  <Teleport :to="portal">
    <div v-if="open" :id="panelId" ref="panel" class="terminal-status-popover" :style="position" role="region" aria-label="窗口状态" @mouseenter="enter" @mouseleave="leave" @pointerdown.stop @wheel.stop @keydown.esc.stop.prevent="close">
      <div class="terminal-status-summary"><i class="program-dot" :style="{ '--program-color': color }" /><span>{{ summary }}</span><small v-if="readOnly && connection === 'connected'">只读</small></div>
      <p v-if="error" class="terminal-status-error">{{ error }}</p>
      <div v-if="available && panes.length" class="pane-status-list">
        <div v-for="pane in panes" :key="pane.id" class="pane-status-row" :class="{ active: pane.active }" :style="{ '--program-color': statusColor(pane.status) }" :data-pane-id="pane.id" :data-program-status="pane.status" :title="paneLabel(pane)">
          <i class="program-dot" /><span class="pane-status-name">{{ paneName(pane) }}<small v-if="pane.agent && pane.agent !== pane.name">{{ pane.agent }}</small></span><span class="pane-status-value">{{ statusLabel(pane.status) }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>
