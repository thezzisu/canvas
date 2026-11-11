/** The browser page that sent a write, and the write's position among that page's writes. */
export interface WriteMark {
  page: string
  sequence: number
}
const markPattern = /^([A-Za-z0-9_-]{1,64})\.([1-9]\d{0,14})$/

/** Read a `Canvas-Write` header: `<page>.<sequence>`. */
export function parseWriteMark(header: string | undefined): WriteMark {
  const match = markPattern.exec(header ?? '')
  if (!match) throw new Error('Write order required')
  return { page: match[1]!, sequence: Number(match[2]) }
}

/**
 * A page sends a keepalive copy of a save that may not survive its closing, so two of its writes
 * to one resource can arrive in either order. Each field keeps the newest write of each page;
 * writes of different pages are not ordered against each other.
 *
 * The record matters only while writes of one page cross in flight, so it lives in memory and
 * forgets the resources written longest ago.
 */
export class WriteOrder {
  private readonly applied = new Map<string, Map<string, number>>()
  constructor(private readonly limit = 8192) {}

  /** The fields of `resource` that no newer write of the same page has stored. */
  fresh<Field extends string>(
    mark: WriteMark,
    resource: string,
    fields: readonly Field[],
  ): Field[] {
    const known = this.applied.get(key(mark, resource))
    return fields.filter((field) => (known?.get(field) ?? 0) < mark.sequence)
  }
  /** The write stored these fields. */
  record(mark: WriteMark, resource: string, fields: readonly string[]) {
    const id = key(mark, resource),
      known = this.applied.get(id) ?? new Map<string, number>()
    for (const field of fields) known.set(field, Math.max(known.get(field) ?? 0, mark.sequence))
    this.applied.delete(id)
    this.applied.set(id, known)
    for (const oldest of this.applied.keys()) {
      if (this.applied.size <= this.limit) break
      this.applied.delete(oldest)
    }
  }
}
const key = (mark: WriteMark, resource: string) => `${mark.page} ${resource}`
