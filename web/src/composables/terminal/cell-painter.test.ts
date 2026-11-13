import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  CELL_ATTR,
  CELL_DEFAULT,
  type CellCursor,
  type CellFrame,
  type CellRun,
  type CellStyle,
} from '../../utils/terminal/cell-grid.ts'
import { CellPainter, type CellPainterOptions } from './cell-painter.ts'

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
  fg: CELL_DEFAULT,
  bg: CELL_DEFAULT,
  underline: CELL_DEFAULT,
  link: 0,
}
const cursor: CellCursor = { x: 0, y: 0, shape: 'block', visible: true, blink: true }
const line = (text: string, style = 0): CellRun[] => [{ style, text }]
const frameOf = (lines: CellRun[][], extra: Partial<CellFrame> = {}): CellFrame => ({
  revision: 1,
  cols: 20,
  rows: lines.length,
  foreground: 0xd5d7dd,
  background: 0x111317,
  cursor,
  styles: [plain],
  links: [],
  lines,
  ...extra,
})
const options = (extra: Partial<CellPainterOptions> = {}): CellPainterOptions => ({
  font: { family: 'monospace', size: 14, lineHeight: 1, ligatures: false },
  theme: { cursor: 0xe8b183, cursorAccent: 0x111317, selectionBackground: 0x415168 },
  ...extra,
})
const fake = (element: unknown) => element as FakeElement
const rowsOf = (painter: CellPainter) =>
  fake(painter.element).children.filter(
    (child): child is FakeElement => typeof child !== 'string' && child.className === 'tg-row',
  )

test('a frame is painted in the next animation frame and reported once', (t) => {
  const dom = page(t)
  const painted: number[] = []
  const metrics: unknown[] = []
  const painter = new CellPainter(
    dom.body as unknown as HTMLElement,
    options({
      label: 'shell',
      onPaint: (revision) => painted.push(revision),
      onMetrics: (cell) => metrics.push(cell),
    }),
  )
  painter.frame(frameOf([line('one'), line('two')]))
  assert.deepEqual(painted, [])
  assert.equal(dom.pending(), 1)
  dom.frame()
  assert.deepEqual(painted, [1])
  assert.deepEqual(
    rowsOf(painter).map((row) => row.textContent),
    ['one', 'two'],
  )
  const root = fake(painter.element)
  // 8.4 px is rounded up to 538/64 px, and 20 cells are exactly 20 times that.
  assert.deepEqual(metrics, [{ width: 538 / 64, height: 18 }])
  assert.deepEqual(painter.metrics, { width: 538 / 64, height: 18 })
  assert.equal(root.style.width, `${(20 * 538 + 0.2) / 64}px`)
  assert.equal(root.style.height, '36px')
  assert.equal(root.properties.get('--tg-fg'), '#d5d7dd')
  assert.equal(root.properties.get('--tg-bg'), '#111317')
  assert.equal(root.attributes.get('role'), 'group')
  assert.equal(root.attributes.get('aria-label'), 'shell')
  assert.equal(root.attributes.get('aria-live'), 'off')
  painter.dispose()
  assert.equal(root.parent, undefined)
})

test('a patch repaints its rows only, and one for another revision is refused', (t) => {
  const dom = page(t)
  const painted: number[] = []
  const painter = new CellPainter(
    dom.body as unknown as HTMLElement,
    options({ onPaint: (revision) => painted.push(revision) }),
  )
  painter.frame(frameOf([line('one'), line('two'), line('three')]))
  dom.frame()
  const before = rowsOf(painter).map((row) => row.children[0])
  const patch = {
    revision: 2,
    base: 1,
    cursor,
    styles: [],
    links: [],
    scroll: 0,
    rows: [{ y: 1, runs: line('TWO') }],
  }
  assert.equal(painter.patch(patch), true)
  assert.equal(painter.patch({ ...patch, revision: 9, base: 7 }), false)
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
  painter.patch({ ...patch, revision: 3, base: 2, rows: [{ y: 0, runs: line('a') }] })
  painter.patch({ ...patch, revision: 4, base: 3, rows: [{ y: 0, runs: line('b') }] })
  assert.equal(dom.pending(), 1)
  dom.frame()
  assert.deepEqual(painted, [1, 2, 4])
  assert.equal(rowsOf(painter)[0]!.textContent, 'b')
  painter.dispose()
})

test('a scroll moves the row elements and paints only what came in', (t) => {
  const dom = page(t)
  const painter = new CellPainter(dom.body as unknown as HTMLElement, options())
  painter.frame(frameOf([line('1'), line('2'), line('3'), line('4')]))
  dom.frame()
  const before = rowsOf(painter)
  const kept = before.map((row) => row.children[0])
  painter.patch({
    revision: 2,
    base: 1,
    cursor,
    styles: [],
    links: [],
    scroll: 2,
    rows: [
      { y: 2, runs: line('5') },
      { y: 3, runs: line('6') },
    ],
  })
  dom.frame()
  const after = rowsOf(painter)
  assert.deepEqual(
    after.map((row) => row.textContent),
    ['3', '4', '5', '6'],
  )
  assert.deepEqual(after, [before[2], before[3], before[0], before[1]])
  assert.equal(after[0]!.children[0], kept[2])
  assert.equal(after[1]!.children[0], kept[3])
  // The overlays stay last, above every row.
  const classes = fake(painter.element).children.map((child) => fake(child).className)
  assert.deepEqual(classes.slice(-2), ['tg-links', 'tg-cursor'])
  painter.dispose()
})

