export interface CodePreviewRequest { text: string; filename: string; format: boolean; highlight: boolean }
export interface CodePreviewToken { text: string; color?: string }
export interface CodePreviewResult {
  text: string
  tokens?: CodePreviewToken[]
  formatError?: true
  highlightError?: true
}

const extensions: Record<string, string> = {
  html: 'html', htm: 'html', vue: 'vue',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'jsonc', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown', mkdn: 'markdown',
  yaml: 'yaml', yml: 'yaml', py: 'python', sh: 'shellscript', bash: 'shellscript',
  sql: 'sql', rs: 'rust', go: 'go', xml: 'xml', svg: 'xml',
}
const formatted = new Set(['html', 'vue', 'javascript', 'jsx', 'typescript', 'tsx', 'json', 'jsonc', 'css', 'scss', 'less', 'markdown', 'yaml'])
export function codeLanguage(filename: string): string | undefined {
  const name = filename.split(/[\\/]/u).at(-1)?.toLowerCase() || ''
  const dot = name.lastIndexOf('.')
  return dot < 0 ? undefined : extensions[name.slice(dot + 1)]
}
export function textCapabilities(filename: string) {
  const language = codeLanguage(filename)
  return { format: !!language && formatted.has(language), highlight: !!language, html: language === 'html' }
}
