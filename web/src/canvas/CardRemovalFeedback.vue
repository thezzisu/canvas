<script setup lang="ts">
import type { ApiContext } from '../api/api'
import { useCardRemovalUndo } from './card-removal-undo'

const props = defineProps<{
  sync(): Promise<void>
  released(context: ApiContext): void
  error(reason: unknown): void
}>()
// Live below UApp so native toasts inherit its reactive capacity and focus portal.
defineExpose(useCardRemovalUndo(props))
</script>

<template><span hidden /></template>
