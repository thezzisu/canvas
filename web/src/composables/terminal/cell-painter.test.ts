import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTR,
  DEFAULT_COLOUR,
  type CellCursor,
  type CellRun,
  type CellStyle,
} from '../../../../shared/cell-wire.ts'
import { CellPainter, type CellPainterOptions, type CellScreen } from './cell-painter.ts'

/** Just enough of an element for the painter: a tree, inline styles and events. */
class FakeElement extends EventTarget {
  parent: FakeElement | undefined
  children: (FakeElement | string)[] = []
  className = ''
  hidden = false
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  properties = new Map<string, string>()
  style: Record<string, unknown> = {
    cssText: '',
    setProperty: (name: string, value: string) => this.properties.set(name, value),
    removeProperty: (name: string) => this.properties.delete(name),
  }
  box = { left: 0, top: 0, width: 0, height: 0 }
  classList = {
    toggle: (name: string, on: boolean) => {
      const names = new Set(this.className.split(' ').filter(Boolean))
      if (on) names.add(name)
      else names.delete(name)
      this.className = [...names].join(' ')
    },
  }
  get isConnected(): boolean {
    return !!this.parent?.isConnected
  }
  get textContent(): string {
    return this.children
      .map((child) => (typeof child === 'string' ? child : child.textContent))
      .join('')
  }
  set textContent(text: string) {
    this.replaceChildren(...(text ? [text] : []))
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  private adopt(nodes: (FakeElement | string)[]) {
    for (const node of nodes) {
      if (typeof node === 'string') continue
      node.remove()
      node.parent = this
    }
    return nodes
  }
  append(...nodes: (FakeElement | string)[]) {
    this.children.push(...this.adopt(nodes))
  }
  appendChild(node: FakeElement) {
    this.append(node)
    return node
  }
  replaceChildren(...nodes: (FakeElement | string)[]) {
    for (const child of this.children) if (typeof child !== 'string') child.parent = undefined
    this.children = []
    this.append(...nodes)
  }
  before(...nodes: FakeElement[]) {
    const parent = this.parent!
    parent.adopt(nodes)
    parent.children.splice(parent.children.indexOf(this), 0, ...nodes)
  }
  after(node: FakeElement) {
    const parent = this.parent!
    parent.adopt([node])
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node)
  }
  remove() {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = undefined
  }
  getBoundingClientRect() {
    return this.box
  }
}

/** A page whose fonts are 8.4 by 18 px, where CJK is twice as wide. */
function page(t: TestContext, ratio = 1) {
  const body = new FakeElement()
  Object.defineProperty(body, 'isConnected', { value: true })
  const frames: (() => void)[] = []
  const measured: string[] = []
  const globals: Record<string, unknown> = {
    document: { createElement: () => new FakeElement(), body },
    window: { devicePixelRatio: ratio },
    getComputedStyle: () => ({ borderTopWidth: `${1 / ratio}px` }),
    matchMedia: () => new EventTarget(),
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    OffscreenCanvas: class {
      getContext() {
        return {
          font: '',
          measureText(text: string) {
            measured.push(text)
            const cells = [...text].reduce(
              (sum, ch) => sum + (ch.codePointAt(0)! > 0x2e7f ? 2 : 1),
              0,
            )
            return { width: cells * 8.4, fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 4 }
          },
        }
      }
    },
  }
  const saved = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  )
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  t.after(() => {
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
  })
  // The font probe reads its own width against a ruler of 1000 px.
  FakeElement.prototype.getBoundingClientRect = function (this: FakeElement) {
    if (this.style.width === '1000px') return { ...this.box, width: 1000 }
    const probe = this.textContent
    return /^W+$/u.test(probe) ? { ...this.box, width: probe.length * 8.4 } : this.box
  }
  return {
    body,
    measured,
    /** Runs the animation frame, if one was asked for. */
    frame: () => frames.splice(0).forEach((callback) => callback()),
    pending: () => frames.length,
  }
}

