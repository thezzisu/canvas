import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ui from '@nuxt/ui/vue-plugin'
import App from './App.vue'
import { followInstance, router } from './router'
import { initializeViewportPolicy } from './developer-mode'
import { initializePwa } from './pwa'
import { i18n, watchDocumentLocale } from './i18n'
import { initializeStatusPulse } from './status-pulse'
import { initializeUiScale } from './ui-scale'
import './styles/ui.css'
import 'virtual:canvas-fonts.css'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/minimap/dist/style.css'
import '@vue-flow/node-resizer/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './styles/style.css'
import './styles/card-presentation.css'
import './styles/sidebar.css'

document.documentElement.classList.add('dark')
initializeViewportPolicy()
initializeUiScale()
initializePwa()
initializeStatusPulse()
watchDocumentLocale()
const app = createApp(App).use(createPinia()).use(router).use(i18n).use(ui)
void followInstance().then(() => app.mount('#app'))
