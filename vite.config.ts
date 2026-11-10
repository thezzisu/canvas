import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { notificationWorker, pwaOptions } from './pwa.config.ts'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import { fileURLToPath } from 'node:url'
import { readBuildInfo } from './build-info.config.ts'
import { contentFontsPlugin } from './fonts.config.ts'

const buildInfo = readBuildInfo()

export default defineConfig({
  base: './',
  root: 'web',
  worker: { format: 'es', rolldownOptions: { output: {
    entryFileNames: 'assets/code-preview/[name]-[hash].js', chunkFileNames: 'assets/code-preview/[name]-[hash].js',
  } } },
  define: { __CANVAS_FRONTEND_BUILD__: JSON.stringify(buildInfo) },
  plugins: [{ name: 'canvas-build-info', generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify(buildInfo) + '\n' })
    this.emitFile({ type: 'asset', ...notificationWorker })
  } }, contentFontsPlugin(), VitePWA(pwaOptions), vue(), VueI18nPlugin({ include: fileURLToPath(new URL('./web/src/locales/**', import.meta.url)) }), ui({ prose: true, router: false, colorMode: false, autoImport: false, components: false, dts: false,
    icon: { clientBundle: { scan: { globInclude: ['src/**/*.{vue,ts}'] } } },
    ui: {
      colors: { primary: 'peach', neutral: 'canvas' },
      modal: {
        slots: { overlay: 'canvas-modal-overlay', content: 'canvas-modal-content' },
        compoundVariants: [{ scrollable: false, fullscreen: false, class: {
          content: 'top-[calc(var(--dialog-top,0px)+var(--dialog-height,100dvh)/2)] max-h-[calc(var(--dialog-height,100dvh)-2rem)] sm:max-h-[calc(var(--dialog-height,100dvh)-4rem)]',
        } }],
      },
      toast: { slots: {
        root: '[--ui-error:#f38ba8] [--ui-success:#94e2d5]',
        title: '[overflow-wrap:anywhere]',
        description: 'whitespace-pre-line [overflow-wrap:anywhere]',
        actions: 'flex-wrap',
      } },
      toaster: { slots: { viewport: 'm-0 p-0 list-none' } },
    },
  })],
  build: { outDir: '../dist/web', emptyOutDir: true, rolldownOptions: { output: { comments: { legal: true } } } },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:3010', ws: true },
    },
  },
})
