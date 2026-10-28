import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'

export default defineConfig({
  root: 'web',
  plugins: [vue(), ui({ router: false, colorMode: false, autoImport: false, components: false, dts: false,
    icon: { clientBundle: { icons: ['lucide:download'] } },
    ui: { colors: { primary: 'amber', neutral: 'slate' } } })],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:3010', ws: true },
    },
  },
})
