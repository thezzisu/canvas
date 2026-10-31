import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

/** Attribute shipped modules, including dependencies used only by the browser. */
export function thirdPartyNoticesPlugin(): Plugin {
  return {
    name: 'canvas-third-party-notices',
    generateBundle(_options, bundle) {
      const packages = new Map<string, string>()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const [id, module] of Object.entries(output.modules)) {
          if (module.renderedLength === 0 || !id.includes('/node_modules/')) continue
          let directory = dirname(id.replace(/^\0/, '').split('?')[0]!)
          while (directory.includes('/node_modules/')) {
            const manifest = join(directory, 'package.json')
            if (existsSync(manifest)) {
              const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
              if (metadata.name && metadata.version) { packages.set(`${metadata.name}@${metadata.version}`, directory); break }
            }
            const parent = dirname(directory)
            if (parent === directory) break
            directory = parent
          }
        }
      }
      // Workbox's generated service worker is emitted after the main bundle.
      packages.set('Workbox', join(root, 'node_modules/workbox-core'))
      const notices = [readFileSync(join(root, 'THIRD_PARTY_NOTICES'), 'utf8').trim()]
      for (const [name, directory] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
        const files = readdirSync(directory).filter(file => /^(?:licen[sc]e|copying|notice)(?:[._-]|$)/i.test(file))
        if (!files.length) this.error(`Missing third-party license for ${name}`)
        notices.push(name, ...files.map(file => readFileSync(join(directory, file), 'utf8').trim()))
      }
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES', source: notices.join('\n\n----------------------------------------\n\n') + '\n' })
    },
  }
}
