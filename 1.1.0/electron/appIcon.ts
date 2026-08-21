import { app } from 'electron'
import { existsSync } from 'fs'
import { dirname, join } from 'path'

const getPlatformIconName = (): string => {
  if (process.platform === 'linux') return 'icon.png'
  if (process.platform === 'darwin') return 'icon.icns'
  return 'icon.ico'
}

export const resolveAppIconPath = (): string => {
  const iconName = getPlatformIconName()
  const appPath = app.getAppPath()
  const roots = [appPath, dirname(appPath), process.cwd(), dirname(__dirname)]
  const candidates = [
    join(process.resourcesPath, iconName),
    ...roots.map((root) => join(root, 'public', iconName)),
    ...roots.map((root) => join(root, 'resources', 'icons', 'macos', iconName)),
    join(__dirname, '../public', iconName),
    join(__dirname, '../resources/icons/macos', iconName)
  ]
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0]
}
