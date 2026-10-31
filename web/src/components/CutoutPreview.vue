<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import { cutoutPosition, cutoutWidth, useCompactHeader } from '../display-cutout'
import Icon from './Icon.vue'

const { t } = useI18n()
const header = ref<HTMLElement>()
const compact = useCompactHeader(header)
</script>

<template>
  <div class="cutout-preview-frame" aria-hidden="true">
    <div ref="header" class="cutout-preview cutout-header" :data-cutout-position="cutoutWidth > 0 ? cutoutPosition : undefined" :style="{ '--cutout-width': `${cutoutWidth}px` }">
      <span class="cutout-status cutout-preview-control"><i /></span>
      <span class="cutout-title">{{ t('terminal.previewTitle') }}</span>
      <div class="cutout-actions">
        <span v-if="!compact" class="cutout-preview-control"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10" /></svg></span>
        <span class="cutout-preview-control"><Icon name="more" :size="17" /></span>
        <span class="cutout-preview-control"><Icon name="collapse" :size="15" /></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cutout-preview-frame{position:absolute;top:0;left:env(safe-area-inset-left,0px);right:env(safe-area-inset-right,0px);z-index:80;container-type:inline-size;pointer-events:none;user-select:none}
.cutout-preview{position:relative;height:44px;background:#252a32;border-bottom:1px solid #414752;color:#d3d8e1;font-size:13px;font-weight:500}
.cutout-preview-control{display:flex;align-items:center;justify-content:center;width:44px;height:44px;min-width:44px;color:#8592a3}
.cutout-status>i{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 8%,transparent)}
.cutout-preview[data-cutout-position]::before{content:'';position:absolute;inset-block:0;width:var(--cutout-space);background:repeating-linear-gradient(135deg,#e9b18824 0 4px,#e9b18808 4px 8px);border-inline:1px solid #e9b18866}
.cutout-preview[data-cutout-position=left]::before{left:0}
.cutout-preview[data-cutout-position=center]::before{left:50%;translate:-50% 0}
.cutout-preview[data-cutout-position=right]::before{right:0}
</style>