const plain: CellStyle = {
  attrs: 0,
  fg: DEFAULT_COLOUR,
  bg: DEFAULT_COLOUR,
  underline: DEFAULT_COLOUR,
  link: 0,
}
const cursor: CellCursor = { x: 0, y: 0, shape: 'block', visible: true, blink: true }
type Piece = Omit<CellRun, 'column' | 'columns' | 'wide'> & { wide?: boolean }
/** Runs side by side from the first column. */
function runs(pieces: Piece[]): CellRun[] {
  let column = 0
  return pieces.map((piece) => {
    const wide = !!piece.wide
    const run = { ...piece, wide, column, columns: piece.text.length * (wide ? 2 : 1) }
    column += run.columns
    return run
  })
}
const line = (text: string, style = 0): CellRun[] => runs([{ style, text }])
const options = (extra: Partial<CellPainterOptions> = {}): CellPainterOptions => ({
  font: { family: 'monospace', size: 14, lineHeight: 1, ligatures: false },
  theme: {
    foreground: 0xd5d7dd,
    background: 0x111317,
    cursor: 0xe8b183,
    cursorAccent: 0x111317,
    selectionBackground: 0x415168,
  },
  ...extra,
})
/** A painter on a screen the test changes as a mirror would. */
function mount(body: unknown, extra: Partial<CellPainterOptions> = {}) {
  const screen: CellScreen = {
    revision: -1,
    cols: 0,
    rows: 0,
    cursor,
    links: [],
    styles: [],
    lines: [],
  }
  const painter = new CellPainter(body as HTMLElement, screen, options(extra))
  return {
    painter,
    frame(lines: CellRun[][], extra: Partial<CellScreen> = {}) {
      Object.assign(screen, {
        revision: 1,
        cols: 20,
        rows: lines.length,
        cursor,
        styles: [plain],
        links: [],
        lines,
        ...extra,
      })
      painter.update({ frame: true, rows: lines.map((_, y) => y) })
    },
    patch(revision: number, rows: Record<number, CellRun[]>, extra: Partial<CellScreen> = {}) {
      for (const [y, runs] of Object.entries(rows)) screen.lines[+y] = runs
      Object.assign(screen, { revision, ...extra })
      painter.update({ frame: false, rows: Object.keys(rows).map(Number) })
    },
  }
}
const fake = (element: unknown) => element as FakeElement
const rowsOf = (painter: CellPainter) =>
  fake(painter.element).children.filter(
    (child): child is FakeElement => typeof child !== 'string' && child.className === 'tg-row',
  )

test('a frame is painted in the next animation frame and reported once', (t) => {
  const dom = page(t)
  const painted: number[] = []
  const metrics: unknown[] = []
  const { painter, frame } = mount(dom.body, {
    label: 'shell',
    onPaint: (revision) => painted.push(revision),
    onMetrics: (cell) => metrics.push(cell),
  })
  frame([line('one'), line('two')])
  assert.deepEqual(painted, [])
  assert.equal(dom.pending(), 1)
  dom.frame()
  assert.deepEqual(painted, [1])
  assert.deepEqual(
    rowsOf(painter).map((row) => row.textContent),
    ['one', 'two'],
  )
  const root = fake(painter.element)
  // 8.4 px is rounded down to 537/64 px, and 20 cells are exactly 20 times that.
  assert.deepEqual(metrics, [{ width: 537 / 64, height: 18 }])
  assert.deepEqual(painter.metrics, { width: 537 / 64, height: 18 })
  assert.equal(root.style.width, `${(20 * 537 + 0.2) / 64}px`)
  assert.equal(root.style.height, '36px')
  // A window that names no colours of its own takes the theme's.
  assert.equal(root.properties.get('--tg-fg'), '#d5d7dd')
  assert.equal(root.properties.get('--tg-bg'), '#111317')
  assert.equal(painter.background, '#111317')
  assert.equal(root.attributes.get('role'), 'group')
  assert.equal(root.attributes.get('aria-label'), 'shell')
  assert.equal(root.attributes.get('aria-live'), 'off')
  painter.dispose()
  assert.equal(root.parent, undefined)
})

