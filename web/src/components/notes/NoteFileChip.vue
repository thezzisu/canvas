<script setup lang="ts">
import UBadge from '@nuxt/ui/components/Badge.vue'
import FileIcon from '../files/FileIcon.vue'

// No listeners, focus or touch-applicable :hover/:active styles: Chromium touch
// adjustment would retarget taps beside a chip onto it. The editor handles clicks.
defineProps<{ name: string; muted?: boolean }>()
</script>

<template>
  <UBadge
    color="neutral"
    variant="soft"
    :label="name"
    class="note-file-chip"
    :class="muted ? 'text-muted' : 'cursor-pointer transition-colors hover:bg-accented/75'"
  >
    <template #leading
      ><FileIcon :name="name" size="1.25em" :class="{ 'opacity-50': muted }"
    /></template>
  </UBadge>
</template>

<style scoped>
/* Sized from the surrounding text so a chip fits inside its line box at any zoom, and
   centred on the text instead of sitting on the baseline by its icon's bottom edge. */
.note-file-chip {
  max-width: 100%;
  height: 1.6em;
  padding-block: 0;
  font-size: 0.85em;
  line-height: 1;
  vertical-align: middle;
}
</style>
