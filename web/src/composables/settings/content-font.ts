import { ref } from 'vue'
import type { GlobalSettings } from '../../../../shared/settings'
import { setContentFont } from '../terminal/terminals'
import { notify } from '../notify'
import { buildFontPresentation, ensureContentFont } from '../../utils/settings/fonts'

/** CSS variables for note, file and terminal text; empty until the first font has loaded. */
export const contentFontStyle = ref<Record<string, string>>({})
export const appliedContentFont = ref('')
/** Cards render only once their font is usable, so text never reflows under the reader. */
export const contentFontReady = ref(false)
let signature = ''
let revision = 0

export function resetContentFont() {
  revision++
  signature = ''
  contentFontReady.value = false
}

/** Load and present the shared content font; an unchanged setting is not loaded again. */
export function applyContentFont(settings: GlobalSettings['contentFont']) {
  const next = JSON.stringify(settings)
  if (next === signature) return
  signature = next
  const current = ++revision
  const config = { ...settings, stack: settings.stack.map((entry) => ({ ...entry })) }
  const apply = () => {
    if (current !== revision) return
    const presentation = buildFontPresentation(config)
    contentFontStyle.value = {
      '--content-font-family': presentation.family,
      '--content-font-features': presentation.features,
    }
    appliedContentFont.value = config.stack[0]?.family || ''
    setContentFont(config, presentation)
    contentFontReady.value = true
  }
  void ensureContentFont(config, apply).then(apply, (reason) => {
    if (current !== revision) return
    // An initial failure still opens the workspace with the available fallback.
    // Later font changes keep the already usable presentation until a retry.
    if (!contentFontReady.value) apply()
    signature = ''
    notify.error(reason)
  })
}
