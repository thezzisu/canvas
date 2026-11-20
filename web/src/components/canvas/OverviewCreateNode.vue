<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue'
import { useI18n } from 'vue-i18n'
import type { NodeProps } from '@vue-flow/core'

const { t } = useI18n()

defineProps<
  NodeProps<{
    sourceId: string
    spaceId?: string
    context: string
    available: boolean
    pending(): boolean
    create(): void
  }>
>()
</script>

<template>
  <UButton
    color="neutral"
    variant="ghost"
    class="overview-create nodrag nopan size-full"
    :class="
      data.spaceId
        ? 'overview-create-tab flex-col justify-center gap-2.5 border border-dashed border-scene text-muted enabled:hover:border-scene-strong enabled:hover:bg-scene-tint enabled:hover:text-highlighted enabled:active:border-scene-strong enabled:active:bg-scene-tint enabled:active:text-highlighted'
        : 'overview-create-space group text-muted hover:bg-transparent active:bg-transparent enabled:hover:text-highlighted enabled:active:text-highlighted'
    "
    :size="data.spaceId ? 'md' : 'xs'"
    :icon="data.spaceId ? 'i-lucide-square-plus' : 'i-lucide-layers'"
    :label="t(data.spaceId ? 'panels.overview.newTab' : 'panels.overview.newSpace')"
    :ui="{ label: 'flex-none', leadingIcon: data.spaceId ? 'size-6' : undefined }"
    :data-source-id="data.sourceId"
    :data-space-id="data.spaceId"
    :aria-label="
      t('panels.overview.createIn', {
        action: t(data.spaceId ? 'panels.overview.newTab' : 'panels.overview.newSpace'),
        context: data.context,
      })
    "
    :loading="data.pending()"
    :disabled="!data.available || data.pending()"
    :title="data.available ? undefined : t('panels.overview.unavailable')"
    @pointerdown.stop
    @click.stop="data.create()"
    @dblclick.stop
  >
    <template v-if="!data.spaceId" #trailing
      ><span
        class="ms-1 flex-1 border-t border-dashed border-scene transition-colors group-enabled:group-hover:border-scene-strong group-enabled:group-active:border-scene-strong"
    /></template>
  </UButton>
</template>

<style scoped>
:global(.vue-flow__node-create) {
  padding: 0;
  border: 0;
  background: transparent;
  pointer-events: auto !important;
}
</style>
