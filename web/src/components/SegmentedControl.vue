<script setup lang="ts" generic="T extends string">
import { computed } from 'vue'
import UTabs from '@nuxt/ui/components/Tabs.vue'

// A choice among a few fixed options, all in view. A set that can grow is a USelect instead.
const props = defineProps<{
  items: { value: T; label: string; icon?: string; disabled?: boolean }[]
  label: string
  /** The option in effect while "default" is chosen: faintly marked. */
  inherited?: T
}>()
const model = defineModel<T>({ required: true })
const tabs = computed(() =>
  props.items.map((item) => ({
    ...item,
    ui: item.value === props.inherited ? { trigger: 'segmented-inherited' } : undefined,
  })),
)
</script>

<template>
  <!-- The tab list itself takes no attributes: the group names it. -->
  <div class="segmented-control" role="group" :aria-label="label">
    <UTabs
      v-model="model"
      :items="tabs"
      :content="false"
      color="neutral"
      variant="pill"
      size="sm"
    />
  </div>
</template>

<style scoped>
.segmented-control :deep(.segmented-inherited[data-state='inactive']) {
  background: var(--ui-bg-accented);
}
</style>
