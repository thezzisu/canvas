export async function readStateEvents(stream: ReadableStream<Uint8Array>, receive: (event: string, data: string) => void) {
  const reader = stream.getReader(), decoder = new TextDecoder()
  let buffer = '', event = '', data: string[] = []
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1)
        if (!line) { if (data.length) receive(event || 'message', data.join('\n')); event = ''; data = [] }
        else if (line.startsWith('event:')) event = line.slice(6).trimStart()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (buffer.length > 8 * 1024 * 1024) throw new Error('State stream frame is too large')
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
