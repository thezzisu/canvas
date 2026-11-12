<script setup lang="ts">
import { watch } from 'vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import { apiRevision } from '../api/api'
import { installNotices } from '../composables/notify'
import { useSessionStore } from '../stores/session'
import { useWorkspaceStore } from '../stores/workspace'

// Lives below UApp so toasts are added with the toaster's own capacity.
const session = useSessionStore(),
  workspace = useWorkspaceStore()
const { toasts, add } = useToast()
installNotices(add)
// A notification raised for an account or session that is gone never appears.
watch(
  [toasts, apiRevision, () => session.authenticated, () => workspace.state?.instanceId],
  ([items, revision, signedIn, backend]) => {
    const prefix = `notification:${revision}:${backend}:`
    const current = items.filter((item) => {
      const id = String(item.id)
      return !id.startsWith('notification:') || (signedIn && id.startsWith(prefix))
    })
    if (current.length !== items.length) toasts.value = current
  },
  { flush: 'sync' },
)
</script>

<template><span hidden /></template>
