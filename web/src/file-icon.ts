export type FileIconManifest = {
  file: string
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
}

/** Match Material Icon Theme file associations case-insensitively: exact name, then the longest extension, then the default icon. */
export function fileIconResolver({ file, fileNames, fileExtensions }: FileIconManifest) {
  const lower = (map: Record<string, string>) =>
    new Map(Object.entries(map).map(([key, icon]) => [key.toLowerCase(), icon]))
  const names = lower(fileNames),
    extensions = lower(fileExtensions)
  return (filename: string) => {
    const name = filename.slice(filename.lastIndexOf('/') + 1).toLowerCase()
    const icon = names.get(name)
    if (icon) return icon
    for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
      const icon = extensions.get(name.slice(dot + 1))
      if (icon) return icon
    }
    return file
  }
}
