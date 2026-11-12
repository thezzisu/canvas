import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { crc32, deflateSync } from 'node:zlib'
import { validateBackground, storedBackgroundContentType } from './backgrounds.ts'
import { createApp } from './app.ts'
import { Store, canvasSchema, type CanvasView } from './state.ts'
import type { TerminalManager } from './terminals.ts'

/** Ordered writes carry their page and sequence number. */
let writes = 0
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-backgrounds-'))
  const path = join(directory, 'canvas.db')
  const account = { username: 'fixture', passwordHash: 'unused' }
  const terminals = {
    closeAll: async () => {},
    closeSource: async () => {},
  } as unknown as TerminalManager
  let store = new Store(path)
  let app = createApp(store, account, terminals)
  store.addSession('fixture-session')
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const canvas = store.put('canvas', canvasSchema.parse({ name: 'First', nodes: [] }))
  const other = store.put('canvas', canvasSchema.parse({ name: 'Second', nodes: [] }))
  const request = (
    route: string,
    method = 'GET',
    body?: string | Uint8Array | ReadableStream<Uint8Array>,
    headers: Record<string, string> = {},
  ) =>
    app.request(`http://localhost${route}`, {
      method,
      headers: {
        Host: 'localhost',
        Origin: 'http://localhost',
        Authorization: 'Bearer fixture-session',
        'Content-Type': 'application/json',
        'Canvas-Write': `test.${++writes}`,
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof Uint8Array ? new Uint8Array(body) : body }),
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    })
  const upload = (
    image: Uint8Array,
    query = '',
    headers: Record<string, string> = {},
    id = canvas.id,
  ) =>
    request(`/api/canvases/${id}/background${query}`, 'PUT', image, {
      'Content-Type': 'image/png',
      ...headers,
    })
  return {
    canvas,
    other,
    request,
    upload,
    get store() {
      return store
    },
    reopen() {
      store.close()
      store = new Store(path)
      app = createApp(store, account, terminals)
    },
  }
}

function pngChunk(name: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(name, 4, 4, 'ascii')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return chunk
}
function png(width = 24, height = 16, compressionLevel = 6): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  const pixels = Buffer.alloc((width + 1) * height, 99)
  for (let row = 0; row < height; row++) pixels[row * (width + 1)] = 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels, { level: compressionLevel })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
const jpegFixture = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIAOiX//2Q==',
  'base64',
)
const webpFixture = Buffer.from(
  'UklGRjIAAABXRUJQVlA4ICYAAACQAQCdASoDAAIAAUAmJZACdLoAA5gA/q4X9XYnwoQT9CjZRL5gAA==',
  'base64',
)

test('concurrent layout edits preserve renames and cannot recreate deleted canvases', async (t) => {
  const f = fixture(t)
  const beginRequest = async (
    route: string,
    method: string,
    data: Uint8Array,
    contentType = 'application/json',
  ) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    })
    const response = f.request(route, method, body, {
      'Content-Type': contentType,
      'Content-Length': String(data.length),
    })
    await setImmediate()
    return {
      response,
      finish() {
        controller.enqueue(data)
        controller.close()
      },
    }
  }
  const route = `/api/canvases/${f.canvas.id}`
  const layout = await beginRequest(route, 'PATCH', Buffer.from('{"nodes":[]}'))
  assert.equal((await f.request(route, 'PATCH', '{"name":"Concurrent rename"}')).status, 200)
  layout.finish()
  assert.equal((await layout.response).status, 200)
  assert.equal(f.store.canvasView(f.store.get('canvas', f.canvas.id)!).name, 'Concurrent rename')

  const upload = await beginRequest(`${route}/background`, 'PUT', await png(), 'image/png')
  const pendingEdit = await beginRequest(route, 'PATCH', Buffer.from('{"name":"Stale edit"}'))
  assert.equal((await f.request(route, 'DELETE', '{}')).status, 200)
  pendingEdit.finish()
  upload.finish()
  assert.equal((await pendingEdit.response).status, 404)
  assert.equal((await upload.response).status, 404)
  assert.equal(f.store.get('canvas', f.canvas.id), undefined)
  assert.equal(
    f.store.db.prepare('SELECT count(*) AS count FROM canvas_backgrounds').get()!.count,
    0,
  )
})

