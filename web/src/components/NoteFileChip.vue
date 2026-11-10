<script setup lang="ts">
import UBadge from '@nuxt/ui/components/Badge.vue'
import FileIcon from './FileIcon.vue'

// No listeners, focus or touch-applicable :hover/:active styles: Chromium touch
// adjustment would retarget taps beside a chip onto it. The editor handles clicks.
defineProps<{ name: string; muted?: boolean }>()
</script>

<template>
  <UBadge color="neutral" variant="soft" :label="name" class="note-file-chip" :class="muted ? 'text-muted' : 'cursor-pointer transition-colors hover:bg-accented/75'">
    <template #leading><FileIcon :name="name" :size="16" :class="{ 'opacity-50': muted }" /></template>
  </UBadge>
</template>

<style scoped>
.note-file-chip{max-width:100%;font-size:.9em;line-height:1.4;vertical-align:baseline}
</style>
