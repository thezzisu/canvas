<script setup lang="ts" generic="T extends string">
import { computed, onBeforeUnmount, ref, useId } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import UTabs from '@nuxt/ui/components/Tabs.vue'
import USelect from '@nuxt/ui/components/Select.vue'
import { useSegmentedFit } from '../composables/settings/segmented-fit'

// A choice among a few fixed options, all in view. A set that can grow is a USelect instead.
// When its dialog is too narrow for every segmented row, it shows as a drop-down (segmented-fit).
const props = defineProps<{
  items: { value: T; label: string; icon?: string; disabled?: boolean }[]
  label: string
  /** The option in effect while "default" is chosen: faintly marked, or the drop-down's placeholder. */
  inherited?: T
}>()
const model = defineModel<T>({ required: true })
const tabs = computed(() =>
  props.items.map((item) => ({
    ...item,
    ui: item.value === props.inherited ? { trigger: 'segmented-inherited' } : undefined,
  })),
)
// The drop-down form takes the same options as plain strings.
const options = computed(() =>
  props.items.map(({ value, label, disabled }) => ({ value: value as string, label, disabled })),
)
const placeholder = computed(
  () => props.items.find((item) => item.value === props.inherited)?.label,
)

const id = useId(),
  fit = useSegmentedFit(),
  root = ref<HTMLElement>(),
  measure = ref<HTMLElement>()
const row = computed(() => root.value?.closest<HTMLElement>('.settings-field') ?? undefined)
// The hidden copy always has the segmented width, whichever form is shown. Layout pixels
// throughout: the label's scroll width is its full length even while it ends in an ellipsis.
function check() {
  const field = row.value,
    natural = measure.value?.offsetWidth
  if (!field || !natural) return fit.report(id, true)
  const label = field.querySelector('[data-slot="label"]')?.scrollWidth ?? 0,
    gap = parseFloat(getComputedStyle(field).columnGap) || 0
  fit.report(id, natural <= field.clientWidth - label - gap + 0.5)
}
useResizeObserver(() => [row.value, measure.value].filter((element) => !!element), check)
onBeforeUnmount(() => fit.report(id, true))
</script>

<template>
  <div ref="root" class="segmented-control relative">
    <!-- The tab list itself takes no attributes: the group names it. -->
    <div role="group" :aria-label="label">
      <USelect
        v-if="fit.compact.value"
        :model-value="inherited === undefined ? (model as string) : undefined"
        :items="options"
        :placeholder="placeholder"
        :aria-label="label"
        color="neutral"
        class="min-w-36 max-w-full"
        @update:model-value="(value) => (model = value as T)"
      />
      <UTabs
        v-else
        v-model="model"
        :items="tabs"
        :content="false"
        color="neutral"
        variant="pill"
        size="sm"
      />
    </div>
    <div class="segmented-measure" aria-hidden="true" inert>
      <div ref="measure" class="w-max">
        <UTabs :model-value="model" :items="tabs" :content="false" variant="pill" size="sm" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.segmented-control :deep(.segmented-inherited[data-state='inactive']) {
  background: var(--ui-bg-accented);
}
.segmented-measure {
  position: absolute;
  inset: 0;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}
</style>
