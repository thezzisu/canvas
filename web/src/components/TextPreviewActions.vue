<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import Icon from './Icon.vue'
import { isMarkdownFile } from '../markdown'
import { textCapabilities } from '../code-preview'

const props = defineProps<{ filename: string; rendered: boolean; wrap: boolean; formatted: boolean; highlighted: boolean;
  sourcePreview?: boolean; previewBusy?: boolean; hideSite?: boolean }>()
const emit = defineEmits<{ 'update:rendered': [value: boolean]; 'update:wrap': [value: boolean];
  'update:formatted': [value: boolean]; 'update:highlighted': [value: boolean]; preview: [] }>()
const { t } = useI18n()
const markup = computed(() => isMarkdownFile(props.filename) || /\.html?$/iu.test(props.filename))
const capabilities = computed(() => textCapabilities(props.filename))
const source = computed(() => !markup.value || !props.rendered)
</script>

<template>
  <div class="text-preview-actions nodrag nopan" @pointerdown.stop @click.stop @dblclick.stop>
    <UButton v-if="markup" type="button" :color="!rendered ? 'primary' : 'neutral'" :variant="rendered ? 'ghost' : 'soft'" size="xs" class="text-preview-action"
      :aria-label="t('panels.preview.source')" :title="t(rendered ? 'panels.preview.source' : 'panels.preview.rendered')" :aria-pressed="!rendered"
      @click="emit('update:rendered', !rendered)"><Icon name="code" :size="15" /></UButton>
    <template v-if="source">
      <UButton v-if="capabilities.format" icon="i-lucide-list-tree" type="button" :color="formatted ? 'primary' : 'neutral'" :variant="formatted ? 'soft' : 'ghost'" size="xs" class="text-preview-action"
        :aria-label="t('panels.preview.format')" :title="t('panels.preview.format')" :aria-pressed="formatted" @click="emit('update:formatted', !formatted)" />
      <UButton v-if="capabilities.highlight" icon="i-lucide-palette" type="button" :color="highlighted ? 'primary' : 'neutral'" :variant="highlighted ? 'soft' : 'ghost'" size="xs" class="text-preview-action"
        :aria-label="t('panels.preview.highlight')" :title="t('panels.preview.highlight')" :aria-pressed="highlighted" @click="emit('update:highlighted', !highlighted)" />
      <UButton type="button" :color="wrap ? 'primary' : 'neutral'" :variant="wrap ? 'soft' : 'ghost'" size="xs" class="text-preview-action"
        :aria-label="t('panels.preview.wrap')" :title="t('panels.preview.wrap')" :aria-pressed="wrap" @click="emit('update:wrap', !wrap)"><Icon name="wrap" :size="15" /></UButton>
    </template>
    <UButton v-if="!hideSite && (capabilities.html || isMarkdownFile(filename))" icon="i-lucide-square-arrow-out-up-right" type="button" color="neutral" variant="ghost" size="xs" class="text-preview-action"
      :aria-label="t('panels.preview.site')" :title="t(sourcePreview ? 'panels.preview.site' : 'panels.preview.noSource')" :disabled="!sourcePreview" :loading="previewBusy" @click="emit('preview')" />
  </div>
</template>

<style scoped>
.text-preview-actions{display:flex;flex:none;align-items:center;gap:var(--text-preview-action-gap,0)}
.text-preview-action{display:flex;flex:none;align-items:center;justify-content:center;width:var(--header-action-size,24px);min-width:var(--header-action-size,24px);height:var(--header-action-size,24px);padding:0;border-radius:5px}
</style>
