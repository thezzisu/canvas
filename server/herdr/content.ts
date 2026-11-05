import type { ClientShellSnapshot, FrameData, PaneSurfaceFrame, SurfaceRect } from './wire.ts'
import { popupInnerRect } from './screen.ts'
import { terminalCellWidth } from '../../shared/terminal-unicode.ts'

export interface NativeContentPane {
  id: string
  name: string
  cwd?: string
  columns?: number
  incomplete?: boolean
  lines: string[]
  coloredText?: string[]
  links: Array<{ label: string; url: string }>
}

const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ')
const validCwd = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && value.length <= 8192
  && !/[\x00-\x1f\x7f-\x9f]/u.test(value)

function readPane(frame: FrameData, rect: SurfaceRect, wrapped?: (row: number) => boolean): Pick<NativeContentPane, 'lines' | 'links' | 'coloredText'> {
  const lines: string[] = [], links: NativeContentPane['links'] = []
  const coloredText: string[] = []
  let previous: { color: number; index: number; row: number; joined: boolean } | undefined
  let coloredCharacters = 0
  for (let y = rect.y; y < Math.min(frame.height, rect.y + rect.height); y++) {
    let line = '', link: { label: string; url: string } | undefined
    const runs: Array<{ color: number; text: string; left: number; right: number }> = []
    let run: typeof runs[number] | undefined, firstInk = Infinity
    for (let x = rect.x; x < Math.min(frame.width, rect.x + rect.width); x++) {
      const cell = frame.cells[y * frame.width + x]
      if (!cell || cell.skip) continue
      const concealed = !!(cell.modifier & 128)
      const width = Math.max(1, terminalCellWidth(cell.symbol))
      const text = concealed ? ' '.repeat(width) : clean(cell.symbol) || ' '
      const url = concealed || cell.hyperlink === null ? '' : frame.hyperlinks[cell.hyperlink] || ''
      line += text
      const color = concealed || url ? 0 : cell.fg
      if (run?.color !== color) { run = { color, text: '', left: Infinity, right: 0 }; runs.push(run) }
      run.text += text
      if (text.trim()) {
        firstInk = Math.min(firstInk, x); run.left = Math.min(run.left, x)
        run.right = x + width
      }
      if (url && url === link?.url) link.label += text
      else {
        if (link) links.push(link)
        link = url ? { label: text, url } : undefined
      }
      // Herdr's wide-character continuation cell may be a plain padding space.
      x += width - 1
    }
    if (link) links.push(link)
    const text = wrapped?.(y - rect.y + 1) ? line : line.trimEnd()
    if (lines.length && wrapped?.(y - rect.y)) lines[lines.length - 1] += text
    else lines.push(text)
    let next: typeof previous
    for (const part of runs) {
      const text = part.text.trim()
      if (!part.color || !text || text.length > 8192 || coloredText.length >= 200 || coloredCharacters + text.length > 64 * 1024) continue
      let index = coloredText.push(text) - 1, joined = false
      coloredCharacters += text.length
      if (previous?.row === y - 1 && previous.color === part.color && part.left === firstInk
          && coloredText.length < 200 && coloredText[previous.index]!.length + text.length <= 8192
          && coloredCharacters + (previous.joined ? 0 : coloredText[previous.index]!.length) + text.length <= 64 * 1024) {
        if (previous.joined) { index = previous.index; coloredText[index] += text; coloredCharacters += text.length }
        else { index = coloredText.push(coloredText[previous.index]! + text) - 1; coloredCharacters += coloredText[index]!.length }
        joined = true
      }
      if (part.right >= rect.x + rect.width - 1) next = { color: part.color, index, row: y, joined }
    }
    previous = next
  }
  const current = lines.map(line => line.trim()).join('')
  const hints = wrapped ? coloredText.filter(text => current.includes(text)) : coloredText
  return { lines, links, ...(hints.length ? { coloredText: hints } : {}) }
}

/** Read only the already-rendered window, retaining pane boundaries and OSC 8 targets. */
export function windowContent(surface: PaneSurfaceFrame, snapshot: ClientShellSnapshot, tabId: string, wrapped?: (pane: string, row: number) => boolean): NativeContentPane[] {
  if (surface.popup) {
    const popup = surface.popup, rect = popupInnerRect(surface)
    return rect ? [{ id: popup.terminal_id, name: clean(popup.title), columns: rect.width,
      ...readPane(popup.frame, { x: 0, y: 0, width: rect.width, height: rect.height }) }] : []
  }
  return surface.panes.flatMap(pane => {
    const metadata = snapshot.panes.find(item => item.pane_id === pane.pane_id && item.tab_id === tabId)
    if (!metadata) return []
    const cwd = validCwd(metadata.foreground_cwd) ? metadata.foreground_cwd : validCwd(metadata.cwd) ? metadata.cwd : undefined
    const name = typeof metadata.label === 'string' ? clean(metadata.label).slice(0, 200) : ''
    return [{ id: pane.pane_id, name, columns: pane.inner_rect.width, ...(cwd ? { cwd } : {}), ...readPane(surface.frame, pane.inner_rect, wrapped && (row => wrapped(pane.pane_id, row))) }]
  })
}

/** Read the current visible pane text once, without revision checks or viewport mutations. */
export async function readWindowContent(surface: PaneSurfaceFrame, snapshot: ClientShellSnapshot, tabId: string,
  read: (params: Record<string, unknown>) => Promise<unknown>): Promise<NativeContentPane[]> {
  const panes = windowContent(surface, snapshot, tabId)
  // Popup terminals do not have pane selection endpoints. Never read the panes
  // underneath; their text is not part of the displayed window at scan time.
  if (surface.popup) return panes
  for (const result of panes) {
    const pane = surface.panes.find(pane => pane.pane_id === result.id)!, rect = pane.inner_rect
    if (!rect.width || !rect.height) continue
    let concealed = false
    for (let y = rect.y; y < rect.y + rect.height && !concealed; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        if ((surface.frame.cells[y * surface.frame.width + x]?.modifier || 0) & 128) { concealed = true; break }
      }
    }
    // Plain formatters can expose concealed cells. Keep the masked painted
    // rows for this pane instead of reading its underlying terminal text.
    if (concealed) continue
    try {
      const response = await read({ pane_id: pane.pane_id, source: 'visible', format: 'text', strip_ansi: true })
      if (!response || typeof response !== 'object' || !('text' in response) || typeof response.text !== 'string'
          || 'pane_id' in response && response.pane_id !== pane.pane_id) throw new Error('Invalid pane content')
      result.lines = response.text.split('\n').map(line => clean(line.replace(/\r$/u, '')))
      // Color is a segmentation hint, never permission to scan stale painted text.
      const current = result.lines.map(line => line.trim()).join('')
      if (result.coloredText) result.coloredText = result.coloredText.filter(text => current.includes(text))
    } catch {
      result.lines = []
      delete result.coloredText
      result.incomplete = true
    }
  }
  return panes
}
