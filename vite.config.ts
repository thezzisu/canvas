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
  plugins: [{
    // Every supported browser reads woff2; drop KaTeX's woff/ttf fallbacks so they are not emitted.
    name: 'canvas-katex-woff2', enforce: 'pre',
    transform(code, id) { if (/katex[\\/]dist[\\/]katex(\.min)?\.css$/.test(id)) return code.replace(/,url\([^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, '') },
  }, { name: 'canvas-build-info', generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify(buildInfo) + '\n' })
    this.emitFile({ type: 'asset', ...notificationWorker })
  } }, contentFontsPlugin(), VitePWA(pwaOptions), vue(), VueI18nPlugin({ include: fileURLToPath(new URL('./web/src/locales/**', import.meta.url)) }), ui({ prose: true, router: false, colorMode: false, autoImport: false, components: false, dts: false,
    icon: { clientBundle: { scan: { globInclude: ['src/**/*.{vue,ts}'] } } },
    ui: {
      colors: { primary: 'peach', neutral: 'canvas' },
      // One modal geometry: centred in the unobstructed frame (window controls, visual
      // viewport, safe areas); dialogs choose only --dialog-width.
      modal: {
        slots: { overlay: 'canvas-modal-overlay', content: 'canvas-modal-content', title: 'text-base', footer: 'justify-end' },
        compoundVariants: [{ scrollable: false, fullscreen: false, class: {
          content: 'w-[min(var(--dialog-width,32rem),calc(var(--dialog-frame-width)-1.5rem))] max-w-none left-(--dialog-center-x) top-(--dialog-center-y) max-h-[calc(var(--dialog-frame-height)-1.5rem)]',
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
