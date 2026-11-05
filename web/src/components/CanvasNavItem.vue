<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useTimeoutFn } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UPopover from '@nuxt/ui/components/Popover.vue'
import Icon from './Icon.vue'
import WindowTitle from './WindowTitle.vue'
import { paneName, statusColor, statusLabel } from '../status'
import { windowLabel } from '../window-title'
import { usePointerDismiss } from '../pointer-dismiss'
import type { CanvasIndicator } from '../canvas-status'
import type { CanvasAgent } from '../canvas-agents'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ name: string; overview?: boolean; active?: boolean; indicator?: CanvasIndicator; agents(): CanvasAgent[]; actionsAvailable?: boolean; open?: boolean }>()
const emit = defineEmits<{ select: []; 'update:open': [open: boolean]; go: [target: Pick<CanvasAgent, 'sourceId' | 'windowId'>] }>()
const { t, n } = useI18n()
const label = computed(() => props.indicator?.status ? t('canvasUi.canvasStatus', { name: props.name, status: statusLabel(props.indicator.status) }) : props.name)
const trigger = ref<HTMLButtonElement>(), panel = ref<HTMLElement>(), pinned = ref(false)
const open = computed({ get: () => !!props.open, set: value => emit('update:open', value) })
const panelId = useId(), portal = computed(() => trigger.value?.closest<HTMLElement>('.app-shell') || document.body)
const agents = computed(() => props.agents())
const dismiss = usePointerDismiss(open, trigger)
const { start: leave, stop: stopLeave } = useTimeoutFn(() => {
  if (!pinned.value && !panel.value?.contains(document.activeElement) && document.activeElement !== trigger.value) open.value = false
}, 120, { immediate: false })
function enter(event?: PointerEvent) {
  if (event?.pointerType === 'touch') return
  stopLeave(); open.value = true
}
function close() { stopLeave(); open.value = false }
function focusFirst() {
  const target = panel.value?.querySelector<HTMLButtonElement>('button:not(:disabled)') || panel.value
  target?.focus({ preventScroll: true })
}
function toggle(event: MouseEvent) {
  stopLeave(); pinned.value = !pinned.value; open.value = pinned.value
  // A hover-open panel is already mounted. Newly opened panels use native autofocus.
  if (pinned.value && event.detail === 0) focusFirst()
}
function go(agent: CanvasAgent) {
  if (!agent.available || props.actionsAvailable === false) return
  close(); emit('go', { sourceId: agent.sourceId, windowId: agent.windowId })
}
watch(open, value => { if (!value) pinned.value = false })
watch(() => props.indicator?.status, value => { if (!value) close() })
const content = computed(() => ({ 'aria-label': t('canvasUi.agentsInCanvas', { name: props.name }),
  side: 'right' as const, align: 'start' as const, sideOffset: 8, collisionPadding: 8, prioritizePosition: true,
  onPointerenter: enter, onPointerleave: () => leave(),
  onOpenAutoFocus: (event: Event) => { event.preventDefault(); if (pinned.value) focusFirst() },
  ...dismiss,
  onInteractOutside: (event: Event) => { dismiss.onInteractOutside(); if (event.target instanceof Node && trigger.value?.contains(event.target)) event.preventDefault() },
  onEscapeKeyDown: (event: Event) => { event.preventDefault(); close(); trigger.value?.focus({ preventScroll: true }) },
}))
</script>

<template>
  <div class="canvas-nav-row">
    <button v-bind="$attrs" class="nav-item canvas-nav-item" :class="{ active }" :aria-current="active ? 'page' : undefined" :aria-label="label" :title="label" @click="emit('select')">
      <Icon :name="overview ? 'grid' : 'canvas'" :size="16" />
      <span class="canvas-nav-name"><span>{{ name }}</span><small v-if="indicator" class="canvas-nav-count">{{ n(indicator.count) }}</small></span>
    </button>
    <button v-if="indicator?.status" ref="trigger" type="button" class="canvas-nav-status canvas-agent-trigger" aria-haspopup="dialog" data-no-reorder :aria-label="t('canvasUi.agentsInCanvas', { name })" :aria-expanded="open" :aria-controls="panelId" @pointerenter="enter" @pointerleave="leave()" @click.stop="toggle" @keydown.esc.stop.prevent="close">
      <i class="program-dot" :style="{ '--program-color': statusColor(indicator.status) }" />
    </button>
    <UPopover v-model:open="open" :modal="false" :reference="trigger" :portal="portal" :content="content"
      :ui="{ content: 'canvas-agent-popover z-[80] w-[320px] max-w-[calc(var(--ui-viewport-width)-16px)] max-h-[min(420px,var(--reka-popover-content-available-height))] overflow-y-auto' }">
      <template #content>
        <div :id="panelId" ref="panel" class="canvas-agents-panel" tabindex="-1">
          <div class="canvas-agents-heading"><span>{{ t('canvasUi.agents') }}</span><small>{{ n(agents.length) }}</small></div>
          <p v-if="!agents.length" class="canvas-agents-empty">{{ t('canvasUi.noAgents') }}</p>
          <button v-for="agent in agents" :key="agent.key" type="button" class="canvas-agent-row" :data-agent-id="agent.key" :data-window-id="agent.windowId" :disabled="!agent.available || actionsAvailable === false" :title="[agent.context, windowLabel(agent.window, agent.pane.id)].join('\n')" @click="go(agent)">
            <i class="program-dot" :style="{ '--program-color': statusColor(agent.status) }" />
            <span class="canvas-agent-description"><strong>{{ agent.pane.agent || paneName(agent.pane) }}</strong><WindowTitle :window="agent.window" :pane-id="agent.pane.id" /><small>{{ agent.context }}</small></span>
            <span class="canvas-agent-state" :style="{ color: statusColor(agent.status) }">{{ agent.available ? statusLabel(agent.status) : t('canvasUi.agentUnavailable') }}</span>
          </button>
        </div>
      </template>
    </UPopover>
  </div>
</template>

<style scoped>
.canvas-nav-row{position:relative}
.canvas-agent-trigger{position:absolute;right:0;top:2px;bottom:0;width:var(--sidebar-rail);padding:0;border-radius:5px;-webkit-tap-highlight-color:transparent}
.canvas-agent-trigger:hover,.canvas-agent-trigger[aria-expanded=true]{background:#ffffff0b}
.canvas-agent-trigger:focus-visible{outline-offset:-2px}
.canvas-agents-panel{outline:none;padding:5px}
.canvas-agents-heading{display:flex;align-items:baseline;justify-content:space-between;padding:7px 9px;color:#c7ced8;font-size:12px}
.canvas-agents-heading small{color:#818c9b;font-size:10px}
.canvas-agents-empty{padding:12px 9px;color:#8994a4;font-size:12px}
.canvas-agent-row{display:flex;width:100%;align-items:center;gap:9px;padding:9px;border-radius:5px;text-align:left;color:#bdc5d1}
.canvas-agent-row:hover:not(:disabled){background:#ffffff08}
.canvas-agent-row:focus-visible{outline-offset:-2px}
.canvas-agent-row:disabled{opacity:.55;cursor:not-allowed}
.canvas-agent-row>.program-dot{flex:none;width:6px;height:6px}
.canvas-agent-description{display:flex;flex:1;min-width:0;flex-direction:column;gap:3px;font-size:11px}
.canvas-agent-description strong{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.canvas-agent-description>small{font-size:10px;color:#7f8b9d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.canvas-agent-state{flex:none;font-size:10px;white-space:nowrap}
</style>
