import { createMarkdownParser, type ComarkPlugin } from 'comark'
import security from 'comark/plugins/security'
import { visit } from 'comark/utils'

export interface MarkdownResources { document: string; root: string }
function links(resources?: MarkdownResources): ComarkPlugin { return {
  name: 'canvas-file-links',
  post({ tree }) {
    visit(tree, node => Array.isArray(node) && (node[0] === 'a' || node[0] === 'img'), node => {
      if (!Array.isArray(node)) return
      const key = node[0] === 'a' ? 'href' : 'src'
      let url: URL | undefined
      const value = String(node[1][key] || '')
      if (resources && node[0] === 'a' && value.startsWith('#')) return
      try {
        if (resources) {
          const root = new URL(resources.root), base = new URL(resources.document)
          url = value.startsWith('/') && !value.startsWith('//')
            ? new URL(value.slice(1), root) : new URL(value, base)
          const local = url.origin === root.origin && url.pathname.startsWith(root.pathname)
          if (url.origin === root.origin && !local || node[0] === 'img' && !local) url = undefined
        } else url = new URL(value)
      } catch { /* Uploaded files have no source directory. */ }
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        if (node[0] === 'img') return String(node[1].alt || '')
        delete node[1].href
        return
      }
      node[1][key] = url.href
      node[1].referrerpolicy = 'no-referrer'
      if (node[0] === 'a') {
        if (!resources || url.origin !== new URL(resources.root).origin) node[1].target = '_blank'
        node[1].rel = 'noopener noreferrer'
      }
      else node[1].zoom = false
    })
  },
} }

/** Plain Markdown only: no HTML, MDC components, attributes, bindings or frontmatter. */
function parser(resources?: MarkdownResources) { return createMarkdownParser({
  registerDefaultPlugins: false, autoClose: false, headingIds: !!resources,
  plugins: [security({ allowedTags: ['p', 'a', 'blockquote', 'code', 'pre', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    'img', 'ul', 'ol', 'li', 'strong', 'table', 'thead', 'tbody', 'td', 'th', 'tr', 'del', 'br'],
    allowedProtocols: ['http', 'https'], allowDataImages: false }), links(resources)],
}) }
const uploadedFileParser = parser()
export function parseFileMarkdown(text: string, resources?: MarkdownResources) {
  return resources ? parser(resources)(text) : uploadedFileParser(text)
}
export const isMarkdownFile = (name: string) => /\.(?:md|markdown|mdown|mkdn?|mdx)$/iu.test(name)
