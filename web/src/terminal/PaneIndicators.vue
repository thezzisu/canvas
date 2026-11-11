<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, ref, useId } from 'vue'
import { useEventListener } from '@vueuse/core'
import UBadge from '@nuxt/ui/components/Badge.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UPopover from '@nuxt/ui/components/Popover.vue'
import { paneLabel, paneName, statusColor, statusLabel } from '../lib/status'
import { needsAttention } from '../workspace/canvas-status'
import type { PaneResource, ProgramStatus } from '../api/types'

const { t } = useI18n()
const props = defineProps<{
  panes: PaneResource[]
  status: ProgramStatus
  available: boolean
  connection: 'connecting' | 'connected' | 'disconnected' | 'closed'
  error?: string
  readOnly?: boolean
  fresh?: boolean
}>()
const triggerButton = ref<{ $el: HTMLElement }>()
const trigger = computed(() => triggerButton.value?.$el)
const panel = ref<HTMLElement>()
const open = ref(false)
const pinned = ref(false)
const panelId = useId()
let leaveTimer: ReturnType<typeof setTimeout> | undefined
const summary = computed(() =>
  props.connection === 'closed'
    ? t('terminal.closed')
    : !props.available
      ? t('terminal.unavailable')
      : props.connection === 'connecting'
        ? t('terminal.connection.connecting')
        : props.connection === 'disconnected'
          ? t('terminal.connection.disconnected')
          : statusLabel(props.status),
)
const color = computed(() =>
  props.connection === 'closed'
    ? statusColor('unknown')
    : !props.available || props.connection === 'disconnected'
      ? statusColor('error')
      : props.connection === 'connecting'
        ? statusColor('working')
        : statusColor(props.status),
)
const live = computed(() => !!props.fresh && props.available && props.connection === 'connected')

function contains(target: EventTarget | null) {
  return (
    target instanceof Node &&
    (trigger.value?.contains(target) || panel.value?.parentElement?.contains(target))
  )
}
function close() {
  clearTimeout(leaveTimer)
  open.value = false
  pinned.value = false
}
function enter() {
  clearTimeout(leaveTimer)
  open.value = true
}
function leave() {
  clearTimeout(leaveTimer)
  leaveTimer = setTimeout(() => {
    if (!pinned.value && !contains(document.activeElement)) open.value = false
  }, 100)
}
function toggle() {
  clearTimeout(leaveTimer)
  pinned.value = !pinned.value
  open.value = pinned.value
}
function blur(event: FocusEvent) {
  if (!contains(event.relatedTarget) && (event.relatedTarget || !pinned.value)) close()
}
function outside(event: Event) {
  if (!contains(event.target)) close()
}
function escape(event: KeyboardEvent) {
  if (pinned.value) {
    event.preventDefault()
    event.stopPropagation()
  }
  close()
}
function panelKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
  } else if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
    // Continue native tab order from the trigger, outside this read-only scope.
    trigger.value?.focus({ preventScroll: true })
    close()
    event.stopPropagation()
  }
}
const content = computed(() => ({
  'aria-label': t('terminal.windowStatus'),
  side: 'bottom' as const,
  align: 'start' as const,
  sideOffset: 6,
  collisionPadding: 8,
  onMouseenter: enter,
  onMouseleave: leave,
  onKeydownCapture: panelKeydown,
  onOpenAutoFocus: (event: Event) => event.preventDefault(),
  onCloseAutoFocus: (event: Event) => event.preventDefault(),
  onInteractOutside: (event: Event) => {
    if (contains(event.target)) event.preventDefault()
  },
  onEscapeKeyDown: escape,
}))
// Terminal gestures stop propagation; observe dismissal before those handlers.
useEventListener(
  computed(() => (open.value ? document : undefined)),
  ['pointerdown', 'wheel'],
  outside,
  { capture: true, passive: true },
)
onBeforeUnmount(() => clearTimeout(leaveTimer))
</script>

<template>
  <UButton
    ref="triggerButton"
    color="neutral"
    variant="ghost"
    size="md"
    square
    class="terminal-status-trigger nodrag cutout-status justify-center"
    :active="open"
    :data-connection-status="available ? connection : 'unavailable'"
    :aria-label="t('terminal.statusSummary', { status: summary })"
    :aria-expanded="open"
    :aria-controls="panelId"
    @pointerdown.stop
    @mouseenter="enter"
    @mouseleave="leave"
    @focus="enter"
    @blur="blur"
    @click.stop="toggle"
    @keydown.esc.stop.prevent="close"
  >
    <span class="grid size-5 place-items-center"
      ><i
        class="program-dot"
        :style="{ '--program-color': color }"
        :data-status-pulse="live && needsAttention(status)"
    /></span>
  </UButton>
  <UPopover
    :open="open"
    :reference="trigger"
    :content="content"
    :ui="{
      content:
        'w-[264px] max-w-[calc(var(--ui-viewport-width)-16px)] max-h-(--reka-popover-content-available-height) overflow-y-auto p-3 text-xs',
    }"
    @update:open="
      (value) => {
        if (!value) close()
      }
    "
  >
    <template #content
      ><div
        :id="panelId"
        ref="panel"
        role="region"
        :aria-label="t('terminal.windowStatus')"
        @pointerdown.stop
        @wheel.stop
        @keydown.esc.stop.prevent="close"
      >
        <div class="flex items-center gap-2">
          <i
            class="program-dot"
            :data-status-pulse="live && needsAttention(status)"
            :style="{ '--program-color': color }"
          /><span class="flex-1">{{ summary }}</span
          ><UBadge
            v-if="readOnly && connection === 'connected'"
            color="neutral"
            variant="subtle"
            size="sm"
            >{{ t('terminal.readOnly') }}</UBadge
          >
        </div>
        <p v-if="error" class="mt-2 text-error [overflow-wrap:anywhere]">{{ error }}</p>
        <div
          v-if="available && panes.length"
          class="pane-status-list -mx-3 mt-2 -mb-1.5 border-t border-default pt-1"
        >
          <div
            v-for="pane in panes"
            :key="pane.id"
            class="pane-status-row flex min-h-8 items-center gap-2 px-3 py-1.5"
            :class="{ 'bg-elevated/50': pane.active }"
            :style="{ '--program-color': statusColor(pane.status) }"
            :data-pane-id="pane.id"
            :data-program-status="pane.status"
            :title="paneLabel(pane)"
          >
            <i class="program-dot" :data-status-pulse="live && needsAttention(pane.status)" /><span
              class="min-w-0 flex-1 truncate"
              >{{ paneName(pane)
              }}<span
                v-if="pane.agent && pane.agent !== pane.name"
                class="block truncate text-muted"
                >{{ pane.agent }}</span
              ></span
            ><span
              class="flex-none"
              :class="pane.status === 'unknown' ? 'text-muted' : 'text-(--program-color)'"
              >{{ statusLabel(pane.status) }}</span
            >
          </div>
        </div>
      </div></template
    >
  </UPopover>
</template>
