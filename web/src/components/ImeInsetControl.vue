<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue'
import USlider from '@nuxt/ui/components/Slider.vue'
import { imeBottomInset as value } from '../developer-mode'
import Icon from './Icon.vue'

const props = defineProps<{ preserveFocus?: boolean }>()
function pointerDown(event: PointerEvent) { if (props.preserveFocus) event.preventDefault() }
</script>

<template>
  <section class="ime-inset-control" :class="{ 'ime-inset-compact': preserveFocus }" aria-label="IME bottom inset" @pointerdown="pointerDown">
    <div class="ime-inset-heading">
      <code>IME bottom inset</code>
      <div class="ime-inset-adjust">
        <UButton v-if="preserveFocus" type="button" color="neutral" variant="outline" size="xs" class="ime-inset-step" aria-label="Decrease IME bottom inset" :disabled="value <= 0" @click="value--"><Icon name="minus" :size="14" /></UButton>
        <output class="ime-inset-value">{{ value }}px</output>
        <UButton v-if="preserveFocus" type="button" color="neutral" variant="outline" size="xs" class="ime-inset-step" aria-label="Increase IME bottom inset" :disabled="value >= 48" @click="value++"><Icon name="plus" :size="14" /></UButton>
      </div>
    </div>
    <USlider v-if="!preserveFocus" v-model="value" :min="0" :max="48" :step="1" size="sm" class="ime-inset-slider" aria-label="IME bottom inset" :aria-valuetext="`${value}px`" />
  </section>
</template>

<style scoped>
.ime-inset-control{display:grid;gap:6px;min-width:0}
.ime-inset-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:20px}
.ime-inset-heading>code{color:#929fb0;font-size:11px;white-space:nowrap}
.ime-inset-adjust{display:flex;align-items:center;gap:3px;flex:none}
.ime-inset-value{min-width:34px;color:#b9c5d5;font-size:11px;font-variant-numeric:tabular-nums;text-align:right}
.ime-inset-compact .ime-inset-value{text-align:center}
.ime-inset-step{display:flex;align-items:center;justify-content:center;min-width:32px;min-height:36px;padding:0;border:1px solid #414b59;border-radius:5px;color:#aeb9c9;background:#1c222a}
.ime-inset-step:hover:not(:disabled){background:#ffffff08;color:#e1e7ef}
.ime-inset-slider{min-height:36px}
@media(pointer:coarse){.ime-inset-step{min-width:36px;min-height:44px}.ime-inset-slider{min-height:44px}}
</style>
