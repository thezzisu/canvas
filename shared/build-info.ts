export interface BuildInfo { version: string; revision: string | null; dirty: boolean }

export function isBuildInfo(value: unknown): value is BuildInfo {
  if (!value || typeof value !== 'object') return false
  const info = value as Partial<BuildInfo>
  return typeof info.version === 'string' && info.version.length > 0 && info.version.length <= 100 &&
    (info.revision === null || typeof info.revision === 'string' && /^[a-f0-9]{40,64}$/i.test(info.revision)) && typeof info.dirty === 'boolean'
}

export function buildLabel(info: BuildInfo): string {
  return `${info.version}${info.revision ? ` · ${info.revision.slice(0, 7)}` : ''}${info.dirty ? ' *' : ''}`
}
