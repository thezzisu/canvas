import { t, te } from '../app/i18n'

/** Server transfer failures are stable codes; anything else is shown as received. */
export function transferError(value: unknown): string {
  if (typeof value !== 'string' || !value) return t('terminal.upload.errors.failed')
  const key = `terminal.upload.errors.${value}`
  return /^[a-zA-Z]+$/u.test(value) && te(key) ? t(key) : value
}
