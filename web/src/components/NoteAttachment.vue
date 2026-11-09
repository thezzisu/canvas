<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/vue-3'
import UButton from '@nuxt/ui/components/Button.vue'
import type { FileAsset } from '../types'

const props = defineProps<NodeViewProps>()
const asset = computed<FileAsset | undefined>(() => props.extension.options.assets().find((item: FileAsset) => item.id === props.node.attrs.id))
</script>

<template>
  <NodeViewWrapper as="span" class="note-attachment select-all" contenteditable="false">
    <UButton size="xs" color="neutral" variant="soft" :icon="asset?.mime.startsWith('image/') ? 'i-lucide-image' : 'i-lucide-file'" :label="asset?.filename || '[file]'" :title="asset?.filename" :disabled="!asset" class="note-attachment-button" :ui="{ base: 'select-all', label: 'truncate' }" @mousedown.prevent @click="extension.options.preview(asset)" />
  </NodeViewWrapper>
</template>

<style scoped>
.note-attachment{display:inline-block;max-width:100%;vertical-align:baseline;margin:0 2px}
.note-attachment-button{max-width:100%;font-size:.9em;line-height:1.4;vertical-align:baseline}
</style>
