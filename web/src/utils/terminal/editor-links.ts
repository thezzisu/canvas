import { sanitizeEditorAuthority } from '../../../../shared/editor-target.ts'

/** Opening an external editor is browser presentation, not a backend command. */
export function vscodeDirectoryUri(authority: unknown, path: string): string {
  if (
    !path.startsWith('/') ||
    new TextEncoder().encode(path).length > 8192 ||
    /[\x00-\x1f\x7f]/u.test(path)
  )
    throw new Error('Invalid directory path')
  const destination = sanitizeEditorAuthority(authority)
  const remote = Array.from(new TextEncoder().encode(JSON.stringify(destination)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  const encodedPath = path
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/gu,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/')
  return `vscode://vscode-remote/ssh-remote+${remote}${encodedPath}`
}