test('backgrounds persist separately, serve authenticated original-format images, and survive canvas edits', async (t) => {
  const f = fixture(t)
  const first = await f.upload(await png(), '?opacity=0.42')
  assert.equal(first.status, 200)
  const created = (await first.json()) as CanvasView
  assert.equal(created.background?.opacity, 0.42)
  assert.deepEqual(created.nodes, [])
  const url = created.background!.url
  const response = await f.request(url)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'image/png')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png())
  assert.equal((await f.request(url, 'GET', undefined, { Authorization: '' })).status, 401)
  assert.equal(
    (
      await f.request(url, 'GET', undefined, {
        Authorization: 'Bearer invalid',
      })
    ).status,
    401,
  )

  const changed = await f.request(
    `/api/canvases/${f.canvas.id}`,
    'PATCH',
    JSON.stringify({ name: 'Renamed', nodes: [] }),
  )
  assert.equal(changed.status, 200)
  assert.deepEqual(((await changed.json()) as CanvasView).background, created.background)
  const injected = await f.request(
    `/api/canvases/${f.other.id}`,
    'PATCH',
    JSON.stringify({ background: created.background }),
  )
  assert.equal(injected.status, 400)
  assert.equal(f.store.canvasView(f.other).background, null)

  f.reopen()
  const state = (await (await f.request('/api/state')).json()) as {
    canvases: CanvasView[]
  }
  assert.equal(state.canvases[0]!.name, 'Renamed')
  assert.deepEqual(state.canvases[0]!.background, created.background)
  assert.equal(state.canvases[1]!.background, null)
  assert.equal((await f.request(url)).status, 200)
})

test('replacement, opacity and deletion affect only the owning canvas', async (t) => {
  const f = fixture(t)
  const image = await png()
  const first = (await (await f.upload(image)).json()) as CanvasView
  assert.equal(first.background?.opacity, 0.35)
  const other = (await (await f.upload(image, '?opacity=0.8', {}, f.other.id)).json()) as CanvasView
  const opacity = await f.request(
    `/api/canvases/${f.canvas.id}/background`,
    'PATCH',
    JSON.stringify({ opacity: 0 }),
  )
  assert.equal(opacity.status, 200)
  assert.deepEqual(((await opacity.json()) as CanvasView).background, {
    ...first.background,
    opacity: 0,
  })
  const second = (await (await f.upload(image)).json()) as CanvasView
  assert.equal(second.background?.opacity, 0)
  assert.notEqual(second.background?.url, first.background?.url)
  assert.equal((await f.request(first.background!.url)).status, 404)
  assert.equal((await f.request(other.background!.url)).status, 200)
  const removed = await f.request(`/api/canvases/${f.canvas.id}/background`, 'DELETE', '{}')
  assert.equal(removed.status, 200)
  assert.equal(((await removed.json()) as CanvasView).background, null)
  assert.equal((await f.request(second.background!.url)).status, 404)
  assert.equal(
    (await f.request(`/api/canvases/${f.canvas.id}/background`, 'PATCH', '{"opacity":0.5}')).status,
    404,
  )
  assert.equal((await f.request(other.background!.url)).status, 200)
  await f.request(`/api/canvases/${f.other.id}`, 'DELETE', '{}')
  assert.equal((await f.request(other.background!.url)).status, 404)
  assert.equal(
    f.store.db.prepare('SELECT count(*) AS count FROM canvas_backgrounds').get()!.count,
    0,
  )
})

test('invalid changes leave the previous background intact', async (t) => {
  const f = fixture(t)
  const image = await png()
  const original = (await (await f.upload(image, '?opacity=0.6')).json()) as CanvasView
  const invalid: Array<[Uint8Array, string, Record<string, string>, number]> = [
    [
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      '',
      { 'Content-Type': 'image/svg+xml' },
      415,
    ],
    [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), '', {}, 400],
    [Buffer.from('not an image'), '', {}, 400],
    [Buffer.alloc(0), '', {}, 400],
    [image.subarray(0, 4), '', {}, 400],
    [image, '', { 'Content-Type': 'image/jpeg' }, 400],
    [image, '?opacity=1.01', {}, 400],
    [image, '?opacity=NaN', {}, 400],
    [image, '?opacity=', {}, 400],
    [image, '', { Origin: 'https://other.example' }, 403],
    [image, '', { Origin: 'invalid-origin' }, 403],
    [image, '', { Authorization: '' }, 401],
  ]
  for (const [input, query, headers, status] of invalid)
    assert.equal((await f.upload(input, query, headers)).status, status)
  for (const opacity of [-1, 2, '0.3', null])
    assert.equal(
      (
        await f.request(
          `/api/canvases/${f.canvas.id}/background`,
          'PATCH',
          JSON.stringify({ opacity }),
        )
      ).status,
      400,
    )
  assert.deepEqual(f.store.canvasView(f.canvas).background, original.background)
  assert.equal((await f.request(original.background!.url)).status, 200)
  assert.equal(
    f.store.db.prepare('SELECT count(*) AS count FROM canvas_backgrounds').get()!.count,
    1,
  )
})

