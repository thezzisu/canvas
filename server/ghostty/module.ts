import { readFileSync } from 'node:fs'

// libghostty-vt as one WebAssembly instance. Every terminal lives in its linear memory, which
// only grows, so whatever is created here is freed through the library again.
//
// Struct layouts, bit positions and enum values come from the module's own manifest
// (`ghostty_type_json`), never from numbers written here: the C ABI is stable, the packed cell
// layout is not.

type Fn = (...args: number[]) => number
interface Field {
  offset: number
  size: number
}
interface Bits {
  lsb: number
  width: number
}
interface TypeInfo {
  size: number
  fields: Record<string, Field>
  values: Record<string, number>
  bits: Record<string, Bits>
}
export type Pointer = number

const utf8 = new TextDecoder()
const utf8Encoder = new TextEncoder()

/** A JS function as a wasm function pointer taking `params` i32 and returning nothing. */
function callback(table: WebAssembly.Table, params: number, fn: (...args: number[]) => void) {
  // (module (import "e" "f" (func (param i32 × params))) (export "f" (func 0)))
  const bytes = Uint8Array.of(
    ...[0, 97, 115, 109, 1, 0, 0, 0],
    ...[1, 4 + params, 1, 0x60, params, ...Array<number>(params).fill(0x7f), 0],
    ...[2, 7, 1, 1, 0x65, 1, 0x66, 0, 0],
    ...[7, 5, 1, 1, 0x66, 0, 0],
  )
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { f: fn } })
  const index = table.grow(1)
  table.set(index, instance.exports.f)
  return index
}

export class GhosttyModule {
  readonly x: Record<string, Fn>
  readonly table: WebAssembly.Table
  private readonly memory: WebAssembly.Memory
  private readonly types: Record<string, TypeInfo>
  private readonly slot: Pointer
  /** Scratch for one out-parameter or small struct; valid until the next call that uses it. */
  readonly out: Pointer
  /** A second scratch, for calls that take two. */
  readonly out2: Pointer
  private io = { ptr: 0, capacity: 0 }

