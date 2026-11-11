<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import USelect from '@nuxt/ui/components/Select.vue'
import { languagePreference } from '../i18n'

const { t } = useI18n()
const items = computed(() => [
  { value: 'system', label: t('common.systemLanguage') },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
])
</script>

<template>
  <USelect
    v-model="languagePreference"
    :items="items"
    color="neutral"
    class="w-36"
    :aria-label="t('common.language')"
  />
</template>
