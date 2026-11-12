import { createApp } from 'vue'
import ui from '@nuxt/ui/vue-plugin'
import DocumentPreview from './components/files/DocumentPreview.vue'
import { i18n, watchDocumentLocale } from './plugins/i18n'
import './assets/css/ui.css'
import 'virtual:canvas-fonts.css'
document.documentElement.classList.add('dark', 'document-mode')
watchDocumentLocale()
createApp(DocumentPreview).use(i18n).use(ui).mount('#app')
