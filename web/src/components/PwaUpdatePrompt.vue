<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UAlert from '@nuxt/ui/components/Alert.vue'
import { updateAvailable, updateDismissed, pwaBusy, pwaFailure, applyPwaUpdate } from '../pwa'
defineProps<{ portal?: HTMLElement }>()
const { t } = useI18n()
const actions = computed(() => [{ label: t('settings.updateApp'), color: 'neutral' as const, variant: 'outline' as const,
  loading: pwaBusy.value, onClick: applyPwaUpdate }])
</script>
<template>
  <Teleport :to="portal || 'body'">
    <UAlert v-if="updateAvailable && !updateDismissed" class="pwa-update-prompt" color="neutral" variant="subtle"
      :title="t(pwaFailure ? 'settings.pwaFailed' : 'settings.updateReady')" :actions="actions" :close="{ 'aria-label': t('common.close') }"
      :ui="{ title: 'text-xs', actions: 'gap-2' }" @update:open="updateDismissed = true" />
  </Teleport>
</template>
<style scoped>
.pwa-update-prompt{position:fixed;z-index:99;right:max(12px,var(--ui-safe-right));bottom:calc(12px + var(--ui-safe-bottom));width:min(320px,calc(var(--mobile-width,var(--ui-viewport-width)) - 24px));box-shadow:0 8px 30px #0005}
</style>
