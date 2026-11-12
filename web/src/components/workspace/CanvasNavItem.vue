<script setup lang="ts">
import { computed, ref, shallowRef, useId, watch } from 'vue'
import { useTimeoutFn } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UPopover from '@nuxt/ui/components/Popover.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import WindowTitle from './WindowTitle.vue'
import { paneName, statusColor, statusLabel } from '../../utils/status'
import { windowLabel } from '../../utils/workspace/window-title'
import { usePointerDismiss } from '../../composables/pointer-dismiss'
import { needsAttention, type CanvasIndicator } from '../../utils/workspace/canvas-status'
import type { CanvasAgent } from '../../utils/workspace/canvas-agents'

defineOptions({ inheritAttrs: false })
// One sidebar row: a counted item whose status dot lists its agents, or an
// unavailable item whose dashed indicator explains why.
const props = defineProps<{
  name: string
  icon: string
  active?: boolean
  indicator?: CanvasIndicator
  unavailable?: string
  fresh?: boolean
  agents(): CanvasAgent[]
  actionsAvailable?: boolean
  open?: boolean
}>()
const emit = defineEmits<{
  select: []
  'update:open': [open: boolean]
  go: [target: Pick<CanvasAgent, 'sourceId' | 'windowId'>]
}>()
const { t, n } = useI18n()
const detail = computed(() =>
  props.indicator?.status ? statusLabel(props.indicator.status) : props.unavailable,
)
const label = computed(() =>
  detail.value
    ? t('canvasUi.canvasStatus', { name: props.name, status: detail.value })
    : props.name,
)
const triggerButton = ref<{ $el: HTMLElement }>(),
  trigger = computed(() => triggerButton.value?.$el),
  panel = ref<HTMLElement>(),
  pinned = ref(false)
const open = computed({ get: () => !!props.open, set: (value) => emit('update:open', value) })
const panelId = useId()
const currentAgents = computed(() => props.agents()),
  openedKeys = shallowRef<string[]>([])
// Live labels/status remain reactive, but a row cannot move under an active
// pointer or keyboard focus. Reopening adopts the latest requested sort order.
watch(
  () => (open.value ? currentAgents.value : undefined),
  (current) => {
    if (!current) {
      openedKeys.value = []
      pinned.value = false
      return
    }
    const present = new Set(current.map((agent) => agent.key)),
      known = new Set(openedKeys.value)
    openedKeys.value = [
      ...openedKeys.value.filter((key) => present.has(key)),
      ...current.filter((agent) => !known.has(agent.key)).map((agent) => agent.key),
    ]
  },
  { immediate: true },
)
const listed = computed(() => {
  if (!open.value) return currentAgents.value
  const current = new Map(currentAgents.value.map((agent) => [agent.key, agent]))
  return openedKeys.value.flatMap((key) => current.get(key) || [])
})
const dismiss = usePointerDismiss(open, trigger)
const { start: leave, stop: stopLeave } = useTimeoutFn(
  () => {
    if (
      !pinned.value &&
      !panel.value?.contains(document.activeElement) &&
      document.activeElement !== trigger.value
    )
      open.value = false
  },
  120,
  { immediate: false },
)
function enter(event?: PointerEvent) {
  if (event?.pointerType === 'touch') return
  stopLeave()
  open.value = true
}
function close() {
  stopLeave()
  open.value = false
}
function focusFirst() {
  const target =
    panel.value?.querySelector<HTMLButtonElement>('button:not(:disabled)') || panel.value
  target?.focus({ preventScroll: true })
}
function toggle(event: MouseEvent) {
  stopLeave()
  pinned.value = !pinned.value
  open.value = pinned.value
  // A hover-open panel is already mounted. Newly opened panels use native autofocus.
  if (pinned.value && event.detail === 0) focusFirst()
}
function go(agent: CanvasAgent) {
  if (!agent.available || props.actionsAvailable === false) return
  close()
  emit('go', { sourceId: agent.sourceId, windowId: agent.windowId })
}
watch(
  () => props.indicator?.status,
  (value) => {
    if (!value) close()
  },
)
const content = computed(() => ({
  'aria-label': t('canvasUi.agentsInCanvas', { name: props.name }),
  side: 'right' as const,
  align: 'start' as const,
  sideOffset: 8,
  collisionPadding: 8,
  prioritizePosition: true,
  onPointerenter: enter,
  onPointerleave: () => leave(),
  onOpenAutoFocus: (event: Event) => {
    event.preventDefault()
    if (pinned.value) focusFirst()
  },
  ...dismiss,
  onInteractOutside: (event: Event) => {
    dismiss.onInteractOutside()
    if (event.target instanceof Node && trigger.value?.contains(event.target))
      event.preventDefault()
  },
  onEscapeKeyDown: (event: Event) => {
    event.preventDefault()
    close()
    trigger.value?.focus({ preventScroll: true })
  },
}))
</script>

