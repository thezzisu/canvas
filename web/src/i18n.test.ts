import test from 'node:test'
import assert from 'node:assert/strict'
import { i18n, languagePreference, locale, t, uiLocale } from './i18n.ts'
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

test('English counts use singular and plural forms while Chinese counts stay natural', context => {
  const previous = locale.value
  context.after(() => { locale.value = previous })
  locale.value = 'en'
  assert.equal(t('app.windowCount', 0), '0 windows')
  assert.equal(t('app.windowCount', 1), '1 window')
  assert.equal(t('app.windowCount', 2), '2 windows')
  assert.equal(t('panels.windows', 1), '1 window')
  assert.equal(t('panels.windows', 2), '2 windows')
  locale.value = 'zh-CN'
  assert.equal(t('app.windowCount', 1), '1 个窗口')
  assert.equal(t('app.windowCount', 2), '2 个窗口')
})

test('one language preference drives application messages, status labels and Nuxt UI', context => {
  const previous = languagePreference.value
  context.after(() => { languagePreference.value = previous })
  languagePreference.value = 'zh-CN'
  assert.equal(locale.value, 'zh-CN')
  assert.equal(uiLocale.value.code, 'zh-CN')
  assert.equal(statusLabel('working'), '运行中')
  assert.equal(t('settings.developerAdvanced'), '开发者高级设置')
  languagePreference.value = 'en'
  assert.equal(locale.value, 'en')
  assert.equal(uiLocale.value.code, 'en')
  assert.equal(statusLabel('working'), 'Running')
  assert.equal(t('settings.developerAdvanced'), 'Advanced developer settings')
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
  assert.equal(transferError('draftChanged'), 'The draft changed on another device')
  assert.equal(transferError(undefined), 'Transfer failed')
  assert.equal(transferError('plain native message'), 'plain native message')
  locale.value = 'zh-CN'
  assert.equal(transferError('windowClosed'), '目标窗口已关闭')
})
