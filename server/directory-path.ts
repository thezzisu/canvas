import { posix } from 'node:path'

export function directoryPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !posix.isAbsolute(value) ||
    Buffer.byteLength(value, 'utf8') > 8192 ||
    Buffer.from(value, 'utf8').toString('utf8') !== value ||
    /[\x00-\x1f\x7f]/u.test(value)
  )
    throw new Error('Invalid directory path')
  return posix.normalize(value)
}
