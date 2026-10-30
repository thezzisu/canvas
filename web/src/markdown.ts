import { createMarkdownParser, type ComarkPlugin } from 'comark'
import security from 'comark/plugins/security'
import { visit } from 'comark/utils'

const links: ComarkPlugin = {
  name: 'canvas-file-links',
  post({ tree }) {
    visit(tree, node => Array.isArray(node) && (node[0] === 'a' || node[0] === 'img'), node => {
      if (!Array.isArray(node)) return
      const key = node[0] === 'a' ? 'href' : 'src'
      let url: URL | undefined
      try { url = new URL(String(node[1][key] || '')) } catch { /* File-relative resources have no browser URL. */ }
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        if (node[0] === 'img') return String(node[1].alt || '')
        delete node[1].href
        return
      }
      node[1][key] = url.href
      node[1].referrerpolicy = 'no-referrer'
      if (node[0] === 'a') { node[1].target = '_blank'; node[1].rel = 'noopener noreferrer' }
      else node[1].zoom = false
    })
  },
}

/** Plain Markdown only: no HTML, MDC components, attributes, bindings or frontmatter. */
export const parseFileMarkdown = createMarkdownParser({
  registerDefaultPlugins: false, autoClose: false, headingIds: false,
  plugins: [security({ allowedTags: ['p', 'a', 'blockquote', 'code', 'pre', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    'img', 'ul', 'ol', 'li', 'strong', 'table', 'thead', 'tbody', 'td', 'th', 'tr', 'del', 'br'],
    allowedProtocols: ['http', 'https'], allowDataImages: false }), links],
})
export const isMarkdownFile = (name: string) => /\.(?:md|markdown|mdown|mkdn?|mdx)$/iu.test(name)