  constructor(wasm: BufferSource) {
    const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), {})
    const exports = instance.exports as Record<string, unknown>
    this.x = exports as Record<string, Fn>
    this.memory = exports.memory as WebAssembly.Memory
    this.table = exports.__indirect_function_table as WebAssembly.Table
    this.types = (JSON.parse(this.cstring(this.x.ghostty_type_json!())) as { types: never }).types
    this.slot = this.x.ghostty_wasm_alloc_opaque!()
    this.out = this.alloc(256)
    this.out2 = this.out + 128
  }

  // Growing memory replaces the buffer, so views are made per use and never kept.
  get view() {
    return new DataView(this.memory.buffer)
  }
  get bytes() {
    return new Uint8Array(this.memory.buffer)
  }
  get memoryBytes() {
    return this.memory.buffer.byteLength
  }

  private type(name: string): TypeInfo {
    const type = this.types[name]
    if (!type) throw new Error(`libghostty-vt has no type ${name}`)
    return type
  }
  size(type: string) {
    return this.type(type).size
  }
  offset(type: string, field: string) {
    const value = this.type(type).fields[field]
    if (!value) throw new Error(`libghostty-vt has no field ${type}.${field}`)
    return value.offset
  }
  value(type: string, name: string) {
    const value = this.type(type).values[name]
    if (value === undefined) throw new Error(`libghostty-vt has no value ${type}.${name}`)
    return value
  }
  bits(type: string, name: string) {
    const value = this.type(type).bits[name]
    if (!value) throw new Error(`libghostty-vt has no bit field ${type}.${name}`)
    return value
  }

  /** Throws unless the result is success or the one result the caller handles. */
  check(result: number, allowed = 0) {
    if (result !== 0 && result !== allowed) {
      const name = Object.entries(this.type('GhosttyResult').values).find(
        ([, value]) => value === result,
      )?.[0]
      throw new Error(`libghostty-vt: ${name ?? result}`)
    }
    return result
  }
  alloc(length: number): Pointer {
    const ptr = this.x.ghostty_wasm_alloc!(length)
    if (!ptr) throw new Error('libghostty-vt: out of memory')
    return ptr
  }
  /** Runs a constructor that returns its handle through an out-parameter. */
  handle(create: (slot: Pointer) => number): Pointer {
    this.check(create(this.slot))
    return this.x.ghostty_wasm_take_opaque!(this.slot)
  }
  /** A zeroed sized struct with its size field set. */
  sized(ptr: Pointer, type: string): Pointer {
    this.x.ghostty_sized_init!(ptr, this.size(type))
    return ptr
  }
  callback(params: number, fn: (...args: number[]) => void) {
    return callback(this.table, params, fn)
  }

  cstring(ptr: Pointer) {
    const bytes = this.bytes
    return utf8.decode(bytes.subarray(ptr, bytes.indexOf(0, ptr)))
  }
  /** A GhosttyString (pointer, length) as bytes copied out of the module. */
  stringBytes(at: Pointer) {
    const view = this.view,
      ptr = view.getUint32(at, true)
    return this.bytes.slice(ptr, ptr + view.getUint32(at + 4, true))
  }
  string(at: Pointer) {
    return utf8.decode(this.stringBytes(at))
  }

  /** Copies bytes, or text as UTF-8, to the start of the I/O buffer and returns their length. */
  put(data: Uint8Array | string): number {
    if (typeof data === 'string') {
      // Three bytes hold any UTF-16 code unit.
      this.reserve(data.length * 3)
      return utf8Encoder.encodeInto(
        data,
        this.bytes.subarray(this.io.ptr, this.io.ptr + this.io.capacity),
      ).written
    }
    this.reserve(data.length)
    this.bytes.set(data, this.io.ptr)
    return data.length
  }
  get ioPointer() {
    return this.io.ptr
  }
  private reserve(length: number, keep = 0) {
    if (length <= this.io.capacity) return
    const capacity = Math.max(length, 65536),
      ptr = this.alloc(capacity)
    if (keep) this.bytes.copyWithin(ptr, this.io.ptr, this.io.ptr + keep)
    if (this.io.ptr) this.x.ghostty_wasm_free!(this.io.ptr, this.io.capacity)
    this.io = { ptr, capacity }
  }
  /**
   * Runs an encoder writing into the I/O buffer behind its first `skip` bytes and returns what it
   * wrote, or nothing when that is longer than `limit`. An encoder that asks for more room gets
   * it once: the second call has exactly what the first one asked for.
   */
  encode(
    skip: number,
    limit: number,
    call: (buffer: Pointer, capacity: number, written: Pointer) => number,
  ): Uint8Array | undefined {
    const outOfSpace = this.value('GhosttyResult', 'OUT_OF_SPACE'),
      written = this.out2 + 120
    this.reserve(skip + 64, skip)
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = this.check(
        call(this.io.ptr + skip, this.io.capacity - skip, written),
        outOfSpace,
      )
      const length = this.view.getUint32(written, true)
      if (length > limit) return
      if (result === 0) return this.bytes.slice(this.io.ptr + skip, this.io.ptr + skip + length)
      this.reserve(skip + length, skip)
    }
    throw new Error('libghostty-vt: an encoder asked for more room twice')
  }
}

let loaded: GhosttyModule | undefined
/** The one module, instantiated on first use. */
export function ghostty(): GhosttyModule {
  return (loaded ??= new GhosttyModule(readFileSync(new URL('./ghostty-vt.wasm', import.meta.url))))
}

/** No cluster a terminal shows is longer; text past this many code points is not measured. */
const MAX_WIDTH_CODEPOINTS = 64
const widths = new Map<string, number>()
/** The cells a grapheme cluster takes, by the rules the terminal itself prints with. */
export function cellWidth(text: string): number {
  if (text.length === 1 && text.charCodeAt(0) < 0x300) return 1
  // Symbols come from remote screens: neither the work nor the cache grows with their length.
  const cached = text.length <= MAX_WIDTH_CODEPOINTS * 2
  let cells = cached ? widths.get(text) : undefined
  if (cells !== undefined) return cells
  const g = ghostty(),
    codepoints = new Uint32Array(MAX_WIDTH_CODEPOINTS)
  let length = 0
  for (const character of text) {
    if (length === MAX_WIDTH_CODEPOINTS) break
    codepoints[length++] = character.codePointAt(0)!
  }
  g.put(new Uint8Array(codepoints.buffer, 0, length * 4))
  cells = 0
  for (let at = 0; at < length;) {
    const used = g.x.ghostty_unicode_grapheme_width!(g.ioPointer + at * 4, length - at, g.out)
    // The library consumes at least one code point; anything else would never end here.
    if (used < 1) break
    at += used
    cells += g.bytes[g.out]!
  }
  if (cached) {
    if (widths.size >= 4096) widths.clear()
    widths.set(text, cells)
  }
  return cells
}
