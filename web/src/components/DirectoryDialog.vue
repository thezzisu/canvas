<script setup lang="ts">
import UModal from '@nuxt/ui/components/Modal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import { directoryRequest, dismissDirectory } from '../directories'

defineProps<{ portal?: HTMLElement }>()
function openChanged(open: boolean) { if (!open) dismissDirectory() }
</script>

<template>
  <UModal v-if="directoryRequest" :key="directoryRequest.id" :open="true" title="在本地继续" :portal="portal || false" :close="{ 'aria-label': '关闭对话框' }" :ui="{ content: 'directory-modal max-w-md z-[75]', overlay: 'z-[74]', description: 'whitespace-pre-wrap break-all', footer: 'justify-end' }" @update:open="openChanged">
    <template #description><span :data-directory-id="directoryRequest.id">{{ directoryRequest.path }}</span></template>
    <template #footer><UButton :href="directoryRequest.uri" external target="_self" class="no-underline" @click="dismissDirectory">在VSCode打开</UButton></template>
  </UModal>
</template>

<style>
.directory-modal{--directory-safe-top:var(--mobile-safe-top,env(safe-area-inset-top,0px));--directory-safe-bottom:var(--mobile-safe-bottom,env(safe-area-inset-bottom,0px));position:fixed;left:calc(var(--mobile-left,0px) + (var(--mobile-width,100vw) + env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px))/2);top:calc(var(--mobile-top,0px) + (var(--mobile-height,100dvh) + var(--directory-safe-top) - var(--directory-safe-bottom))/2);translate:-50% -50%;width:min(448px,calc(var(--mobile-width,100vw) - 24px - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px)));max-height:calc(var(--mobile-height,100dvh) - 24px - var(--directory-safe-top) - var(--directory-safe-bottom));overflow:auto;overscroll-behavior:contain}
</style>
