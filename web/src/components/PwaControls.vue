<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import {
  canInstall,
  canCheckUpdate,
  updateAvailable,
  updateCheck,
  pwaBusy,
  pwaFailure,
  checkPwaUpdates,
  installPwa,
  applyPwaUpdate,
} from '../pwa'

// One Settings row: the app's install/update state, with its actions on the right.
const props = defineProps<{ canReload?: boolean; field?: Record<string, string> }>()
const { t } = useI18n()
const status = computed(() =>
  pwaFailure.value
    ? t('settings.pwaFailed')
    : updateAvailable.value
      ? t('settings.updateReady')
      : updateCheck.value === 'failed'
        ? t('settings.checkUpdateFailed')
        : updateCheck.value === 'current'
          ? t('settings.noUpdate')
          : undefined,
)
const failed = computed(
  () => pwaFailure.value || (updateCheck.value === 'failed' && !updateAvailable.value),
)
</script>

<template>
  <UFormField
    v-if="canInstall || canCheckUpdate || updateAvailable"
    :label="t('settings.app')"
    orientation="horizontal"
    :ui="field"
    class="pwa-settings"
  >
    <template v-if="status" #description
      ><span :role="failed ? 'alert' : 'status'" :class="{ 'text-error': failed }">{{
        status
      }}</span></template
    >
    <div class="flex items-center gap-2">
      <UButton
        v-if="canInstall"
        color="neutral"
        variant="outline"
        size="sm"
        :loading="pwaBusy"
        @click="installPwa"
        >{{ t('settings.installApp') }}</UButton
      >
      <UButton
        v-if="updateAvailable"
        color="primary"
        variant="soft"
        size="sm"
        :loading="pwaBusy"
        :disabled="props.canReload === false"
        @click="applyPwaUpdate"
        >{{ t('settings.updateApp') }}</UButton
      >
      <UButton
        v-else-if="canCheckUpdate"
        color="neutral"
        variant="outline"
        size="sm"
        :loading="updateCheck === 'checking'"
        :disabled="pwaBusy || updateCheck === 'checking'"
        @click="checkPwaUpdates"
        >{{
          t(updateCheck === 'checking' ? 'settings.checkingUpdate' : 'settings.checkUpdate')
        }}</UButton
      >
    </div>
  </UFormField>
</template>
