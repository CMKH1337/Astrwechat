const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const viteCli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const electronPath = require('electron')
const distElectronDir = path.join(root, 'dist-electron')
const watchedBundles = new Set([
  'main.js',
  'preload.js',
  'wcdbWorker.js',
  'apiMessageWorker.js',
  'imageDecryptWorker.js',
])

let viteProcess = null
let electronProcess = null
let bundleWatcher = null
let launchTimer = null
let restartTimer = null
let devServerUrl = ''
let shuttingDown = false
let restartingElectron = false

function withoutNpmLifecycleEnv(source) {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (/^npm_/i.test(key)) delete env[key]
  }
  delete env.INIT_CWD
  delete env.ELECTRON_STARTUP_PREVENT
  return env
}

function electronEnv() {
  return {
    ...withoutNpmLifecycleEnv(process.env),
    NODE_ENV: 'development',
    VITE_DEV_SERVER_URL: devServerUrl,
  }
}

function spawnElectron() {
  if (shuttingDown || electronProcess || !devServerUrl) return

  console.log('[dev] Electron bundles are stable; starting AstrWeChat...')
  const child = spawn(electronPath, ['.'], {
    cwd: root,
    env: electronEnv(),
    stdio: 'inherit',
    windowsHide: true,
  })
  electronProcess = child

  child.on('exit', (code) => {
    if (electronProcess === child) electronProcess = null
    if (shuttingDown) return
    if (restartingElectron) return
    shutdown(typeof code === 'number' ? code : 0)
  })
}

function restartElectronAfterBundlesSettle() {
  if (shuttingDown || !electronProcess) return
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    const previous = electronProcess
    if (!previous) {
      spawnElectron()
      return
    }

    console.log('[dev] Electron bundle changed; restarting after the WCDB-safe quiet period...')
    restartingElectron = true
    previous.once('exit', () => {
      restartingElectron = false
      if (!shuttingDown) spawnElectron()
    })
    previous.kill()
  }, 5000)
}

function startBundleWatcher() {
  if (bundleWatcher || !fs.existsSync(distElectronDir)) return
  bundleWatcher = fs.watch(distElectronDir, (_eventType, filename) => {
    if (!filename || !watchedBundles.has(String(filename))) return
    restartElectronAfterBundlesSettle()
  })
}

function scheduleInitialElectronLaunch() {
  if (launchTimer || !devServerUrl) return
  // Vite announces the renderer URL before all Electron worker bundles have
  // finished their first write. Seven seconds was verified against the native
  // WCDB runtime and avoids the initialization race that returns -1006.
  launchTimer = setTimeout(() => {
    launchTimer = null
    spawnElectron()
    startBundleWatcher()
  }, 7000)
}

function consumeViteOutput(chunk, target) {
  target.write(chunk)
  const plain = String(chunk).replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
  const match = plain.match(/Local:\s+(https?:\/\/\S+)/i)
  if (!match || devServerUrl) return
  devServerUrl = match[1]
  console.log(`[dev] Renderer ready at ${devServerUrl}; waiting for Electron bundles...`)
  scheduleInitialElectronLaunch()
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  if (launchTimer) clearTimeout(launchTimer)
  if (restartTimer) clearTimeout(restartTimer)
  try { bundleWatcher?.close() } catch {}
  try { electronProcess?.kill() } catch {}
  try { viteProcess?.kill() } catch {}
  setTimeout(() => process.exit(code), 300).unref()
}

const viteEnv = { ...process.env, ELECTRON_STARTUP_PREVENT: '1' }
viteProcess = spawn(process.execPath, [viteCli], {
  cwd: root,
  env: viteEnv,
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: true,
})

viteProcess.stdout.on('data', (chunk) => consumeViteOutput(chunk, process.stdout))
viteProcess.stderr.on('data', (chunk) => consumeViteOutput(chunk, process.stderr))
viteProcess.on('exit', (code) => {
  if (!shuttingDown) shutdown(typeof code === 'number' ? code : 1)
})

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('exit', () => {
  try { electronProcess?.kill() } catch {}
  try { viteProcess?.kill() } catch {}
})