test('changed rows alone are repainted', (t) => {
  const dom = page(t)
  const painted: number[] = []
  const { painter, frame, patch } = mount(dom.body, {
    onPaint: (revision) => painted.push(revision),
  })
  frame([line('one'), line('two'), line('three')])
  dom.frame()
  const before = rowsOf(painter).map((row) => row.children[0])
  patch(2, { 1: line('TWO') })
  dom.frame()
  const after = rowsOf(painter)
  assert.deepEqual(
    after.map((row) => row.textContent),
    ['one', 'TWO', 'three'],
  )
  assert.equal(after[0]!.children[0], before[0])
  assert.notEqual(after[1]!.children[0], before[1])
  assert.equal(after[2]!.children[0], before[2])
  assert.deepEqual(painted, [1, 2])
  // Several changes before a frame are one paint, of the last revision.
  patch(3, { 0: line('a') })
  patch(4, { 0: line('b') })
  assert.equal(dom.pending(), 1)
  dom.frame()
  assert.deepEqual(painted, [1, 2, 4])
  assert.equal(rowsOf(painter)[0]!.textContent, 'b')
  // The overlays stay last, above every row.
  const classes = fake(painter.element).children.map((child) => fake(child).className)
  assert.deepEqual(classes.slice(-3), ['tg-selection', 'tg-links', 'tg-cursor'])
  painter.dispose()
})

test('a new size keeps the rows it can and a new table replaces the old', (t) => {
  const dom = page(t)
  const { painter, frame, patch } = mount(dom.body)
  frame([line('1'), line('2'), line('3')])
  dom.frame()
  const red: CellStyle = { ...plain, fg: 0xff0000 }
  frame([line('x', 1)], { revision: 5, cols: 10, styles: [plain, red], background: 0x202020 })
  dom.frame()
  const rows = rowsOf(painter)
  assert.equal(rows.length, 1)
  const segment = fake(rows[0]!.children[0])
  assert.equal(fake(segment.children[0]).style.cssText, 'color:#ff0000;')
  assert.equal(fake(painter.element).style.width, `${(10 * 537 + 0.2) / 64}px`)
  assert.equal(painter.background, '#202020')
  // Styles appended by a patch continue the table.
  patch(
    6,
    {
      0: runs([
        { style: 2, text: 'ab' },
        { style: 0, text: 'cd' },
      ]),
    },
    { styles: [plain, red, { ...plain, bg: 0x00ff00 }] },
  )
  dom.frame()
  assert.equal(
    rowsOf(painter)[0]!.style.background,
    'linear-gradient(to right,#00ff00 16.7813px,var(--tg-bg) 0)',
  )
  painter.dispose()
})

test('fonts are measured once, however many painters and paints', (t) => {
  const dom = page(t)
  const font = { family: 'once', size: 14, lineHeight: 1, ligatures: false }
  const mounted = Array.from({ length: 40 }, () => mount(dom.body, { font }))
  const wide = runs([{ style: 0, text: ['中', '文'], wide: true }])
  for (const { frame } of mounted) frame([line('plain ascii'), wide])
  dom.frame()
  const first = dom.measured.length
  assert.ok(first > 0 && first < 12, `${first} measurements`)
  for (const { frame } of mounted) frame([line('other text'), wide], { revision: 2 })
  dom.frame()
  assert.equal(dom.measured.length, first)
  for (const { painter } of mounted) painter.dispose()
})

test('rows are whole device pixels at a fractional ratio', (t) => {
  const dom = page(t, 2.625)
  const { painter, frame } = mount(dom.body)
  frame([line('a')])
  dom.frame()
  assert.equal(painter.metrics.height, 48 / 2.625)
  assert.equal(Number.isInteger(+(painter.metrics.width * 2.625 * 64).toFixed(6)), true)
  painter.dispose()
})

