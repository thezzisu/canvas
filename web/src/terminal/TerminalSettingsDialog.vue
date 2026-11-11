<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UModal from '../components/CanvasModal.vue'
import TerminalSettingsFields from './TerminalSettingsFields.vue'
import { useTerminalDefaults, type TerminalOverrides } from './terminal-settings'

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
  <UModal
    v-if="open"
    :open="true"
    :title="t(defaultsMode ? 'terminal.settings.defaults' : 'terminal.settings.title')"
    :description="defaultsMode ? t('settings.thisBrowser') : undefined"
    :ui="{ content: 'terminal-settings-dialog [--dialog-width:28rem]' }"
    @update:open="
      (value) => {
        if (!value) emit('close')
      }
    "
  >
    <template #body>
      <TerminalSettingsFields
        v-if="defaultsMode"
        :model-value="defaults"
        show-zoom
        @update:model-value="update"
      />
      <TerminalSettingsFields
        v-else
        :model-value="settings"
        :defaults="defaults"
        @update:model-value="update"
      />
    </template>
    <template #footer>
      <UButton @click="emit('close')">{{ t('common.done') }}</UButton>
    </template>
  </UModal>
</template>