<template>
  <div class="canvas-nav-row relative">
    <UButton
      color="neutral"
      variant="ghost"
      class="nav-item"
      :class="{ active }"
      :aria-current="active ? 'page' : undefined"
      :aria-label="label"
      :title="label"
      v-bind="$attrs"
      @click="emit('select')"
    >
      <UIcon :name="icon" class="size-[16px] shrink-0" />
      <span class="canvas-nav-name"
        ><span>{{ name }}</span
        ><small v-if="indicator" class="canvas-nav-count">{{ n(indicator.count) }}</small></span
      >
      <span
        v-if="unavailable !== undefined"
        class="canvas-nav-status canvas-nav-unavailable col-start-3 text-dimmed"
        :title="unavailable"
        ><UIcon name="i-lucide-circle-dashed" class="size-2.5"
      /></span>
    </UButton>
    <UButton
      v-if="indicator?.status"
      ref="triggerButton"
      color="neutral"
      variant="ghost"
      class="canvas-nav-status canvas-agent-trigger absolute inset-y-0 right-0 w-(--sidebar-rail) justify-center p-0"
      :active="open"
      aria-haspopup="dialog"
      data-no-reorder
      :aria-label="t('canvasUi.agentsInCanvas', { name })"
      :aria-expanded="open"
      :aria-controls="panelId"
      @pointerenter="enter"
      @pointerleave="leave()"
      @click.stop="toggle"
      @keydown.esc.stop.prevent="close"
    >
      <i
        class="program-dot"
        :data-status-pulse="fresh && needsAttention(indicator.status)"
        :style="{ '--program-color': statusColor(indicator.status) }"
      />
    </UButton>
    <UPopover
      v-model:open="open"
      :modal="false"
      :reference="trigger"
      :content="content"
      :ui="{
        content:
          'canvas-agent-popover w-[320px] max-w-[calc(var(--ui-viewport-width)-16px)] max-h-[min(420px,var(--reka-popover-content-available-height))] overflow-y-auto',
      }"
    >
      <template #content>
        <div :id="panelId" ref="panel" class="canvas-agents-panel p-1 outline-none" tabindex="-1">
          <div class="flex items-baseline justify-between px-2 py-1.5 text-sm">
            <span>{{ t('canvasUi.agents') }}</span
            ><span class="text-xs text-muted tabular-nums">{{ n(listed.length) }}</span>
          </div>
          <UButton
            v-for="agent in listed"
            :key="agent.key"
            color="neutral"
            variant="ghost"
            block
            class="canvas-agent-row justify-start gap-2 p-2 text-left font-normal"
            :data-agent-id="agent.key"
            :data-window-id="agent.windowId"
            :disabled="!agent.available || actionsAvailable === false"
            :title="[agent.context, windowLabel(agent.window, agent.pane.id)].join('\n')"
            @click="go(agent)"
          >
            <i
              class="program-dot"
              :data-status-pulse="fresh && agent.available && needsAttention(agent.status)"
              :style="{ '--program-color': statusColor(agent.status) }"
            />
            <span class="flex min-w-0 flex-1 flex-col gap-0.5 text-xs"
              ><span class="truncate text-sm font-medium">{{
                agent.pane.agent || paneName(agent.pane)
              }}</span
              ><WindowTitle :window="agent.window" :pane-id="agent.pane.id" /><span
                class="truncate text-muted"
                >{{ agent.context }}</span
              ></span
            >
            <span class="flex-none text-xs" :style="{ color: statusColor(agent.status) }">{{
              agent.available ? statusLabel(agent.status) : t('canvasUi.agentUnavailable')
            }}</span>
          </UButton>
        </div>
      </template>
    </UPopover>
  </div>
</template>
