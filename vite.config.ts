import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: 'web',
  plugins: [vue(), VueI18nPlugin({ include: fileURLToPath(new URL('./web/src/locales/**', import.meta.url)) }), ui({ router: false, colorMode: false, autoImport: false, components: false, dts: false,
    icon: { clientBundle: { icons: ['lucide:x', 'lucide:chevron-down', 'lucide:check'] } },
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
