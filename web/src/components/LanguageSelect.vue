<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import USelect from '@nuxt/ui/components/Select.vue'
import { languagePreference } from '../i18n'

defineProps<{ portal?: HTMLElement }>()
const { t } = useI18n()
const items = computed(() => [
  { value: 'system', label: t('common.systemLanguage') },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
])
</script>

<template>
  <USelect v-model="languagePreference" :items="items" :portal="portal || false" color="neutral" size="sm"
    class="settings-select language-select" :aria-label="t('common.language')"
    :ui="{ content: 'settings-select-menu', item: 'settings-select-item' }" />
</template>
