<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import Icon from './Icon.vue'
import { isMarkdownFile } from '../markdown'

const props = defineProps<{ filename: string; rendered: boolean; wrap: boolean }>()
const emit = defineEmits<{ 'update:rendered': [value: boolean]; 'update:wrap': [value: boolean] }>()
const { t } = useI18n()
const markdown = computed(() => isMarkdownFile(props.filename))
</script>

<template>
  <div class="text-preview-actions nodrag nopan" @pointerdown.stop @click.stop @dblclick.stop>
    <UButton v-if="markdown" type="button" color="neutral" :variant="rendered ? 'ghost' : 'soft'" size="xs" class="text-preview-action"
      :aria-label="t('panels.preview.source')" :title="t(rendered ? 'panels.preview.source' : 'panels.preview.rendered')" :aria-pressed="!rendered"
      @click="emit('update:rendered', !rendered)"><Icon name="code" :size="15" /></UButton>
    <UButton v-if="!markdown || !rendered" type="button" color="neutral" :variant="wrap ? 'soft' : 'ghost'" size="xs" class="text-preview-action"
      :aria-label="t('panels.preview.wrap')" :title="t('panels.preview.wrap')" :aria-pressed="wrap"
      @click="emit('update:wrap', !wrap)"><Icon name="wrap" :size="15" /></UButton>
  </div>
</template>

<style scoped>
.text-preview-actions{display:flex;flex:none;align-items:center;gap:2px}
.text-preview-action{display:flex;flex:none;align-items:center;justify-content:center;width:28px;min-width:28px;height:30px;padding:0;border-radius:5px;color:#93a1b4}
.text-preview-action:hover,.text-preview-action[aria-pressed=true]{color:#d4dfec}
</style>
