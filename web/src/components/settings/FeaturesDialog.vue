<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UFormField from '@nuxt/ui/components/FormField.vue'
import USwitch from '@nuxt/ui/components/Switch.vue'
import UModal from '../CanvasModal.vue'
import { allFeatures, useViewStore, type Feature } from '../../stores/view'

// Which optional features this browser's sidebar offers.
defineEmits<{ close: [] }>()
const { t } = useI18n()
const view = useViewStore()
const labels: Record<Feature, string> = { 'working-set': 'app.workingSet' }
function toggle(feature: Feature, enabled: boolean) {
  view.features = allFeatures.filter((item) =>
    item === feature ? enabled : view.features.includes(item),
  )
}
</script>

<template>
  <UModal
    :open="true"
    :title="t('settings.features')"
    :ui="{ content: '[--dialog-width:24rem]' }"
    @update:open="(value) => value || $emit('close')"
  >
    <template #body>
      <UFormField
        v-for="feature in allFeatures"
        :key="feature"
        :label="t(labels[feature])"
        orientation="horizontal"
      >
        <USwitch
          :model-value="view.features.includes(feature)"
          :aria-label="t(labels[feature])"
          @update:model-value="(enabled) => toggle(feature, enabled)"
        />
      </UFormField>
    </template>
  </UModal>
</template>