test('the cursor follows focus and covers a wide cell whole', (t) => {
  const dom = page(t)
  const { painter, frame, patch } = mount(dom.body)
  frame(
    [
      runs([
        { style: 0, text: 'ab' },
        { style: 0, text: ['中'], wide: true },
      ]),
    ],
    { cursor: { ...cursor, x: 3 } },
  )
  dom.frame()
  const element = fake(painter.element).children.at(-1) as FakeElement
  assert.equal(element.hidden, false)
  // Without the keyboard it is an outline that does not blink.
  assert.equal(element.dataset.shape, 'outline')
  assert.equal(element.dataset.blink, undefined)
  assert.equal(element.textContent, '')
  painter.setFocus(true)
  assert.equal(element.dataset.shape, 'block')
  assert.ok(element.dataset.blink)
  assert.equal(element.textContent, '中')
  assert.deepEqual(painter.cursorBox(), {
    left: (2 * 537) / 64,
    top: 0,
    width: (2 * 537) / 64,
    height: 18,
  })
  // A move starts the blink over.
  const phase = element.dataset.blink
  patch(2, {}, { cursor: { ...cursor, x: 0, shape: 'bar' } })
  dom.frame()
  assert.notEqual(element.dataset.blink, phase)
  assert.equal(element.dataset.shape, 'bar')
  assert.equal(element.textContent, '')
  patch(3, {}, { cursor: { ...cursor, visible: false } })
  dom.frame()
  assert.equal(element.hidden, true)
  painter.dispose()
})

test('hit testing, links and the selection work in the scaled box the page shows', (t) => {
  const dom = page(t)
  const clicks: string[] = []
  const { painter, frame, patch } = mount(dom.body, { onLink: (uri) => clicks.push(uri) })
  const linked: CellStyle = { ...plain, attrs: ATTR.bold, link: 1 }
  frame(
    [
      runs([
        { style: 1, text: 'docs' },
        { style: 0, text: ' and ' },
        { style: 0, text: ['中'], wide: true },
      ]),
      line('see https://example.com/x.'),
    ],
    { cols: 30, styles: [plain, linked], links: ['file:///srv/readme.md'] },
  )
  dom.frame()
  // The card is drawn at half size, 100 px into the page.
  const root = fake(painter.element)
  root.box = { left: 100, top: 40, width: 30 * 4.2, height: 2 * 9 }
  const at = (column: number, row: number) => ({
    clientX: 100 + (column + 0.5) * 4.2,
    clientY: 40 + (row + 0.5) * 9,
  })
  assert.deepEqual(painter.cellAt(100 + 9.6 * 4.2, 41), { column: 9, row: 0 })
  assert.deepEqual(painter.cellAt(100 + 29.9 * 4.2, 57.9), { column: 29, row: 1 })
  assert.deepEqual(painter.cellAt(0, 0), { column: 0, row: 0 })
  const click = (column: number, row: number, button = 0) =>
    root.dispatchEvent(Object.assign(new Event('click'), at(column, row), { button }))
  const move = (column: number, row: number) =>
    root.dispatchEvent(Object.assign(new Event('mousemove'), at(column, row)))
  const underlined = () => fake(root.children.at(-2)).children.length
  click(1, 0)
  click(1, 0, 1)
  click(6, 0)
  click(10, 1)
  click(25, 1)
  assert.deepEqual(clicks, ['file:///srv/readme.md', 'https://example.com/x'])
  assert.equal(painter.linkAt(10, 1), 'https://example.com/x')
  assert.equal(painter.linkAt(6, 0), undefined)
  move(2, 0)
  assert.equal(underlined(), 1)
  assert.equal(root.className, 'terminal-grid tg-link')
  move(6, 0)
  assert.equal(underlined(), 0)
  assert.equal(root.className, 'terminal-grid')
  painter.setPointer({ column: 12, row: 1 })
  assert.equal(underlined(), 1)
  // The row under the pointer changes: the underline goes with the link.
  patch(2, { 1: line('gone') })
  dom.frame()
  assert.equal(underlined(), 0)
  root.dispatchEvent(new Event('mouseleave'))
  // A selection is one box per row, from its first cell through its last.
  const selected = () =>
    fake(root.children.at(-3)).children.map((box) => fake(box).style.cssText as string)
  painter.setSelection({ start: { column: 28, row: 0 }, end: { column: 0, row: 1 } })
  assert.deepEqual(selected(), [
    `left:${(28 * 537) / 64}px;top:0px;width:${(2 * 537) / 64}px;`,
    `left:0px;top:18px;width:${537 / 64}px;`,
  ])
  painter.setSelection()
  assert.deepEqual(selected(), [])
  painter.dispose()
})
