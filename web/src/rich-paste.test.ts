import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRichPaste, captureRichPaste, type RichPaste } from './rich-paste.ts'
import { renderPasteParts } from '../../shared/paste.ts'

function example(): RichPaste {
  const image = new File(['image'], '示意 图.png', { type: 'image/png' })
  const document = new File(['document'], "owner's notes.pdf", { type: 'application/pdf' })
  return {
    markdown: ['**Before**\n\n', { attachment: 0 }, '\n\nDetails: ', { attachment: 1 }, '\n\nAfter'],
    plain: ['Before\n\n', { attachment: 0 }, '\n\nDetails: ', { attachment: 1 }, '\n\nAfter'],
    attachments: [
      { name: image.name, file: image, image: true, label: 'Diagram [A]' },
      { name: document.name, file: document, image: false, label: document.name },
    ],
  }
}

test('rich paste preview uses the exact insertion format with original-name placeholder paths', () => {
  const model = example()
  const built = buildRichPaste(model, { text: 'markdown', attachments: 'markdown' })
  assert.equal(built.missing, false)
  assert.equal(built.files.length, 2)
  assert.equal(built.preview, renderPasteParts(built.parts, built.files.map(file => `/uploaded/${file.name}`)))
  assert.match(built.preview, /!\[Diagram \\\[A\\\]\]\(\/uploaded\/示意%20图\.png\)/u)
  assert.match(built.preview, /\[owner's notes\.pdf\]\(\/uploaded\/owner%27s%20notes\.pdf\)/u)
  assert.equal(built.preview.at(-1), 'r')
})

test('plain text mode uses quoted paths even if Markdown attachment formatting was selected before it', () => {
  const built = buildRichPaste(example(), { text: 'plain', attachments: 'markdown' })
  assert.equal(built.preview, "Before\n\n'/uploaded/示意 图.png'\n\nDetails: '/uploaded/owner'\\''s notes.pdf'\n\nAfter")
  assert(built.parts.filter(part => typeof part !== 'string').every(part => part.format === 'path'))
})

test('skipping attachments requires no files and preserves text order without adding count text', () => {
  const model = example()
  model.attachments[0]!.file = undefined
  model.unresolved = true
  const built = buildRichPaste(model, { text: 'markdown', attachments: 'skip' })
  assert.equal(built.missing, false)
  assert.deepEqual(built.files, [])
  assert.equal(built.preview, '**Before**\n\n\n\nDetails: \n\nAfter')
  assert.deepEqual(built.parts, [built.preview])
})

test('unreadable and ambiguous references block attachment confirmation while keeping preview placeholders', () => {
  const model = example()
  model.attachments[0]!.file = undefined
  const built = buildRichPaste(model, { text: 'plain', attachments: 'path' })
  assert.equal(built.missing, true)
  assert.match(built.preview, /\/uploaded\/示意 图\.png/u)
  assert.equal(built.files.length, 1)
  const ambiguous = buildRichPaste({ ...example(), unresolved: true }, { text: 'markdown', attachments: 'path' })
  assert.equal(ambiguous.missing, true)
})

test('repeated attachment references share one upload while keeping all text positions', () => {
  const file = new File(['image'], 'one.png', { type: 'image/png' })
  const model: RichPaste = {
    markdown: ['First ', { attachment: 0 }, '; second ', { attachment: 1 }], plain: [],
    attachments: [
      { name: file.name, file, image: true, label: 'first' },
      { name: file.name, file, image: true, label: 'second' },
    ],
  }
  const built = buildRichPaste(model, { text: 'markdown', attachments: 'markdown' })
  assert.deepEqual(built.files, [file])
  assert.deepEqual(built.parts.filter(part => typeof part !== 'string').map(part => part.file), [0, 0])
  assert.equal(built.preview, 'First ![first](/uploaded/one.png); second ![second](/uploaded/one.png)')
})

test('terminal controls cannot escape the rich paste payload', () => {
  const model = example()
  model.markdown[0] = '\u001b[201~\u0000safe\ttext\n'
  model.attachments[0]!.label = 'image\u001b[201~'
  const built = buildRichPaste(model, { text: 'markdown', attachments: 'markdown' })
  assert.doesNotMatch(built.preview, /[\u001b\u0000]/u)
  assert.match(built.preview, /safe\ttext\n/u)
  assert.doesNotMatch(renderPasteParts(built.parts, built.files.map(file => file.name)), /[\u001b\u0000]/u)
})

test('mixed text with an unreadable file offers a blocked preview and a text-only Skip', () => {
  const transfer = {
    getData: (type: string) => type === 'text/plain' ? 'Review this attachment' : '',
    files: [], items: [{ kind: 'file', getAsFile: () => null }], types: ['Files', 'text/plain'],
  } as unknown as DataTransfer
  const model = captureRichPaste(transfer)
  assert(model)
  const paths = buildRichPaste(model, { text: 'plain', attachments: 'path' })
  assert.equal(paths.missing, true)
  assert.equal(paths.preview, "Review this attachment\n\n'/uploaded/file'")
  assert.deepEqual(paths.files, [])
  const skipped = buildRichPaste(model, { text: 'plain', attachments: 'skip' })
  assert.equal(skipped.missing, false)
  assert.equal(skipped.preview, 'Review this attachment')
  assert.deepEqual(skipped.files, [])
})

test('mixed folder selections remain rejected and unreadable files alone stay on the direct path', () => {
  const folder = {
    getData: (type: string) => type === 'text/plain' ? 'Text with folder' : '',
    files: [], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }], types: ['Files', 'text/plain'],
  } as unknown as DataTransfer
  assert.equal(captureRichPaste(folder), undefined)
  const unreadable = {
    getData: () => '', files: [], items: [{ kind: 'file', getAsFile: () => null }], types: ['Files'],
  } as unknown as DataTransfer
  assert.equal(captureRichPaste(unreadable), undefined)
})

test('Skip omits attachment separators without trimming original plain-text line breaks', () => {
  const file = new File(['attachment'], 'file.txt')
  const original = 'Original text\n\n'
  const transfer = {
    getData: (type: string) => type === 'text/plain' ? original : '',
    files: [file], items: [], types: ['Files', 'text/plain'],
  } as unknown as DataTransfer
  const model = captureRichPaste(transfer)
  assert(model)
  assert.equal(buildRichPaste(model, { text: 'plain', attachments: 'skip' }).preview, original)
  assert.equal(buildRichPaste(model, { text: 'plain', attachments: 'path' }).preview, `${original}\n\n'/uploaded/file.txt'`)
})
