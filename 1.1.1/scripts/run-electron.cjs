'use strict'

const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const env = { ...process.env, NODE_ENV: 'production', WEFLOW_FORCE_PRODUCTION: '1' }
delete env.VITE_DEV_SERVER_URL

function run(executable, args) {
  // Never route absolute executable paths through cmd.exe. A project path such
  // as "C:\Users\name\Desktop\wechat bridge" would otherwise be split at the
  // space and Windows would try to execute only the prefix.
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: false
  })
  if (result.error) {
    console.error(`[electron:run] Unable to start ${executable}: ${result.error.message}`)
    return 1
  }
  return typeof result.status === 'number' ? result.status : 1
}

const prepareRuntime = join(root, 'scripts', 'prepare-electron-runtime.cjs')
const viteCli = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const electron = process.platform === 'win32'
  ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(root, 'node_modules', '.bin', 'electron')
const wcdbDir = join(root, 'resources', 'wcdb', 'win32', 'x64')
const requiredFiles = [
  prepareRuntime,
  viteCli,
  electron,
  ...(process.platform === 'win32'
    ? ['wcdb_api.dll', 'WCDB.dll', 'SDL2.dll'].map((name) => join(wcdbDir, name))
    : [])
]
const missingFiles = requiredFiles.filter((file) => !existsSync(file))
if (missingFiles.length > 0) {
  console.error(`[electron:run] Required project files are missing:\n${missingFiles.join('\n')}`)
  process.exit(1)
}

const runtimeStatus = run(process.execPath, [prepareRuntime])
if (runtimeStatus !== 0) process.exit(runtimeStatus)

const buildStatus = run(process.execPath, [viteCli, 'build'])
if (buildStatus !== 0) process.exit(buildStatus)
if (process.argv.includes('--build-only')) process.exit(0)
// Launch the project root so Electron reads package.json and uses the app's
// name/version metadata instead of treating the Electron runtime as the app.
process.exit(run(electron, ['.']))