<script setup lang="ts">
import NoteFileChip from './NoteFileChip.vue'

defineProps<{ files: readonly string[] }>()
</script>

<template>
  <span class="note-upload-placeholder"><NoteFileChip v-for="(name, index) in files" :key="index" :name="name" :title="name" muted /></span>
</template>

<style scoped>
.note-file-chip{margin:0 2px}
</style>
