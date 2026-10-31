<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, ref, useId } from 'vue'
import { useEventListener } from '@vueuse/core'
import UPopover from '@nuxt/ui/components/Popover.vue'
import { paneLabel, paneName, statusColor, statusLabel } from '../status'
import type { PaneResource, ProgramStatus } from '../types'

const { t } = useI18n()
const props = defineProps<{
  panes: PaneResource[]
  status: ProgramStatus
  available: boolean
  connection: 'connecting' | 'connected' | 'disconnected'
  error?: string
  readOnly?: boolean
  pulse?: boolean
}>()
const trigger = ref<HTMLButtonElement>()
const panel = ref<HTMLElement>()
const open = ref(false)
const pinned = ref(false)
const panelId = useId()
const portal = computed(() => trigger.value?.closest<HTMLElement>('.app-shell') || document.body)
let leaveTimer: ReturnType<typeof setTimeout> | undefined
const summary = computed(() => !props.available ? t('terminal.unavailable') : props.connection === 'connecting' ? t('terminal.connection.connecting') : props.connection === 'disconnected' ? t('terminal.connection.disconnected') : statusLabel(props.status))
const color = computed(() => !props.available || props.connection === 'disconnected' ? statusColor('error') : props.connection === 'connecting' ? statusColor('working') : statusColor(props.status))

function contains(target: EventTarget | null) { return target instanceof Node && (trigger.value?.contains(target) || panel.value?.closest('.terminal-status-popover')?.contains(target)) }
function close() { clearTimeout(leaveTimer); open.value = false; pinned.value = false }
function enter() { clearTimeout(leaveTimer); open.value = true }
function leave() { clearTimeout(leaveTimer); leaveTimer = setTimeout(() => { if (!pinned.value && !contains(document.activeElement)) open.value = false }, 100) }
function toggle() { clearTimeout(leaveTimer); pinned.value = !pinned.value; open.value = pinned.value }
function blur(event: FocusEvent) { if (!contains(event.relatedTarget) && (event.relatedTarget || !pinned.value)) close() }
function outside(event: Event) { if (!contains(event.target)) close() }
function escape(event: KeyboardEvent) {
  if (pinned.value) { event.preventDefault(); event.stopPropagation() }
  close()
}
function panelKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  else if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
    // Continue native tab order from the trigger, outside this read-only scope.
    trigger.value?.focus({ preventScroll: true }); close(); event.stopPropagation()
  }
}
const content = computed(() => ({
  'aria-label': t('terminal.windowStatus'),
  side: 'bottom' as const, align: 'start' as const, sideOffset: 6, alignOffset: -8, collisionPadding: 8,
  onMouseenter: enter, onMouseleave: leave,
  onKeydownCapture: panelKeydown,
  onOpenAutoFocus: (event: Event) => event.preventDefault(),
  onCloseAutoFocus: (event: Event) => event.preventDefault(),
  onInteractOutside: (event: Event) => { if (contains(event.target)) event.preventDefault() },
  onEscapeKeyDown: escape,
}))
// Terminal gestures stop propagation; observe dismissal before those handlers.
useEventListener(computed(() => open.value ? document : undefined), ['pointerdown', 'wheel'], outside, { capture: true, passive: true })
onBeforeUnmount(() => clearTimeout(leaveTimer))
</script>

<template>
  <button ref="trigger" class="terminal-status-trigger nodrag cutout-status" :style="{ '--status-color': color }" :data-connection-status="available ? connection : 'unavailable'" :aria-label="t('terminal.statusSummary', { status: summary })" :aria-expanded="open" :aria-controls="panelId" @pointerdown.stop @mouseenter="enter" @mouseleave="leave" @focus="enter" @blur="blur" @click.stop="toggle" @keydown.esc.stop.prevent="close"><i :data-status-pulse="pulse && available && connection === 'connected'" /></button>
  <UPopover :open="open" :reference="trigger" :portal="portal" :content="content" :ui="{ content: 'terminal-status-popover' }" @update:open="value => { if (!value) close() }">
    <template #content><div :id="panelId" ref="panel" role="region" :aria-label="t('terminal.windowStatus')" @pointerdown.stop @wheel.stop @keydown.esc.stop.prevent="close">
      <div class="terminal-status-summary"><i class="program-dot" :style="{ '--program-color': color }" /><span>{{ summary }}</span><small v-if="readOnly && connection === 'connected'">{{ t('terminal.readOnly') }}</small></div>
      <p v-if="error" class="terminal-status-error">{{ error }}</p>
      <div v-if="available && panes.length" class="pane-status-list">
        <div v-for="pane in panes" :key="pane.id" class="pane-status-row" :class="{ active: pane.active }" :style="{ '--program-color': statusColor(pane.status) }" :data-pane-id="pane.id" :data-program-status="pane.status" :title="paneLabel(pane)">
          <i class="program-dot" /><span class="pane-status-name">{{ paneName(pane) }}<small v-if="pane.agent && pane.agent !== pane.name">{{ pane.agent }}</small></span><span class="pane-status-value">{{ statusLabel(pane.status) }}</span>
        </div>
      </div>
    </div></template>
  </UPopover>
</template>
