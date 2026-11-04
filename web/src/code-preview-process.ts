import { codeLanguage, textCapabilities, type CodePreviewRequest, type CodePreviewResult, type CodePreviewToken } from './code-preview-language'
import type { Plugin } from 'prettier'
import type { HighlighterCore, LanguageRegistration } from 'shiki/core'

const grammars: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
  html: () => import('shiki/langs/html.mjs'), vue: () => import('shiki/langs/vue.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'), jsx: () => import('shiki/langs/jsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'), tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'), jsonc: () => import('shiki/langs/jsonc.mjs'),
  css: () => import('shiki/langs/css.mjs'), scss: () => import('shiki/langs/scss.mjs'), less: () => import('shiki/langs/less.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'), yaml: () => import('shiki/langs/yaml.mjs'),
  python: () => import('shiki/langs/python.mjs'), shellscript: () => import('shiki/langs/shellscript.mjs'),
  sql: () => import('shiki/langs/sql.mjs'), rust: () => import('shiki/langs/rust.mjs'), go: () => import('shiki/langs/go.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
}
const parsers: Record<string, string> = { javascript: 'babel', jsx: 'babel', typescript: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'json', vue: 'vue', html: 'html', css: 'css', scss: 'scss', less: 'less', markdown: 'markdown', yaml: 'yaml' }
async function format(text: string, language: string): Promise<string> {
  const { format } = await import('prettier/standalone')
  const plugins: Plugin[] = []
  if (['html', 'vue'].includes(language)) plugins.push(await import('prettier/plugins/html'))
  if (['javascript', 'jsx', 'json', 'jsonc', 'html', 'vue'].includes(language)) plugins.push(await import('prettier/plugins/babel'))
  if (['typescript', 'tsx', 'vue'].includes(language)) plugins.push(await import('prettier/plugins/typescript'))
  if (['javascript', 'jsx', 'typescript', 'tsx', 'json', 'jsonc', 'html', 'vue'].includes(language)) plugins.push(await import('prettier/plugins/estree'))
  if (['css', 'scss', 'less', 'html', 'vue'].includes(language)) plugins.push(await import('prettier/plugins/postcss'))
  if (language === 'markdown') plugins.push(await import('prettier/plugins/markdown'))
  if (language === 'yaml') plugins.push(await import('prettier/plugins/yaml'))
  return format(text, { parser: parsers[language], plugins, printWidth: 100, tabWidth: 2, proseWrap: 'preserve' })
}
let highlighter: Promise<HighlighterCore> | undefined
function getHighlighter() {
  return highlighter ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript'), import('shiki/themes/github-dark.mjs')])
    .then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme]) =>
      createHighlighterCore({ themes: [theme.default], langs: [], engine: createJavaScriptRegexEngine() }))
    .catch(error => { highlighter = undefined; throw error })
}

/** No source HTML is returned: consumers render token text through ordinary escaping. */
export async function processCode(request: CodePreviewRequest): Promise<CodePreviewResult> {
  const capabilities = textCapabilities(request.filename), language = codeLanguage(request.filename)
  const result: CodePreviewResult = { text: request.text }
  if (!language) return result
  if (request.format && capabilities.format) {
    try { result.text = await format(request.text, language) }
    catch { result.formatError = true }
  }
  if (request.highlight && capabilities.highlight) {
    try {
      const highlighter = await getHighlighter()
      if (!highlighter.getLoadedLanguages().includes(language)) await highlighter.loadLanguage((await grammars[language]!()).default)
      const lines = highlighter.codeToTokens(result.text.replace(/\r\n|\r/gu, '\n'), { lang: language, theme: 'github-dark', tokenizeMaxLineLength: 100_000 }).tokens
      const endings = [...result.text.matchAll(/\r\n|\r|\n/gu)].map(match => match[0])
      const tokens: CodePreviewToken[] = []
      const append = (text: string, color?: string) => {
        if (!text) return
        const previous = tokens.at(-1)
        if (previous && previous.color === color) previous.text += text
        else tokens.push({ text, ...(color ? { color } : {}) })
      }
      lines.forEach((line, index) => {
        for (const token of line) append(token.content, token.color)
        if (endings[index]) append(endings[index]!)
      })
      // Keep both source fidelity and the number of DOM spans bounded.
      if (tokens.length > 20_000 || tokens.map(token => token.text).join('') !== result.text) result.highlightError = true
      else result.tokens = tokens
    } catch { result.highlightError = true }
  }
  return result
}
