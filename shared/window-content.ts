export type WindowContentItem =
  | { id: string; kind: 'file'; label: string; path: string | null }
  | { id: string; kind: 'link'; label: string; url: string }

export interface WindowContentPane {
  id: string
  name: string
  cwd?: string
  items: WindowContentItem[]
}

export interface WindowContentScan {
  id: string
  panes: WindowContentPane[]
  truncated: boolean
  incomplete?: boolean
}

export interface WindowContentOpen {
  id: string
  filename: string
  size: number
  mime: string
  url: string
  temporary: boolean
  sourcePreview?: boolean
}

/** An absolute directory path without control characters, as a window's working directory. */
export const validCwd = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  value.length <= 8192 &&
  !/[\x00-\x1f\x7f-\x9f]/u.test(value)
