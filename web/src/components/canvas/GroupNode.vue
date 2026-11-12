<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UIcon from '@nuxt/ui/components/Icon.vue'
import type { NodeProps } from '@vue-flow/core'

const { t, n } = useI18n()
defineProps<
  NodeProps<{
    name: string
    subtitle?: string
    kind: 'source' | 'space'
    count?: number
    width?: number
    height?: number
  }>
>()
</script>
<template>
  <div
    v-if="data.kind === 'source'"
    class="source-group"
    :style="{ width: `${data.width}px`, height: `${data.height}px` }"
  >
    <header>
      <span class="source-symbol"><UIcon name="i-lucide-server" class="size-[17px]" /></span
      ><strong>{{ data.name }}</strong
      ><span class="source-count">{{
        t('panels.windows', { count: n(data.count ?? 0) }, data.count ?? 0)
      }}</span
      ><span class="source-type">{{ data.subtitle }}</span>
    </header>
  </div>
  <div v-else class="space-label">
    <UIcon name="i-lucide-layers" class="size-[15px]" /><strong>{{ data.name }}</strong
    ><i /><span>{{ t('panels.windows', { count: n(data.count ?? 0) }, data.count ?? 0) }}</span>
  </div>
</template>
