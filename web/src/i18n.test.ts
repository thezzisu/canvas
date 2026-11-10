import test from 'node:test'
import assert from 'node:assert/strict'
import { i18n, languagePreference, locale, uiLocale } from './i18n.ts'
import { statusLabel } from './status.ts'

function flatten(value: object, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof item === 'string' ? [[path, item]] : Object.entries(flatten(item, path))
  }))
}

test('both catalogues provide the same messages and interpolation parameters', () => {
  const zh = flatten(i18n.global.getLocaleMessage('zh-CN'))
  const en = flatten(i18n.global.getLocaleMessage('en'))
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  const parameters = (message: string) => [...new Set([...message.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort()
  for (const key of Object.keys(zh)) {
    assert(en[key]?.trim() && zh[key]?.trim(), `${key} is not empty`)
    assert.deepEqual(parameters(en[key]!), parameters(zh[key]!), `${key} interpolation matches`)
  }
})

test('one language preference drives application messages, status labels and Nuxt UI', context => {
  const previous = languagePreference.value
  context.after(() => { languagePreference.value = previous })
  for (const code of ['zh-CN', 'en'] as const) {
    languagePreference.value = code
    assert.equal(locale.value, code)
    assert.equal(uiLocale.value.code, code)
    assert.equal(statusLabel('working'), flatten(i18n.global.getLocaleMessage(code))['terminal.status.working'])
  }
})

test('every server transfer code is localized, and the server sends only known codes', async context => {
  const { transferError } = await import('./transfer-error.ts')
  const { transferErrors } = await import('../../shared/transfer-errors.ts')
  const { readFileSync } = await import('node:fs')
  const previous = locale.value
  context.after(() => { locale.value = previous })
  for (const locale of ['en', 'zh-CN'] as const) {
    const messages = flatten(i18n.global.getLocaleMessage(locale))
    for (const code of transferErrors) assert(messages[`terminal.upload.errors.${code}`], `${locale} translates ${code}`)
  }
  const server = ['uploads.ts', 'composer-send.ts', 'inbox.ts', 'terminals.ts'].map(name => readFileSync(new URL(`../../server/${name}`, import.meta.url), 'utf8')).join('\n')
  const known = new Set<string>(transferErrors)
  for (const [, code] of server.matchAll(/(?:new Error\(|fail\(|this\.fail\(batch, )"([a-zA-Z]+)"/g)) assert(known.has(code!), `${code} is a declared transfer code`)
  locale.value = 'en'
  const en = flatten(i18n.global.getLocaleMessage('en'))
  assert.equal(transferError('draftChanged'), en['terminal.upload.errors.draftChanged'])
  assert.equal(transferError(undefined), en['terminal.upload.errors.failed'])
  assert.equal(transferError('plain native message'), 'plain native message')
})
