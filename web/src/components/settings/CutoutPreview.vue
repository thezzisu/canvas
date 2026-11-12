<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { cutoutPosition, cutoutWidth } from '../../composables/display-cutout'
import UButton from '@nuxt/ui/components/Button.vue'
import CardHeaderActions from '../canvas/CardHeaderActions.vue'

const { t } = useI18n()
const props = defineProps<{ overview: boolean; captured?: boolean }>()
const shortcuts = computed(() => (props.captured ? [] : ['keyboard', 'zoom']))
</script>

<template>
  <div class="cutout-preview-frame" aria-hidden="true" inert>
    <div
      class="cutout-preview cutout-header"
      :data-cutout-position="cutoutWidth > 0 ? cutoutPosition : undefined"
      :style="{ '--cutout-width': `calc(${cutoutWidth}px / var(--ui-zoom))` }"
    >
      <span class="cutout-status cutout-preview-control"><i /></span>
      <span class="cutout-title">{{ t('terminal.previewTitle') }}</span>
      <CardHeaderActions
        class="cutout-actions"
        :items="[]"
        expanded
        mobile
        :removable="!overview"
        :shortcuts="shortcuts"
        :add-label="t('terminal.action.addToCanvas')"
      >
        <template #keyboard
          ><UButton aria-hidden="true" tabindex="-1" icon="i-lucide-keyboard"
        /></template>
        <template #zoom
          ><UButton aria-hidden="true" tabindex="-1" icon="i-lucide-zoom-in"
        /></template>
      </CardHeaderActions>
    </div>
  </div>
</template>

<style scoped>
.cutout-preview-frame {
  position: absolute;
  top: 0;
  left: var(--ui-safe-left);
  right: var(--ui-safe-right);
  container-type: inline-size;
  pointer-events: none;
  user-select: none;
}
.cutout-preview {
  position: relative;
  height: 44px;
  background: #252a32;
  border-bottom: 1px solid #414752;
  color: #d3d8e1;
  font-size: 13px;
  font-weight: 500;
}
.cutout-preview-control {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  min-width: 44px;
  color: #8592a3;
}
.cutout-status > i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--green) 8%, transparent);
}
.cutout-preview[data-cutout-position]::before {
  content: '';
  position: absolute;
  inset-block: 0;
  width: var(--cutout-space);
  background: repeating-linear-gradient(
    135deg,
    color-mix(in srgb, var(--ui-primary) 14%, transparent) 0 4px,
    color-mix(in srgb, var(--ui-primary) 3%, transparent) 4px 8px
  );
  border-inline: 1px solid color-mix(in srgb, var(--ui-primary) 40%, transparent);
}
.cutout-preview[data-cutout-position='left']::before {
  left: 0;
}
.cutout-preview[data-cutout-position='center']::before {
  left: 50%;
  translate: -50% 0;
}
.cutout-preview[data-cutout-position='right']::before {
  right: 0;
}
</style>
