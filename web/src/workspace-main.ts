import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ui from '@nuxt/ui/vue-plugin'
import App from './App.vue'
import { followInstance, router } from './plugins/router'
import { initializeViewportPolicy } from './composables/developer-mode'
import { initializePwa } from './plugins/pwa'
import { i18n, watchDocumentLocale } from './plugins/i18n'
import { initializeStatusPulse } from './utils/status-pulse'
import { initializeUiScale } from './composables/ui-scale'
import './assets/css/ui.css'
import 'virtual:canvas-fonts.css'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/minimap/dist/style.css'
import '@vue-flow/node-resizer/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './assets/css/style.css'
import './assets/css/card-presentation.css'

document.documentElement.classList.add('dark')
initializeViewportPolicy()
initializeUiScale()
initializePwa()
initializeStatusPulse()
watchDocumentLocale()
const app = createApp(App).use(createPinia()).use(router).use(i18n).use(ui)
void followInstance().then(() => app.mount('#app'))
