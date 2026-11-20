<script setup lang="ts">
import { computed } from 'vue'
import { isolatedHtml } from '../../utils/files/html-preview'
const props = defineProps<{ text: string; filename: string }>()
const document = computed(() => isolatedHtml(props.text))
</script>
<template>
  <iframe
    class="html-preview"
    sandbox=""
    :srcdoc="document"
    :title="filename"
    referrerpolicy="no-referrer"
  />
</template>
<style scoped>
.html-preview {
  display: block;
  flex: 1;
  min-height: 0;
  width: 100%;
  border: 0;
  background: var(--paper);
  color: var(--ui-text-inverted);
}
</style>
