<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import { urlRequest, dismissUrl } from '../urls'
const { t } = useI18n()
defineProps<{ portal?: HTMLElement }>()
</script>

<template>
  <UModal v-if="urlRequest" :key="urlRequest.id" :open="true" :title="t('urls.title')" :portal="portal || false"
    :close="{ 'aria-label': t('common.close') }"
    :ui="{ content: 'directory-modal max-w-md z-[75]', overlay: 'z-[74]', description: 'whitespace-pre-wrap break-all', footer: 'justify-end' }"
    @update:open="open => { if (!open) dismissUrl() }">
    <template #description>{{ urlRequest.url }}<span v-if="urlRequest.forwarded" class="block mt-2 text-xs text-muted">{{ t('urls.subpath') }}</span></template>
    <template #footer><UButton :href="urlRequest.url" external target="_blank" rel="noopener noreferrer" @click="dismissUrl">{{ t('urls.open') }}</UButton></template>
  </UModal>
</template>
