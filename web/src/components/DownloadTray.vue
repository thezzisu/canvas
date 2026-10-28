<script setup lang="ts">
import { h, onBeforeUnmount, watch } from 'vue'
import { useToast } from '@nuxt/ui/composables'
import DownloadToastContent from './DownloadToastContent.vue'
import { cancelDownload, dismissDownload, downloadFinished, downloads } from '../downloads'

const toast = useToast()
const displayed = new Set<string>()
const toastId = (id: string) => `download:${id}`

watch(downloads, items => {
  const activeIds = new Set(items.map(item => item.id))
  for (const id of displayed) {
    if (activeIds.has(id)) continue
    toast.remove(toastId(id))
    displayed.delete(id)
  }
  for (const download of items) {
    if (!displayed.has(download.id)) {
      toast.add({
        id: toastId(download.id), title: download.filename, icon: 'i-lucide-download',
        description: () => h(DownloadToastContent, { id: download.id }),
        duration: 0, progress: false, close: false,
        ui: { title: 'truncate text-xs', description: 'mt-1', wrapper: 'min-w-0' },
        'onUpdate:open': open => {
          if (open) return
          const current = downloads.value.find(item => item.id === download.id)
          if (current && !downloadFinished(current)) cancelDownload(download.id)
          else dismissDownload(download.id)
        },
      })
    }
    displayed.add(download.id)
  }
}, { immediate: true })

onBeforeUnmount(() => { for (const id of displayed) toast.remove(toastId(id)); displayed.clear() })
</script>

<template><span hidden /></template>
