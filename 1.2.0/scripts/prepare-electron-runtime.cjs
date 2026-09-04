'use strict'

const fs = require('node:fs')
const path = require('node:path')

const runtimeNames = [
  'msvcp140.dll',
  'msvcp140_1.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
]

function filesAreEqual(sourcePath, targetPath) {
  if (!fs.existsSync(targetPath)) return false
  const source = fs.statSync(sourcePath)
  const target = fs.statSync(targetPath)
  if (source.size !== target.size) return false
  return fs.readFileSync(sourcePath).equals(fs.readFileSync(targetPath))
}

function copyIfDifferent(sourcePath, targetPath) {
  if (filesAreEqual(sourcePath, targetPath)) return false
  fs.copyFileSync(sourcePath, targetPath)
  return true
}

function main() {
  if (process.platform !== 'win32') return

  const projectRoot = path.resolve(__dirname, '..')
  const sourceDir = path.join(projectRoot, 'resources', 'runtime', 'win32')
  const targetDir = path.join(projectRoot, 'node_modules', 'electron', 'dist')

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`VC++ runtime source directory is missing: ${sourceDir}`)
  }
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Electron runtime directory is missing: ${targetDir}`)
  }

  let copiedCount = 0
  for (const name of runtimeNames) {
    const sourcePath = path.join(sourceDir, name)
    const targetPath = path.join(targetDir, name)
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Required VC++ runtime DLL is missing: ${sourcePath}`)
    }
    if (copyIfDifferent(sourcePath, targetPath)) copiedCount += 1
    if (!filesAreEqual(sourcePath, targetPath)) {
      throw new Error(`Failed to verify VC++ runtime DLL: ${targetPath}`)
    }
  }

  const action = copiedCount > 0 ? `synced ${copiedCount}` : 'verified 4'
  console.log(`[prepare-electron-runtime] ${action} runtime DLL(s) in ${targetDir}`)
}

try {
  main()
} catch (error) {
  console.error(`[prepare-electron-runtime] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}