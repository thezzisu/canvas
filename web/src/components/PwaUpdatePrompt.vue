<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast, type Toast } from '@nuxt/ui/composables/useToast'
import { updateAvailable, updateDismissed, pwaBusy, pwaFailure, applyPwaUpdate } from '../pwa'
const { t, locale } = useI18n(), toast = useToast()
let current: Toast | undefined
watch([updateAvailable, updateDismissed, pwaBusy, pwaFailure, locale], () => {
  if (!updateAvailable.value || updateDismissed.value) {
    if (current) { toast.remove(current.id); current = undefined }
    return
  }
  const notice = { title: t(pwaFailure.value ? 'settings.pwaFailed' : 'settings.updateReady'),
    color: 'neutral', duration: Infinity, progress: false, type: 'background', class: 'pwa-update-prompt',
    actions: [{ label: t('settings.updateApp'), color: 'neutral', variant: 'outline',
      loading: pwaBusy.value, closeOnClick: false, onClick: applyPwaUpdate }],
    close: { 'aria-label': t('common.close') },
  } satisfies Partial<Toast>
  if (current) { toast.update(current.id, notice); return }
  const entry = toast.add({ ...notice,
    'onUpdate:open': open => { if (!open && current?.id === entry.id) updateDismissed.value = true },
  })
  current = entry
}, { immediate: true })
onBeforeUnmount(() => { if (current) toast.remove(current.id) })
</script>
<template><span hidden /></template>