test('background uploads bypass the JSON body limit while ordinary API bodies remain bounded', async (t) => {
  const f = fixture(t)
  const image = png(1100, 1000, 0)
  assert.ok(image.length > 1024 * 1024)
  const uploaded = await f.upload(image, '', {
    'Content-Length': String(image.length),
  })
  assert.equal(uploaded.status, 200)
  const saved = (await uploaded.json()) as CanvasView
  const response = await f.request(saved.background!.url)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image)
  assert.equal(
    (
      await f.request(
        `/api/canvases/${f.canvas.id}`,
        'PATCH',
        JSON.stringify({ name: 'x'.repeat(1024 * 1024) }),
      )
    ).status,
    413,
  )
  assert.equal(
    (
      await f.request(`/api/canvases/${f.canvas.id}`, 'PUT', image, {
        'Content-Type': 'image/png',
      })
    ).status,
    415,
  )
  assert.deepEqual(f.store.canvasView(f.canvas).background, saved.background)
})

test('JPEG and WebP backgrounds are served unchanged; overview backgrounds persist', async (t) => {
  const f = fixture(t)
  const uploaded = await f.upload(jpegFixture, '', { 'Content-Type': 'image/jpeg' })
  assert.equal(uploaded.status, 200)
  const canvas = (await uploaded.json()) as CanvasView
  const response = await f.request(canvas.background!.url)
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpegFixture)
  const webp = await f.upload(webpFixture, '?opacity=1', { 'Content-Type': 'image/webp' })
  assert.equal(webp.status, 200)
  const webpCanvas = (await webp.json()) as CanvasView
  const webpResponse = await f.request(webpCanvas.background!.url)
  assert.equal(webpResponse.headers.get('Content-Type'), 'image/webp')
  assert.deepEqual(Buffer.from(await webpResponse.arrayBuffer()), webpFixture)
  const overview = await f.upload(await png(), '?opacity=0.5', {}, 'overview')
  assert.equal(overview.status, 200)
  const overviewCanvas = (await overview.json()) as CanvasView
  assert.equal(overviewCanvas.id, 'overview')
  const state = (await (await f.request('/api/state')).json()) as {
    canvases: CanvasView[]
    overviewBackground: CanvasView['background']
  }
  assert.equal(state.canvases.length, 2)
  assert.deepEqual(state.overviewBackground, overviewCanvas.background)
  // The working set keeps a background of its own and stays out of the canvas list.
  const workingSet = await f.upload(await png(), '?opacity=0.3', {}, 'working-set')
  assert.equal(workingSet.status, 200)
  const workingSetBackground = ((await workingSet.json()) as CanvasView).background
  assert.notEqual(workingSetBackground?.url, overviewCanvas.background?.url)
  assert.deepEqual(f.store.snapshot().workingSetBackground, workingSetBackground)
  assert.deepEqual(f.store.snapshot().overviewBackground, overviewCanvas.background)
  assert.equal(f.store.snapshot().canvases.length, 2)
  assert.equal(
    (await f.request('/api/canvases/working-set', 'PATCH', '{"name":"Changed"}')).status,
    403,
  )
  f.reopen()
  assert.deepEqual(f.store.snapshot().overviewBackground, overviewCanvas.background)
  assert.equal(
    (await f.request('/api/canvases/overview/background', 'PATCH', '{"opacity":0.2}')).status,
    200,
  )
  assert.equal(f.store.snapshot().overviewBackground?.opacity, 0.2)
  assert.equal((await f.request('/api/canvases/overview/background', 'DELETE', '{}')).status, 200)
  assert.equal(f.store.snapshot().overviewBackground, null)
  assert.equal(
    (await f.request('/api/canvases/overview', 'PATCH', '{"name":"Changed"}')).status,
    403,
  )
  assert.equal((await f.request('/api/canvases/overview', 'DELETE', '{}')).status, 403)
  assert.equal(
    (
      await f.request(
        '/api/canvases',
        'POST',
        JSON.stringify({ id: 'overview', name: 'Fake overview', nodes: [] }),
      )
    ).status,
    400,
  )
})

test('background validation checks MIME signatures without decoding or rewriting image data', () => {
  for (const [bytes, mime] of [
    [png(), 'image/png'],
    [jpegFixture, 'image/jpeg'],
    [webpFixture, 'image/webp'],
  ] as const) {
    assert.equal(storedBackgroundContentType(bytes), mime)
    assert.doesNotThrow(() => validateBackground(bytes, mime))
  }
  assert.throws(() => validateBackground(jpegFixture, 'image/png'), /do not match/)
  assert.throws(() => validateBackground(Buffer.from('not an image'), 'image/png'))
  assert.throws(() => storedBackgroundContentType(Buffer.alloc(0)))
})
