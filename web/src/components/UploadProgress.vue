<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UProgress from '@nuxt/ui/components/Progress.vue'

const props = defineProps<{
  name: string
  status: string
  transferred?: number
  total?: number
  active?: boolean
  queued?: number
  cancelling?: boolean
  failed?: boolean
}>()
const emit = defineEmits<{ cancel: [] }>()
const { t } = useI18n()
const percentage = computed(() =>
  props.total ? Math.min(100, Math.floor(((props.transferred || 0) / props.total) * 100)) : null,
)
</script>

<template>
  <div
    class="file-transfer-progress nodrag nopan"
    :class="{ 'upload-failed': failed }"
    @pointerdown.stop
    @mousedown.stop
  >
    <div class="file-transfer-row">
      <span class="file-transfer-name" :title="name">{{ name }}<slot /></span>
      <small v-if="queued">+{{ queued }}</small>
      <span
        class="file-transfer-status"
        :class="{ 'file-transfer-message': !name }"
        :role="failed ? 'alert' : 'status'"
        >{{ status }}</span
      >
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-x"
        :aria-label="active ? t('terminal.upload.cancel') : t('terminal.upload.close')"
        :title="active ? t('terminal.upload.cancel') : t('terminal.upload.close')"
        :disabled="cancelling"
        @pointerdown.prevent
        @click.stop="emit('cancel')"
      />
    </div>
    <UProgress
      v-if="active"
      :model-value="percentage"
      size="2xs"
      :aria-label="t('terminal.upload.progress')"
    />
  </div>
</template>

<style scoped>
.file-transfer-progress {
  padding: 4px 7px;
  border: 1px solid var(--ui-border-accented);
  border-radius: var(--ui-radius);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-toned);
  box-shadow: var(--float-shadow);
  font-size: var(--text-2xs);
}
.file-transfer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 19px;
}
.file-transfer-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.file-transfer-name:empty {
  display: none;
}
.file-transfer-status {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-transfer-message {
  flex: 1;
  max-width: none;
}
.file-transfer-row > small {
  color: var(--ui-text-dimmed);
  font-size: var(--text-2xs);
}
.file-transfer-row > button {
  height: 22px;
  width: 22px;
  min-width: 22px;
  padding: 0;
  color: var(--ui-text-muted);
  border-radius: var(--ui-radius);
}
.upload-failed .file-transfer-status {
  color: var(--danger);
}
</style>
