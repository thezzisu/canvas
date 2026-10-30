<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { onBeforeUnmount, ref } from 'vue'
import { copyText } from '../clipboard'
import { collectViewportDiagnostics } from '../viewport-diagnostics'

const { t } = useI18n()
const feedback = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
function copy() {
  const snapshot = collectViewportDiagnostics()
  const failed = () => { feedback.value = 'failed' }
  if (copyText(JSON.stringify(snapshot, null, 2), failed)) feedback.value = 'copied'
  clearTimeout(timer)
  timer = setTimeout(() => { feedback.value = '' }, 2000)
}
onBeforeUnmount(() => { clearTimeout(timer) })
</script>

<template>
  <button class="viewport-diagnostics" type="button" :aria-label="t('terminal.copyDiagnostics')" @pointerdown.stop.prevent @click.stop="copy">{{ feedback ? t(`terminal.clipboard.${feedback}`) : t('terminal.copyDiagnostics') }}</button>
</template>

<style scoped>
.viewport-diagnostics{position:fixed;top:max(8px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:120;min-height:32px;padding:4px 10px;border:1px solid #46505b;border-radius:5px;background:#23272ef2;color:#c6ced8;font-size:11px}
</style>
