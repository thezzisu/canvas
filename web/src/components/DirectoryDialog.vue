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
