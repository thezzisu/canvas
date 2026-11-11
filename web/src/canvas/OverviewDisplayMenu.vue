<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UChip from '@nuxt/ui/components/Chip.vue'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import type { ProgramStatus } from '../../../shared/status'
import { usePointerDismiss } from '../lib/pointer-dismiss'
import { statusColor, statusLabel } from '../lib/status'
import { useViewStore } from '../stores/view'
import { overviewFocusStatuses, overviewPerRowChoices, overviewStatuses } from './overview'
import { useCanvasScene } from './scene/scene'

// Which windows Overview lists (filters) and how it lays them out (arrangement).
// Only filters hide windows, so only they mark the trigger.
defineProps<{ size: 'sm' | 'xl' }>()
const { t } = useI18n()
const view = useViewStore()
const open = useCanvasScene().menus.display
const trigger = ref<{ $el: HTMLElement }>()
const dismiss = usePointerDismiss(open, () => trigger.value?.$el, {
  // Reka owns the portalled submenu; only canvas gestures can stop its outside listener.
  outside: (event) =>
    event.target instanceof Element && !!event.target.closest('.graph-wrap, .focus-overlay'),
})
/** A choice that stays in the menu when picked, so several can be changed in one visit. */
const choice = (label: string, checked: boolean, choose: (checked: boolean) => void) => ({
  type: 'checkbox' as const,
  label,
  checked,
  onSelect: (event: Event) => event.preventDefault(),
  onUpdateChecked: choose,
})
const toggleStatus = (status: ProgramStatus, checked: boolean) => {
  view.statuses = checked
    ? [...view.statuses, status]
    : view.statuses.filter((value) => value !== status)
}
const items = computed<DropdownMenuItem[][]>(() => [
  [
    { type: 'label', label: t('app.status') },
    choice(t('app.allStatuses'), !view.statusFiltered, (checked) => {
      view.statuses = checked ? [...overviewStatuses] : []
    }),
    choice(t('app.focus'), view.focusPreset, (checked) => {
      view.statuses = checked ? [...overviewFocusStatuses] : []
    }),
    ...overviewStatuses.map((status) => ({
      ...choice(
        status === 'unknown' ? t('app.other') : statusLabel(status),
        view.statuses.includes(status),
        (checked) => toggleStatus(status, checked),
      ),
      status,
    })),
  ],
  [
    choice(t('app.unplacedOnly'), view.scope === 'unplaced', (checked) => {
      view.scope = checked ? 'unplaced' : 'all'
    }),
  ],
  [
    { type: 'label', label: t('app.sort') },
    ...(['native', 'status'] as const).map((order) =>
      choice(
        t(order === 'native' ? 'app.nativeOrder' : 'app.statusOrder'),
        view.order === order,
        () => {
          view.order = order
        },
      ),
    ),
  ],
  [
    {
      label: t('app.windowsPerRow'),
      children: [
        overviewPerRowChoices.map((count) =>
          choice(count ? String(count) : t('app.noWrapping'), view.perRow === count, () => {
            view.perRow = count
          }),
        ),
      ],
    },
  ],
  [
    {
      label: t('app.reset'),
      disabled: !view.filtered && !view.arranged,
      onSelect: view.reset,
    },
  ],
])
</script>

<template>
  <UDropdownMenu
    v-model:open="open"
    :modal="false"
    :items="items"
    :content="{ align: 'end', ...dismiss }"
    :ui="{ content: 'overview-display-menu w-48' }"
  >
    <UButton
      ref="trigger"
      class="overview-display-trigger relative"
      :class="{ active: view.filtered }"
      icon="i-lucide-list-filter"
      color="neutral"
      :variant="view.filtered ? 'soft' : 'ghost'"
      :size="size"
      :title="t('app.filterSort')"
      :aria-label="t('app.overviewFilterSort')"
    >
      <template v-if="view.filtered" #trailing>
        <UChip standalone inset size="sm" class="absolute right-1 top-1" />
      </template>
    </UButton>
    <template #item-leading="{ item }">
      <span class="flex h-[1em] w-3 flex-none items-center justify-center" aria-hidden="true">
        <i
          v-if="'status' in item"
          class="program-dot"
          :style="{ '--program-color': statusColor(item.status as ProgramStatus) }"
        />
      </span>
    </template>
  </UDropdownMenu>
</template>
