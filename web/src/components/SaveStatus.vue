<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ButtonProps } from '@nuxt/ui'
import UButton from '@nuxt/ui/components/Button.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import { pendingWrites } from '../pending-writes'

const props = defineProps<{ owner: string; size?: ButtonProps['size'] }>()
const { t } = useI18n()
const status = computed(() => pendingWrites.status(props.owner))
</script>

<template>
  <UButton v-if="status === 'failed'" class="save-status nodrag" color="error" variant="ghost" square :size="size" :title="t('app.saveFailed')" :aria-label="t('app.saveFailed')"
    @pointerdown.stop.prevent @dblclick.stop @click.stop="pendingWrites.retry(owner)"><UIcon name="i-lucide-triangle-alert" class="size-4" /></UButton>
  <Transition v-else leave-active-class="motion-safe:transition-opacity motion-safe:duration-500" leave-to-class="opacity-0">
    <span v-if="status" class="save-status inline-flex shrink-0 text-muted" role="img" :title="t(`app.${status}`)" :aria-label="t(`app.${status}`)">
      <UIcon :name="status === 'saving' ? 'i-lucide-loader-circle' : 'i-lucide-check'" class="size-4" :class="{ 'motion-safe:animate-spin': status === 'saving' }" />
    </span>
  </Transition>
</template>
