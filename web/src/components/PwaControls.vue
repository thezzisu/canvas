<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import { canInstall, canCheckUpdate, updateAvailable, updateCheck, pwaBusy, pwaFailure, checkPwaUpdates, installPwa, applyPwaUpdate } from '../pwa'
const props = defineProps<{ canReload?: boolean }>()
const { t } = useI18n()
</script>
<template>
  <div v-if="canInstall || canCheckUpdate || updateAvailable" class="pwa-settings">
    <UButton v-if="canInstall" color="neutral" variant="outline" size="sm" :loading="pwaBusy" @click="installPwa">{{ t('settings.installApp') }}</UButton>
    <UButton v-if="canCheckUpdate" color="neutral" variant="outline" size="sm" :loading="updateCheck === 'checking'" :disabled="pwaBusy || updateCheck === 'checking'" @click="checkPwaUpdates">{{ t(updateCheck === 'checking' ? 'settings.checkingUpdate' : 'settings.checkUpdate') }}</UButton>
    <UButton v-if="updateAvailable" color="neutral" variant="outline" size="sm" :loading="pwaBusy" :disabled="props.canReload === false" @click="applyPwaUpdate">{{ t('settings.updateApp') }}</UButton>
    <small v-if="updateCheck === 'failed' && !updateAvailable" role="alert">{{ t('settings.checkUpdateFailed') }}</small>
    <small v-else-if="updateCheck === 'current' && !updateAvailable" role="status">{{ t('settings.noUpdate') }}</small>
    <small v-if="pwaFailure" role="alert">{{ t('settings.pwaFailed') }}</small>
  </div>
</template>
<style scoped>
.pwa-settings{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.pwa-settings>small{font-size:11px;color:#d5a8b0}
.pwa-settings>small[role=status]{color:var(--ui-text-muted)}
</style>
