<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { useToast, type Toast } from '@nuxt/ui/composables/useToast'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ error: string; success: string }>()
const emit = defineEmits<{ dismiss: [] }>()
const { t, locale } = useI18n(), toast = useToast()
let current: Toast | undefined
watch([() => props.error, () => props.success, locale], ([error, success]) => {
  if (current) { toast.remove(current.id); current = undefined }
  const message = error || success
  if (!message) return
  const entry = toast.add({ title: message, color: error ? 'error' : 'success',
    duration: props.error ? Infinity : 3500, progress: false, type: 'background',
    close: { 'aria-label': t('app.closeNotification') },
    'onUpdate:open': open => { if (!open && current?.id === entry.id) emit('dismiss') },
  })
  current = entry
}, { immediate: true })
onBeforeUnmount(() => { if (current) toast.remove(current.id) })
</script>

<template><span hidden /></template>
