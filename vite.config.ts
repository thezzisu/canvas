import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { pwaOptions } from './pwa.config.ts'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: 'web',
  plugins: [VitePWA(pwaOptions), vue(), VueI18nPlugin({ include: fileURLToPath(new URL('./web/src/locales/**', import.meta.url)) }), ui({ prose: true, router: false, colorMode: false, autoImport: false, components: false, dts: false,
    icon: { clientBundle: { icons: ['lucide:x', 'lucide:chevron-down', 'lucide:check', 'lucide:copy', 'lucide:copy-check'] } },
    ui: { colors: { primary: 'amber', neutral: 'zinc' } },
  })],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:3010', ws: true },
    },
  },
})
