<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/vue-3'
import NoteFileChip from './NoteFileChip.vue'
import type { FileAsset } from '../api/types'

const props = defineProps<NodeViewProps>()
const asset = computed<FileAsset | undefined>(() =>
  props.extension.options.assets().find((item: FileAsset) => item.id === props.node.attrs.id),
)
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="note-attachment select-all"
    contenteditable="false"
    :data-note-attachment="node.attrs.id"
  >
    <NoteFileChip
      :name="asset?.filename || '[file]'"
      :muted="!asset"
      :title="asset?.filename"
      role="button"
      :aria-disabled="!asset || undefined"
      class="note-attachment-button select-all"
    />
  </NodeViewWrapper>
</template>

<style scoped>
.note-attachment {
  display: inline-block;
  max-width: 100%;
  vertical-align: baseline;
  margin: 0 2px;
}
</style>
