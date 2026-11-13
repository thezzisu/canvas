import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bracketedPaste,
  filePasteParts,
  renderPasteParts,
  renderPasteSegments,
  type PastePart,
} from './paste.ts'

test('mixed paste keeps text, images, files and repeated references in their original positions', () => {
  const parts: PastePart[] = [
    'Compare **before**\n',
    { file: 0, format: 'markdown', image: true, label: 'before.png' },
    '\nWith ',
    { file: 1, format: 'markdown', label: 'Report.pdf' },
    '\ncat ',
    { file: 1, format: 'path' },
    '\n',
  ]
  const preview = renderPasteParts(parts, ['/uploaded/before.png', '/uploaded/Report.pdf'])
  assert.equal(
    preview,
    "Compare **before**\n![before.png](/uploaded/before.png)\nWith [Report.pdf](/uploaded/Report.pdf)\ncat '/uploaded/Report.pdf'\n",
  )
  assert.equal(
    renderPasteParts(parts, ['/inbox/a_before.png', '/inbox/b_Report.pdf']),
    preview
      .replaceAll('/uploaded/before.png', '/inbox/a_before.png')
      .replaceAll('/uploaded/Report.pdf', '/inbox/b_Report.pdf'),
  )
})

test('Markdown escapes filenames without losing readable Unicode or interpreting destination syntax', () => {
  const filename = "风景 [1] O'Brien (2)%#?.png"
  assert.equal(
    renderPasteParts(
      [{ file: 0, format: 'markdown', image: true, label: filename }],
      [`/uploaded/${filename}`],
    ),
    "![风景 \\[1\\] O'Brien (2)%#?.png](/uploaded/风景%20%5B1%5D%20O%27Brien%20%282%29%25%23%3F.png)",
  )
  assert.equal(
    renderPasteParts([{ file: 0, format: 'markdown', label: '\\_*`<&>\r\nnext' }], ['/a\\b[c]\td']),
    '[\\\\\\_\\*\\`\\<\\&\\> next](/a%5Cb%5Bc%5D%09d)',
  )
  assert.equal(
    renderPasteParts(
      [{ file: 0, format: 'markdown', label: 'copyright' }],
      ['/uploaded/&copy;.txt'],
    ),
    '[copyright](/uploaded/%26copy;.txt)',
  )
})

test('path format quotes apostrophes and keeps filenames literal', () => {
  assert.equal(
    renderPasteParts(['cat ', { file: 0, format: 'path' }], ["/uploaded/O'Brien $price.txt"]),
    "cat '/uploaded/O'\\''Brien $price.txt'",
  )
  assert.throws(
    () => renderPasteParts([{ file: 1, format: 'path' }], ['/file']),
    /Invalid paste file reference/u,
  )
  assert.throws(
    () => renderPasteParts([{ file: 0, format: 'markdown' }], ['/file\0']),
    /Invalid paste file reference/u,
  )
})

test('every attachment is a separate paste segment without changing text or whitespace', () => {
  const parts: PastePart[] = [
    '',
    'Read\n',
    { file: 0, format: 'path' },
    ' then ',
    { file: 1, format: 'markdown', image: true, label: 'after.png' },
    { file: 0, format: 'path' },
    '\n',
    '',
  ]
  const paths = ["/inbox/O'Brien image.png", '/inbox/after.png']
  const segments = renderPasteSegments(parts, paths)
  assert.deepEqual(segments, [
    { text: 'Read\n', file: false },
    { text: "'/inbox/O'\\''Brien image.png'", file: true },
    { text: ' then ', file: false },
    { text: '![after.png](/inbox/after.png)', file: true },
    { text: "'/inbox/O'\\''Brien image.png'", file: true },
    { text: '\n', file: false },
  ])
  assert.equal(segments.map((segment) => segment.text).join(''), renderPasteParts(parts, paths))
})

test('plain file lists keep shell spacing between separate path segments', () => {
  assert.deepEqual(filePasteParts(1), [{ file: 0, format: 'path' }])
  assert.equal(
    renderPasteParts(filePasteParts(3), ['/a b', '/c', "/O'd"]),
    "'/a b' '/c' '/O'\\''d'",
  )
  assert.deepEqual(
    renderPasteSegments(filePasteParts(2), ['/a', '/b']).map((segment) => segment.file),
    [true, false, true],
  )
})

test('note content becomes paste parts with each attachment delivered once', async () => {
  const { noteContentPaste } = await import('./paste.ts')
  const a = '0f8fad5b-d9cb-469f-a165-70867728950e',
    b = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
  const token = (id: string) => `￼${id}￼`
  assert.deepEqual(noteContentPaste(`see ${token(a.toUpperCase())} and ${token(a)}\n`), {
    files: [a],
    parts: ['see ', { file: 0, format: 'path' }, ' and ', { file: 0, format: 'path' }, '\n'],
  })
  assert.deepEqual(noteContentPaste(`${token(a)} \n ${token(b)}`), {
    files: [a, b],
    parts: [{ file: 0, format: 'path' }, ' ', { file: 1, format: 'path' }],
  })
  assert.deepEqual(noteContentPaste('plain'), { files: [], parts: ['plain'] })
})

test('a bracketed paste cannot end itself, however the end marker is nested', () => {
  assert.equal(bracketedPaste('a\nb'), '\x1b[200~a\nb\x1b[201~')
  for (const text of ['x\x1b[201~rm -rf', '\x1b[20\x1b[201~1~y', '\x1b[2\x1b[20\x1b[201~1~01~z']) {
    const body = bracketedPaste(text).slice(6, -6)
    assert.equal(body.includes('\x1b[201~'), false, JSON.stringify(text))
  }
})
