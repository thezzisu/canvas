<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import TerminalSettingsFields from './TerminalSettingsFields.vue'
import { useTerminalDefaults, type TerminalOverrides } from '../terminal-settings'

// One dialog edits either one window's overrides (inheriting defaults) or the browser defaults.
const props = defineProps<{ open: boolean; defaultsMode?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const settings = defineModel<TerminalOverrides>({ default: () => ({}) })
const defaults = useTerminalDefaults()
const { t } = useI18n()
function update(value: TerminalOverrides) {
  if (props.defaultsMode) defaults.value = { ...defaults.value, ...value }
  else settings.value = value
}
</script>

<template>
  <UModal :open="open" :title="t(defaultsMode ? 'terminal.settings.defaults' : 'terminal.settings.title')" :description="defaultsMode ? t('settings.thisBrowser') : undefined"
    :close="{ 'aria-label': t('common.close') }" :ui="{ content: 'terminal-settings-dialog' }" @update:open="value => { if (!value) emit('close') }">
    <template #body>
      <TerminalSettingsFields v-if="defaultsMode" :model-value="defaults" show-zoom @update:model-value="update" />
      <TerminalSettingsFields v-else :model-value="settings" :defaults="defaults" @update:model-value="update" />
    </template>
  </UModal>
</template>

<style>
.terminal-settings-dialog{width:min(440px,calc(var(--ui-viewport-width) - 28px));max-height:calc(var(--dialog-height) - 32px)}
</style>
