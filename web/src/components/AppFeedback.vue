<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { useToast, type Toast } from '@nuxt/ui/composables/useToast'
import { useI18n } from 'vue-i18n'
import { copyFeedback } from '../copy-feedback'

const props = defineProps<{ error: string; success: string }>()
const emit = defineEmits<{ dismiss: [] }>()
const { locale, t } = useI18n(), toast = useToast()
let current: Toast | undefined, copyCurrent: Toast | undefined
watch([() => props.error, () => props.success, locale], ([error, success]) => {
  if (current) { toast.remove(current.id); current = undefined }
  const message = error || success
  if (!message) return
  const entry = toast.add({ title: message, color: error ? 'error' : 'success',
    duration: props.error ? Infinity : 3500, type: 'background',
    'onUpdate:open': open => { if (!open && current?.id === entry.id) emit('dismiss') },
  })
  current = entry
}, { immediate: true })
watch(copyFeedback, feedback => {
  if (copyCurrent) { toast.remove(copyCurrent.id); copyCurrent = undefined }
  if (!feedback) return
  const title = feedback.kind === 'canvas' ? t('fileTransfer.copied') : t(`terminal.clipboard.${feedback.kind}`)
  copyCurrent = toast.add({ title, color: feedback.kind === 'failed' ? 'error' : 'success', duration: feedback.kind === 'failed' ? 5000 : 1500, type: 'background' })
})
onBeforeUnmount(() => { if (current) toast.remove(current.id); if (copyCurrent) toast.remove(copyCurrent.id) })
</script>

<template><span hidden /></template>
