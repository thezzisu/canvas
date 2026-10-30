<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import { canInstall, updateAvailable, pwaBusy, pwaFailure, installPwa, applyPwaUpdate } from '../pwa'
const props = defineProps<{ canReload?: boolean }>()
const { t } = useI18n()
</script>
<template>
  <div v-if="canInstall || updateAvailable" class="pwa-settings">
    <UButton v-if="canInstall" color="neutral" variant="outline" size="sm" :loading="pwaBusy" @click="installPwa">{{ t('settings.installApp') }}</UButton>
    <UButton v-if="updateAvailable" color="neutral" variant="outline" size="sm" :loading="pwaBusy" :disabled="props.canReload === false" @click="applyPwaUpdate">{{ t('settings.updateApp') }}</UButton>
    <small v-if="pwaFailure" role="alert">{{ t('settings.pwaFailed') }}</small>
  </div>
</template>
<style scoped>
.pwa-settings{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding-top:16px;margin-top:16px;border-top:1px solid #343b46}.pwa-settings>small{font-size:11px;color:#d5a8b0}
</style>
