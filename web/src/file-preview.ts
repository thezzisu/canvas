import mimeTypes from 'mime'

export type FilePreview = 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'file'

/** Rendering and codec support belong to the browser. Unknown bytes are tried
 * as bounded plain text; a decoding failure falls back to the original file. */
export function filePreview(file: { filename: string; mime?: string }): FilePreview {
  const registered = mimeTypes.getType(file.filename)
  const mime = registered || file.mime?.split(';')[0] || 'application/octet-stream'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/') || /^application\/(?:json|javascript|xml|yaml|toml|x-sh|x-shellscript|x-httpd-php)$|\+(?:json|xml)$/.test(mime)) return 'text'
  return mime === 'application/octet-stream' && !registered ? 'text' : 'file'
}
