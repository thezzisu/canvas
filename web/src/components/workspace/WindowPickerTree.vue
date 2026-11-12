<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMobileLayout } from '../../composables/mobile-layout'
import UBadge from '@nuxt/ui/components/Badge.vue'
import UCheckbox from '@nuxt/ui/components/Checkbox.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UTree, { type TreeItem } from '@nuxt/ui/components/Tree.vue'
import type { Source, SourceResource } from '../../api/types'
import {
  pickerChecked,
  pickerGroups,
  updatePickerSelection,
  type PickerWindow,
} from '../../utils/workspace/window-picker'
import { statusColor } from '../../utils/status'
import { needsAttention } from '../../utils/workspace/canvas-status'
import WindowTitle from './WindowTitle.vue'
import { windowLabel } from '../../utils/workspace/window-title'

type PickerItem = TreeItem & {
  key: string
  eligible: string[]
  count?: number
  window?: PickerWindow
  live?: boolean
  children?: PickerItem[]
}
const props = defineProps<{
  resources: SourceResource[]
  sources: Source[]
  query: string
  selected: string[]
  existing: Set<string>
  fresh?: boolean
}>()
const emit = defineEmits<{ 'update:selected': [value: string[]] }>()
const { t, n } = useI18n()
const touch = useMobileLayout()
const online = computed(
  () =>
    new Set(
      props.resources
        .filter((source) => source.status === 'online' && !source.error)
        .map((source) => source.id),
    ),
)
const items = computed<PickerItem[]>(() =>
  pickerGroups(props.sources, props.resources, props.query, props.existing).map((source) => ({
    key: source.id,
    label: source.name,
    icon: 'i-lucide-server',
    eligible: source.eligible,
    count: source.spaces.reduce((count, space) => count + space.windows.length, 0),
    children: source.spaces.map((space) => ({
      key: `${source.id}/${space.id}`,
      label: space.name,
      icon: 'i-lucide-layers',
      eligible: space.eligible,
      count: space.windows.length,
      children: space.windows.map((window) => ({
        key: window.key,
        label: windowLabel(window),
        slot: 'window' as const,
        disabled: window.added,
        eligible: window.added ? [] : [window.key],
        window,
        live: !!props.fresh && online.value.has(source.id),
      })),
    })),
  })),
)
const selected = computed(() => new Set(props.selected))
const groups = computed(() =>
  items.value.flatMap((source) => [source.key, ...source.children!.map((space) => space.key)]),
)
const collapsed = ref(new Set<string>())
// A search shows every match; otherwise groups stay as the user left them.
const expanded = computed({
  get: () =>
    props.query.trim() ? groups.value : groups.value.filter((key) => !collapsed.value.has(key)),
  set: (keys) => {
    if (!props.query.trim())
      collapsed.value = new Set(groups.value.filter((key) => !keys.includes(key)))
  },
})
// Slot items arrive as the stock TreeItem type.
const picked = (item: unknown) => item as PickerItem
function toggle(item: PickerItem, checked = pickerChecked(item.eligible, selected.value) !== true) {
  if (item.eligible.length)
    emit('update:selected', updatePickerSelection(props.selected, item.eligible, checked))
}
// The checkboxes own selection: a row click opens a group or checks a window, the keyboard checks either.
function select(event: CustomEvent<{ originalEvent: Event }>, item: TreeItem) {
  event.preventDefault()
  if (picked(item).window || event.detail.originalEvent.type !== 'click') toggle(picked(item))
}
</script>

<template>
  <UTree
    v-model:expanded="expanded"
    :items="items"
    :as="{ link: 'div' }"
    :get-key="(item) => picked(item).key"
    color="neutral"
    :size="touch ? 'lg' : 'sm'"
    class="window-picker-tree max-h-[min(420px,calc(var(--mobile-height,var(--ui-viewport-height))/2))] overflow-auto overscroll-contain rounded-md p-1 ring ring-default"
    :ui="{
      link: touch ? 'min-h-[44px]' : undefined,
      linkLabel: 'flex min-w-0 items-center gap-1.5',
    }"
    @select="select"
  >
    <template #item-leading="{ item, ui }"
      ><span class="flex" @click.stop @keydown.stop
        ><UCheckbox
          :model-value="pickerChecked(picked(item).eligible, selected)"
          :disabled="!picked(item).eligible.length"
          :aria-label="t('windowPicker.selectGroup', { name: item.label })"
          tabindex="-1"
          @update:model-value="toggle(picked(item), $event === true)" /></span
      ><UIcon :name="item.icon!" :class="ui.linkLeadingIcon()" class="text-dimmed"
    /></template>
    <template #item-label="{ item }"
      ><span class="truncate" :title="item.label">{{ item.label }}</span
      ><span class="flex-none text-dimmed tabular-nums">{{
        n(picked(item).count || 0)
      }}</span></template
    >
    <template #window-leading="{ item }"
      ><UCheckbox
        :model-value="pickerChecked(picked(item).eligible, selected) === true"
        :disabled="picked(item).disabled"
        :aria-label="picked(item).label"
        tabindex="-1"
        class="pointer-events-none" /><span
        class="program-dot"
        :data-status-pulse="picked(item).live && needsAttention(picked(item).window!.status)"
        :style="{ '--program-color': statusColor(picked(item).window!.status) }"
    /></template>
    <template #window-label="{ item }"
      ><WindowTitle class="truncate" :window="picked(item).window!"
    /></template>
    <template #window-trailing="{ item }"
      ><UBadge v-if="picked(item).disabled" color="neutral" variant="subtle" size="sm">{{
        t('windowPicker.added')
      }}</UBadge></template
    >
  </UTree>
</template>
