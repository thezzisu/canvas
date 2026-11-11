<script setup lang="ts" generic="T extends { id: string; name: string }">
import { computed, ref, watch } from 'vue'
import {
  useSortable,
  insertNodeAt,
  removeNode,
  type UseSortableOptions,
} from '@vueuse/integrations/useSortable'
import { useReducedMotion } from '../lib/reduced-motion'
import { orderedItems } from './sidebar-order'
import { useI18n } from 'vue-i18n'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ items: T[] }>()
const emit = defineEmits<{ reorder: [ids: string[]] }>()
const { t } = useI18n()
const root = ref<HTMLElement>(),
  announcement = ref('')
function changed(proposed: string[], moved: string) {
  const ids = orderedItems(props.items, proposed).map((item) => item.id)
  emit('reorder', ids)
  const item = props.items.find((item) => item.id === moved)
  if (item)
    announcement.value = t('app.itemReordered', {
      name: item.name,
      position: ids.indexOf(moved) + 1,
      count: ids.length,
    })
}
const reducedMotion = useReducedMotion()
const sortableOptions: UseSortableOptions & { supportPointer: boolean } = {
  animation: reducedMotion.value ? 0 : 150,
  direction: 'vertical',
  delay: 200,
  delayOnTouchOnly: true,
  // Native touchmove keeps scrolling available until the long press starts a drag.
  supportPointer: false,
  draggable: '.sidebar-sortable-item',
  ghostClass: 'sidebar-sortable-ghost',
  chosenClass: 'sidebar-sortable-chosen',
  fallbackClass: 'sidebar-sortable-drag',
  fallbackTolerance: 5,
  touchStartThreshold: 5,
  filter: '[data-no-reorder]',
  preventOnFilter: false,
  onUpdate(event) {
    const ids = [...event.from.children]
      .map((item) => (item as HTMLElement).dataset.orderId!)
      .filter(Boolean)
    // Restore Sortable's temporary DOM move; Vue applies the keyed order.
    const id = event.item.dataset.orderId!,
      index = props.items.findIndex((item) => item.id === id)
    removeNode(event.item)
    if (index < 0) return
    insertNodeAt(event.from, event.item, index)
    changed(ids, id)
  },
}
const sortable = useSortable(
  root,
  computed(() => props.items),
  sortableOptions,
)
watch(reducedMotion, (value) => sortable.option('animation', value ? 0 : 150))
function keydown(event: KeyboardEvent) {
  if ((event.target as HTMLElement).closest('[data-no-reorder]')) return
  if (
    !event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !['ArrowUp', 'ArrowDown'].includes(event.key)
  )
    return
  const element = (event.target as HTMLElement).closest<HTMLElement>('[data-order-id]')
  const ids = props.items.map((item) => item.id),
    from = ids.indexOf(element?.dataset.orderId || '')
  if (from < 0) return
  event.preventDefault()
  event.stopPropagation()
  const to = from + (event.key === 'ArrowUp' ? -1 : 1)
  if (to < 0 || to >= ids.length) return
  const [id] = ids.splice(from, 1)
  ids.splice(to, 0, id!)
  changed(ids, id!)
}
</script>

<template>
  <div ref="root" v-bind="$attrs" class="sidebar-sortable" @keydown="keydown">
    <div
      v-for="item in items"
      :key="item.id"
      :data-order-id="item.id"
      class="sidebar-sortable-item"
    >
      <slot :item="item" :hint="t('app.reorderHint')" />
    </div>
  </div>
  <span class="sr-only" role="status">{{ announcement }}</span>
</template>

<style scoped>
.sidebar-sortable-ghost :deep(button),
.sidebar-sortable-drag :deep(button) {
  cursor: grabbing;
}
.sidebar-sortable-ghost {
  opacity: 0.3;
}
.sidebar-sortable-chosen {
  background: color-mix(in srgb, var(--ui-primary) 4%, transparent);
  border-radius: 5px;
}
</style>