test('a new size keeps the rows it can and a new table replaces the old', (t) => {
  const dom = page(t)
  const painter = new CellPainter(dom.body as unknown as HTMLElement, options())
  painter.frame(frameOf([line('1'), line('2'), line('3')]))
  dom.frame()
  const red: CellStyle = { ...plain, fg: 0xff0000 }
  painter.frame(frameOf([line('x', 1)], { revision: 5, cols: 10, styles: [plain, red] }))
  dom.frame()
  const rows = rowsOf(painter)
  assert.equal(rows.length, 1)
  const segment = fake(rows[0]!.children[0])
  assert.equal(fake(segment.children[0]).style.cssText, 'color:#ff0000;')
  assert.equal(fake(painter.element).style.width, `${(10 * 538 + 0.2) / 64}px`)
  // Styles appended by a patch continue the table.
  painter.patch({
    revision: 6,
    base: 5,
    cursor,
    styles: [{ ...plain, bg: 0x00ff00 }],
    links: [],
    scroll: 0,
    rows: [
      {
        y: 0,
        runs: [
          { style: 2, text: 'ab' },
          { style: 0, text: 'cd' },
        ],
      },
    ],
  })
  dom.frame()
  assert.equal(
    rowsOf(painter)[0]!.style.background,
    'linear-gradient(to right,#00ff00 16.8125px,var(--tg-bg) 0)',
  )
  painter.dispose()
})

test('fonts are measured once, however many painters and paints', (t) => {
  const dom = page(t)
  const font = { family: 'once', size: 14, lineHeight: 1, ligatures: false }
  const painters = Array.from(
    { length: 40 },
    () => new CellPainter(dom.body as unknown as HTMLElement, options({ font })),
  )
  for (const painter of painters)
    painter.frame(
      frameOf([line('plain ascii'), [{ style: 0, clusters: ['中', '文'], wide: true }]]),
    )
  dom.frame()
  const first = dom.measured.length
  assert.ok(first > 0 && first < 12, `${first} measurements`)
  for (const painter of painters)
    painter.frame(
      frameOf([line('other text'), [{ style: 0, clusters: ['中', '文'], wide: true }]], {
        revision: 2,
      }),
    )
  dom.frame()
  assert.equal(dom.measured.length, first)
  for (const painter of painters) painter.dispose()
})

test('rows are whole device pixels at a fractional ratio', (t) => {
  const dom = page(t, 2.625)
  const painter = new CellPainter(dom.body as unknown as HTMLElement, options())
  painter.frame(frameOf([line('a')]))
  dom.frame()
  assert.equal(painter.metrics.height, 48 / 2.625)
  assert.equal(Number.isInteger(+(painter.metrics.width * 2.625 * 64).toFixed(6)), true)
  painter.dispose()
})

test('the cursor follows focus and covers a wide cell whole', (t) => {
  const dom = page(t)
  const painter = new CellPainter(dom.body as unknown as HTMLElement, options())
  const wide: CellRun[] = [
    { style: 0, text: 'ab' },
    { style: 0, clusters: ['中'], wide: true },
  ]
  painter.frame(frameOf([wide], { cursor: { ...cursor, x: 3 } }))
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
    left: (2 * 538) / 64,
    top: 0,
    width: (2 * 538) / 64,
    height: 18,
  })
  // A move starts the blink over.
  const phase = element.dataset.blink
  painter.patch({
    revision: 2,
    base: 1,
    cursor: { ...cursor, x: 0, shape: 'bar' },
    styles: [],
    links: [],
    scroll: 0,
    rows: [],
  })
  dom.frame()
  assert.notEqual(element.dataset.blink, phase)
  assert.equal(element.dataset.shape, 'bar')
  assert.equal(element.textContent, '')
  painter.patch({
    revision: 3,
    base: 2,
    cursor: { ...cursor, visible: false },
    styles: [],
    links: [],
    scroll: 0,
    rows: [],
  })
  dom.frame()
  assert.equal(element.hidden, true)
  painter.dispose()
})

test('hit testing and links work in the scaled box the page shows', (t) => {
  const dom = page(t)
  const clicks: string[] = []
  const painter = new CellPainter(
    dom.body as unknown as HTMLElement,
    options({ onLink: (uri) => clicks.push(uri) }),
  )
  const linked: CellStyle = { ...plain, attrs: CELL_ATTR.bold, link: 1 }
  painter.frame(
    frameOf(
      [
        [
          { style: 1, text: 'docs' },
          { style: 0, text: ' and ' },
          { style: 0, clusters: ['中'], wide: true },
        ],
        line('see https://example.com/x.'),
      ],
      { cols: 30, styles: [plain, linked], links: ['file:///srv/readme.md'] },
    ),
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
  const click = (column: number, row: number) =>
    root.dispatchEvent(Object.assign(new Event('click'), at(column, row)))
  const move = (column: number, row: number) =>
    root.dispatchEvent(Object.assign(new Event('mousemove'), at(column, row)))
  const underlined = () => fake(root.children.at(-2)).children.length
  click(1, 0)
  click(6, 0)
  click(10, 1)
  click(25, 1)
  assert.deepEqual(clicks, ['file:///srv/readme.md', 'https://example.com/x'])
  move(2, 0)
  assert.equal(underlined(), 1)
  assert.equal(root.className, 'terminal-grid tg-link')
  move(6, 0)
  assert.equal(underlined(), 0)
  assert.equal(root.className, 'terminal-grid')
  move(12, 1)
  assert.equal(underlined(), 1)
  // The row under the pointer changes: the underline goes with the link.
  painter.patch({
    revision: 2,
    base: 1,
    cursor,
    styles: [],
    links: [],
    scroll: 0,
    rows: [{ y: 1, runs: line('gone') }],
  })
  dom.frame()
  assert.equal(underlined(), 0)
  root.dispatchEvent(new Event('mouseleave'))
  painter.dispose()
})
