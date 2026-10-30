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
}

export interface WindowContentOpen {
  id: string
  filename: string
  size: number
  mime: string
  preview: 'image' | 'pdf' | 'text' | 'file'
  url: string
  temporary: boolean
}
