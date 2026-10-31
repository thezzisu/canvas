import { createApp } from 'vue'
import ui from '@nuxt/ui/vue-plugin'
import App from './App.vue'
import { initializeViewportPolicy } from './developer-mode'
import { initializePwa } from './pwa'
import { i18n, watchDocumentLocale } from './i18n'
import { clearCopiedFile } from './file-clipboard'
import { initializeStatusPulse } from './status-pulse'
import { initializeUiScale } from './ui-scale'
import './ui.css'
import 'virtual:canvas-fonts.css'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/minimap/dist/style.css'
import '@vue-flow/node-resizer/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import './card-presentation.css'

document.documentElement.classList.add('dark')
initializeViewportPolicy()
initializeUiScale()
initializePwa()
initializeStatusPulse()
watchDocumentLocale()
document.addEventListener('copy', clearCopiedFile)
createApp(App).use(i18n).use(ui).mount('#app')
