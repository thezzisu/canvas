<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import CanvasModal from './CanvasModal.vue'
import { trustedPreviewRequest, closeTrustedPreview } from '../trusted-preview'
defineProps<{ portal?: HTMLElement }>()
const { t } = useI18n()
</script>
<template>
  <CanvasModal :open="!!trustedPreviewRequest" :portal="portal || false" :title="t('panels.preview.trustTitle')" :description="t('panels.preview.trustDescription')" @update:open="value => { if (!value) closeTrustedPreview() }">
    <template #body><p class="truncate text-sm text-muted">{{ trustedPreviewRequest?.title }}</p></template>
    <template #footer><div class="flex w-full justify-end gap-2"><UButton color="neutral" variant="outline" :label="t('common.cancel')" @click="closeTrustedPreview()" /><UButton :label="t('panels.preview.trustConfirm')" @click="closeTrustedPreview(true)" /></div></template>
  </CanvasModal>
</template>
