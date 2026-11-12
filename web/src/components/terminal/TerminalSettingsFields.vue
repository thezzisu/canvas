<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import USelect from '@nuxt/ui/components/Select.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInputNumber from '@nuxt/ui/components/InputNumber.vue'
import type {
  TerminalOverrides,
  TerminalSettings,
} from '../../composables/terminal/terminal-settings'
import { contentZoomLimits } from '../../composables/canvas/content-zoom'

// Rows use the same horizontal UFormField layout as Settings.
const props = defineProps<{
  modelValue: TerminalOverrides
  defaults?: TerminalSettings
  showZoom?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: TerminalOverrides] }>()
const { t } = useI18n()
const rows = computed(() =>
  [
    {
      key: 'rightClick' as const,
      label: t('terminal.settings.rightClick'),
      items: [
        { value: 'menu', label: t('terminal.settings.paneMenu') },
        { value: 'terminal', label: t('terminal.settings.sendToTerminal') },
      ],
    },
    {
      key: 'shiftPaste' as const,
      label: t('terminal.settings.shiftPaste'),
      items: [
        { value: 'paste', label: t('terminal.settings.paste') },
        { value: 'terminal', label: t('terminal.settings.sendToTerminal') },
      ],
    },
    {
      key: 'mouseHover' as const,
      label: t('terminal.settings.mouseHover'),
      items: [
        { value: 'true', label: t('terminal.settings.followProgram') },
        { value: 'false', label: t('terminal.settings.hoverOff') },
      ],
    },
  ].map((row) => ({
    ...row,
    // An inherited row has no value of its own: its placeholder names the default in effect.
    inherited: props.defaults
      ? row.items.find((item) => item.value === String(props.defaults![row.key]))!.label
      : undefined,
    items: props.defaults
      ? [{ value: '__default', label: t('terminal.settings.inherit') }, ...row.items]
      : row.items,
  })),
)
function update(key: 'rightClick' | 'shiftPaste' | 'mouseHover', value: string) {
  const next = { ...props.modelValue }
  if (value === '__default') delete next[key]
  else Object.assign(next, { [key]: key === 'mouseHover' ? value === 'true' : value })
  emit('update:modelValue', next)
}
const field = {
  root: 'items-center gap-4 @max-[360px]:flex-col @max-[360px]:items-stretch @max-[360px]:gap-2',
  container: 'w-60 shrink-0 @max-[360px]:w-full',
}
</script>

<template>
  <div class="@container grid gap-4">
    <UFormField
      v-for="row in rows"
      :key="row.key"
      :label="row.label"
      orientation="horizontal"
      :ui="field"
    >
      <USelect
        :model-value="modelValue[row.key] === undefined ? undefined : String(modelValue[row.key])"
        :items="row.items"
        :placeholder="row.inherited"
        :aria-label="row.label"
        :title="
          row.items.find((item) => item.value === String(modelValue[row.key]))?.label ??
          row.inherited
        "
        color="neutral"
        class="w-full"
        @update:model-value="(value) => update(row.key, value)"
      />
    </UFormField>
    <UFormField
      v-if="showZoom"
      :label="t('terminal.settings.defaultZoom')"
      orientation="horizontal"
      :ui="field"
    >
      <UInputNumber
        :model-value="modelValue.maximizedZoom"
        :aria-label="t('terminal.settings.defaultZoom')"
        :min="contentZoomLimits.min"
        :max="contentZoomLimits.max"
        :step="contentZoomLimits.step"
        :step-snapping="false"
        :format-options="{ style: 'unit', unit: 'percent' }"
        class="w-full"
        color="neutral"
        @update:model-value="
          (value) => emit('update:modelValue', { ...modelValue, maximizedZoom: value })
        "
      />
    </UFormField>
  </div>
</template>
