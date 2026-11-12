<script setup lang="ts">
import { computed } from 'vue'
import { useVModels } from '@vueuse/core'
import UButton from '@nuxt/ui/components/Button.vue'
import { useTextPreviewActions } from '../../composables/files/text-preview-actions'

const props = defineProps<{
  filename: string
  rendered: boolean
  wrap: boolean
  formatted: boolean
  highlighted: boolean
  sourcePreview?: boolean
  previewBusy?: boolean
  hideSite?: boolean
  only?: string
}>()
const emit = defineEmits<{
  'update:rendered': [value: boolean]
  'update:wrap': [value: boolean]
  'update:formatted': [value: boolean]
  'update:highlighted': [value: boolean]
  preview: []
}>()
const models = useVModels(props, emit)
const actions = useTextPreviewActions(() => props.filename, models, {
  sourcePreview: () => props.sourcePreview,
  busy: () => props.previewBusy || false,
  hideSite: () => props.hideSite || false,
  preview: () => emit('preview'),
})
const shown = computed(() =>
  actions.value.filter((item) => !props.only || item.slot === props.only),
)
</script>

<template>
  <div
    class="text-preview-actions nodrag nopan flex flex-none items-center gap-0.5"
    @pointerdown.stop
    @click.stop
    @dblclick.stop
  >
    <UButton
      v-for="item in shown"
      :key="item.slot"
      type="button"
      :icon="item.icon"
      :color="item.checked ? 'primary' : 'neutral'"
      :variant="item.checked ? 'soft' : 'ghost'"
      square
      class="text-preview-action"
      :aria-label="item.label"
      :title="item.title || item.label"
      :aria-pressed="item.type === 'checkbox' ? item.checked : undefined"
      :disabled="item.disabled"
      :loading="item.loading"
      @click="
        (event) =>
          item.type === 'checkbox' ? item.onUpdateChecked?.(!item.checked) : item.onSelect?.(event)
      "
    />
  </div>
</template>
