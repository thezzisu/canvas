/** Even JSON's six-byte escapes stay below the socket limit; keep astral scalars whole. */
export function* terminalInputChunks(text: string): Generator<string> {
  const limit = 16 * 1024
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + limit)
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--
    yield text.slice(start, end)
    start = end
  }
}
