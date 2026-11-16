<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import { zoomIn, zoomOut, type ZoomRange } from '../utils/zoom/zoom-steps'

// The one control that sets a scale: − [value] +, the value resetting to its default.
const props = defineProps<{
  range: ZoomRange
  label: string
  /** What the value button restores, and the name it gives that action. */
  resetLabel?: string
  mobile?: boolean
  disabled?: boolean
}>()
const zoom = defineModel<number>({ required: true })
const emit = defineEmits<{ reset: [] }>()
const { t, n } = useI18n()
const percentage = computed(() => n(zoom.value / 100, { style: 'percent' }))
const button = computed(() => ({
  color: 'neutral' as const,
  variant: 'ghost' as const,
  size: props.mobile ? ('xl' as const) : ('md' as const),
  class: props.mobile ? 'min-w-[44px] min-h-[44px] justify-center' : '',
}))
</script>

<template>
  <div class="zoom-stepper flex items-center gap-0.5" role="group" :aria-label="label">
    <UButton
      v-bind="button"
      square
      icon="i-lucide-minus"
      :disabled="disabled || zoomOut(zoom, range) === zoom"
      :aria-label="t('common.zoomOut')"
      :title="t('common.zoomOut')"
      @pointerdown.prevent
      @click="zoom = zoomOut(zoom, range)"
    />
    <UButton
      v-bind="button"
      class="zoom-stepper-reset min-w-14 justify-center tabular-nums"
      :label="percentage"
      :disabled="disabled"
      :aria-label="resetLabel || t('common.resetZoom')"
      :title="resetLabel || t('common.resetZoom')"
      @pointerdown.prevent
      @click="emit('reset')"
    />
    <UButton
      v-bind="button"
      square
      icon="i-lucide-plus"
      :disabled="disabled || zoomIn(zoom, range) === zoom"
      :aria-label="t('common.zoomIn')"
      :title="t('common.zoomIn')"
      @pointerdown.prevent
      @click="zoom = zoomIn(zoom, range)"
    />
  </div>
</template>
