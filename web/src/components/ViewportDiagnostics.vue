<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { copyText } from '../clipboard'
import { collectViewportDiagnostics } from '../viewport-diagnostics'

const feedback = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
function copy() {
  const snapshot = collectViewportDiagnostics()
  const failed = () => { feedback.value = '复制失败' }
  if (copyText(JSON.stringify(snapshot, null, 2), failed)) feedback.value = '已复制'
  clearTimeout(timer)
  timer = setTimeout(() => { feedback.value = '' }, 2000)
}
onBeforeUnmount(() => { clearTimeout(timer) })
</script>

<template>
  <button class="viewport-diagnostics" type="button" aria-label="复制视口诊断" @pointerdown.stop.prevent @click.stop="copy">{{ feedback || '复制视口诊断' }}</button>
</template>

<style scoped>
.viewport-diagnostics{position:fixed;top:max(8px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:120;min-height:32px;padding:4px 10px;border:1px solid #46505b;border-radius:5px;background:#23272ef2;color:#c6ced8;font-size:11px}
</style>
