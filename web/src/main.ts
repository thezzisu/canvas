import { createApp } from 'vue'
import ui from '@nuxt/ui/vue-plugin'
import App from './App.vue'
import { watchViewportPolicy } from './developer-mode'
import './ui.css'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/minimap/dist/style.css'
import '@vue-flow/node-resizer/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './style.css'

document.documentElement.classList.add('dark')
watchViewportPolicy()
createApp(App).use(ui).mount('#app')
