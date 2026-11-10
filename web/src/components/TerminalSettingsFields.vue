<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UTabs from '@nuxt/ui/components/Tabs.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInputNumber from '@nuxt/ui/components/InputNumber.vue'
import type { TerminalOverrides, TerminalSettings } from '../terminal-settings'
import { contentZoomLimits } from '../content-zoom'

// Rows use the same horizontal UFormField layout as Settings.
const props = defineProps<{ modelValue: TerminalOverrides; defaults?: TerminalSettings; showZoom?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: TerminalOverrides] }>()
const { t } = useI18n()
const rows = computed(() => [
  { key: 'rightClick' as const, label: t('terminal.settings.rightClick'), items: [
    { value: 'menu', label: t('terminal.settings.paneMenu') }, { value: 'terminal', label: t('terminal.settings.sendToTerminal') }] },
  { key: 'shiftPaste' as const, label: t('terminal.settings.shiftPaste'), items: [
    { value: 'paste', label: t('terminal.settings.paste') }, { value: 'terminal', label: t('terminal.settings.sendToTerminal') }] },
  { key: 'mouseHover' as const, label: t('terminal.settings.mouseHover'), items: [
    { value: 'true', label: t('terminal.settings.followProgram') }, { value: 'false', label: t('terminal.settings.hoverOff') }] },
].map(row => ({ ...row,
  inherited: props.defaults && props.modelValue[row.key] === undefined ? t('terminal.settings.defaultValue', {
    value: row.items.find(item => item.value === String(props.defaults![row.key]))!.label,
  }) : undefined,
  items: props.defaults ? [{ value: '__default', label: t('terminal.settings.inherit') }, ...row.items] : row.items,
})))
function update(key: 'rightClick' | 'shiftPaste' | 'mouseHover', value: string | number) {
  const next = { ...props.modelValue }
  if (value === '__default') delete next[key]
  else Object.assign(next, { [key]: key === 'mouseHover' ? value === 'true' : value })
  emit('update:modelValue', next)
}
const field = { root: 'items-center gap-4', container: 'w-60 shrink-0', help: 'mt-1 text-xs' }
</script>

<template>
  <div class="grid gap-4">
    <UFormField v-for="row in rows" :key="row.key" :label="row.label" :help="row.inherited" orientation="horizontal" :ui="field" role="group" :aria-label="row.label">
      <UTabs :model-value="modelValue[row.key] === undefined ? '__default' : String(modelValue[row.key])" :items="row.items" :content="false" color="neutral" variant="pill" size="sm"
        :ui="{ list: 'w-full', trigger: 'flex-1 min-w-0 justify-center', label: 'whitespace-normal text-center' }" :aria-label="row.label" @update:model-value="value => update(row.key, value)" />
    </UFormField>
    <UFormField v-if="showZoom" :label="t('terminal.settings.defaultZoom')" orientation="horizontal" :ui="field">
      <UInputNumber :model-value="modelValue.maximizedZoom" :aria-label="t('terminal.settings.defaultZoom')" :min="contentZoomLimits.min" :max="contentZoomLimits.max" :step="contentZoomLimits.step" :step-snapping="false" :format-options="{ style: 'unit', unit: 'percent' }" class="w-full" color="neutral" size="sm" @update:model-value="value => emit('update:modelValue', { ...modelValue, maximizedZoom: value })" />
    </UFormField>
  </div>
</template>
