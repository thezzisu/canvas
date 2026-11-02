<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import { directoryRequest, dismissDirectory } from '../directories'

const { t } = useI18n()

defineProps<{ portal?: HTMLElement }>()
function openChanged(open: boolean) { if (!open) dismissDirectory() }
</script>

<template>
  <UModal v-if="directoryRequest" :key="directoryRequest.id" :open="true" :title="t('panels.directory.title')" :portal="portal || false" :close="{ 'aria-label': t('common.close') }" :ui="{ content: 'directory-modal max-w-md z-[75]', overlay: 'z-[74]', description: 'whitespace-pre-wrap break-all', footer: 'justify-end' }" @update:open="openChanged">
    <template #description><span :data-directory-id="directoryRequest.id">{{ directoryRequest.path }}</span></template>
    <template #footer><UButton :href="directoryRequest.uri" external target="_self" class="no-underline" @click="dismissDirectory">{{ t('panels.directory.openVSCode') }}</UButton></template>
  </UModal>
</template>

<style>
.directory-modal{--directory-safe-top:var(--mobile-safe-top,var(--ui-safe-top));--directory-safe-bottom:var(--mobile-safe-bottom,var(--ui-safe-bottom));position:fixed;left:calc(var(--mobile-left,0px) + (var(--mobile-width,var(--ui-viewport-width)) + var(--ui-safe-left) - var(--ui-safe-right))/2);top:calc(var(--mobile-top,0px) + (var(--mobile-height,var(--ui-viewport-height)) + var(--directory-safe-top) - var(--directory-safe-bottom))/2);translate:-50% -50%;width:min(448px,calc(var(--mobile-width,var(--ui-viewport-width)) - 24px - var(--ui-safe-left) - var(--ui-safe-right)));max-height:calc(var(--mobile-height,var(--ui-viewport-height)) - 24px - var(--directory-safe-top) - var(--directory-safe-bottom));overflow:auto;overscroll-behavior:contain}
</style>
