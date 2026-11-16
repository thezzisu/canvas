<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UFormField from '@nuxt/ui/components/FormField.vue'
import SegmentedControl from '../SegmentedControl.vue'
import ZoomStepper from '../ZoomStepper.vue'
import {
  defaultTerminalSettings,
  type TerminalOverrides,
  type TerminalSettings,
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
    // "Default" has no value of its own: the option it stands for is marked faintly.
    value:
      props.modelValue[row.key] === undefined ? '__default' : String(props.modelValue[row.key]),
    inherited: props.defaults ? String(props.defaults[row.key]) : undefined,
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
      <SegmentedControl
        :model-value="row.value"
        :items="row.items"
        :label="row.label"
        :inherited="row.value === '__default' ? row.inherited : undefined"
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
      <ZoomStepper
        :model-value="modelValue.maximizedZoom ?? defaultTerminalSettings.maximizedZoom"
        :range="contentZoomLimits"
        :label="t('terminal.settings.defaultZoom')"
        @update:model-value="
          (value) => emit('update:modelValue', { ...modelValue, maximizedZoom: value })
        "
        @reset="
          emit('update:modelValue', {
            ...modelValue,
            maximizedZoom: defaultTerminalSettings.maximizedZoom,
          })
        "
      />
    </UFormField>
  </div>
</template>
