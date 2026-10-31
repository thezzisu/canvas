import { computed, watch } from 'vue'
import { usePreferredLanguages, useStorage } from '@vueuse/core'
import { createI18n } from 'vue-i18n'
import { en as enUi, zh_cn as zhUi } from '@nuxt/ui/locale'
import zhCommon from './locales/zh-CN/common'
import enCommon from './locales/en/common'
import zhSettings from './locales/zh-CN/settings'
import enSettings from './locales/en/settings'
import zhApp from './locales/zh-CN/app'
import enApp from './locales/en/app'
import zhPanels from './locales/zh-CN/panels'
import enPanels from './locales/en/panels'
import zhTerminal from './locales/zh-CN/terminal'
import enTerminal from './locales/en/terminal'
import zhInstances from './locales/zh-CN/instances'
import enInstances from './locales/en/instances'
import zhCanvasUi from './locales/zh-CN/canvas-ui'
import enCanvasUi from './locales/en/canvas-ui'
import zhUrls from './locales/zh-CN/urls'
import enUrls from './locales/en/urls'
import zhWindowPicker from './locales/zh-CN/window-picker'
import enWindowPicker from './locales/en/window-picker'
import zhFileTransfer from './locales/zh-CN/file-transfer'
import enFileTransfer from './locales/en/file-transfer'
import zhAccount from './locales/zh-CN/account'
import enAccount from './locales/en/account'

export type AppLocale = 'zh-CN' | 'en'
export const languagePreference = useStorage<'system' | AppLocale>('canvas:language', 'system')
const preferredLanguages = usePreferredLanguages()
const preferredLocale = computed<AppLocale>(() => {
  if (languagePreference.value === 'zh-CN' || languagePreference.value === 'en') return languagePreference.value
  for (const language of preferredLanguages.value) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN'
    if (/^en(?:-|$)/i.test(language)) return 'en'
  }
  return 'en'
})
const zh = { common: zhCommon, settings: zhSettings, app: zhApp, panels: zhPanels, terminal: zhTerminal, instances: zhInstances, canvasUi: zhCanvasUi, urls: zhUrls, windowPicker: zhWindowPicker, fileTransfer: zhFileTransfer, account: zhAccount }
const en: typeof zh = { common: enCommon, settings: enSettings, app: enApp, panels: enPanels, terminal: enTerminal, instances: enInstances, canvasUi: enCanvasUi, urls: enUrls, windowPicker: enWindowPicker, fileTransfer: enFileTransfer, account: enAccount }
export const i18n = createI18n({ legacy: false, locale: preferredLocale.value, fallbackLocale: 'en', messages: { 'zh-CN': zh, en } })
export const { t, locale } = i18n.global
export const uiLocale = computed(() => locale.value === 'zh-CN' ? zhUi : enUi)
watch(preferredLocale, value => { locale.value = value }, { flush: 'sync' })

export function watchDocumentLocale() {
  watch(locale, () => {
    document.documentElement.lang = locale.value
    document.documentElement.dir = uiLocale.value.dir || 'ltr'
  }, { immediate: true, flush: 'sync' })
}
