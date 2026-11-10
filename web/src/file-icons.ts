// Material Icon Theme manifest and SVGs (MIT); see ../public/licenses/Material-Icon-Theme.txt.
import { file, fileExtensions, fileNames, iconDefinitions } from 'material-icon-theme/dist/material-icons.json'
import { fileIconResolver } from './file-icon'

const icons = '../../node_modules/material-icon-theme/icons/'
const urls = import.meta.glob<string>([
  '../../node_modules/material-icon-theme/icons/*.svg',
  '!../../node_modules/material-icon-theme/icons/folder*.svg',
  '!../../node_modules/material-icon-theme/icons/*_light.*',
], { query: '?url&no-inline', import: 'default', eager: true })
const definitions: Record<string, { iconPath: string }> = iconDefinitions
const resolve = fileIconResolver({ file, fileExtensions, fileNames })

export function fileIconUrl(filename: string) {
  const path = definitions[resolve(filename)].iconPath
  return urls[icons + path.slice(path.lastIndexOf('/') + 1)]
}
