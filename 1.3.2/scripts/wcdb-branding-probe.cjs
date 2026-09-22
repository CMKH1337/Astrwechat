'use strict'

// Initialization-only probe: no accounts, keys, database opens, or bridge startup.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads')
const root = path.resolve(__dirname, '..')
const marker = 'WCDB_BRANDING_RESULT='

function nativeProbe(dllDir) {
  const koffi = require('koffi')
  for (const file of ['WCDB.dll', 'SDL2.dll']) koffi.load(path.join(dllDir, file))
  const lib = koffi.load(path.join(dllDir, 'wcdb_api.dll'))
  const initProtection = lib.func('int32 InitProtection(const char* resourcePath)')
  const init = lib.func('int32 wcdb_init()')
  const getLogs = lib.func('int32 wcdb_get_logs(_Out_ void** outJson)')
  const free = lib.func('void wcdb_free_string(void* ptr)')
  const protectionRc = Number(initProtection(dllDir))
  const initRc = Number(init())
  const out = [null]
  let logs = ''
  if (Number(getLogs(out)) === 0 && out[0]) {
    try { logs = String(koffi.decode(out[0], 'char', -1)) } finally { free(out[0]) }
  }
  return { protectionRc, initRc, logs, execPath: process.execPath, isMainThread }
}

async function bundledProbe(dllDir, userData) {
  const workerPath = process.env.WCDB_PROBE_WORKER_PATH || path.join(root, 'dist-electron', 'wcdbWorker.js')
  const worker = new Worker(workerPath, { env: { ...process.env, WCDB_DLL_PATH: path.join(dllDir, 'wcdb_api.dll') } })
  const pending = new Map()
  let nextId = 0
  worker.on('message', message => {
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    clearTimeout(item.timer)
    message.error ? item.reject(new Error(message.error)) : item.resolve(message.result)
  })
  const rejectAll = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
  }
  worker.on('error', rejectAll)
  worker.on('exit', code => rejectAll(new Error(`Worker exited before response: ${code}`)))
  const call = (type, payload = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Worker timeout: ${type}`)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    worker.postMessage({ id, type, payload })
  })
  try {
    await call('setPaths', { resourcesPath: path.dirname(dllDir), userDataPath: userData })
    await call('setLogEnabled', { enabled: false })
    const result = await call('initialize')
    // Preserve the actual worker response; do not fabricate native return codes.
    return { success: result?.success === true, nativeError: result?.error || '', workerPath, execPath: process.execPath }
  } finally { await worker.terminate() }
}

async function electronProbe() {
  const { app } = require('electron')
  const appName = process.env.WCDB_PROBE_APP_NAME || 'AstrWeChat'
  const context = process.env.WCDB_PROBE_CONTEXT || 'main'
  const dllDir = process.env.WCDB_PROBE_DLL_DIR
  const userData = process.env.WCDB_PROBE_USER_DATA
  if (!dllDir || !userData) throw new Error('Isolated DLL and user-data paths are required')
  fs.mkdirSync(userData, { recursive: true })
  app.setName(appName)
  app.setPath('userData', userData)
  app.disableHardwareAcceleration()
  await app.whenReady()
  try {
    let result
    if (context === 'bundled-worker') result = await bundledProbe(dllDir, userData)
    else if (context === 'worker') {
      result = await new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: { dllDir } })
        worker.once('message', resolve)
        worker.once('error', reject)
        worker.once('exit', code => { if (code !== 0) reject(new Error(`Worker exit: ${code}`)) })
      })
    } else result = nativeProbe(dllDir)
    result = { ...result, appName: app.getName(), context, userData: app.getPath('userData') }
    console.log(marker + JSON.stringify(result))
    app.exit((context === 'bundled-worker' ? result.success : result.protectionRc === 0 && result.initRc === 0) ? 0 : 1)
  } catch (error) {
    console.log(marker + JSON.stringify({ error: error.stack || String(error), context, appName }))
    app.exit(2)
  }
}

function runMatrix() {
  if (process.platform !== 'win32') throw new Error('This probe currently tests Windows x64 only')
  const work = path.join(root, 'tmp', 'branding-probe')
  const runtime = path.join(work, process.env.WCDB_PROBE_BRANDED_EXE ? 'packaged-exe-runtime' : 'runtime')
  const source = path.join(root, 'node_modules', 'electron', 'dist')
  if (!fs.existsSync(path.join(runtime, 'electron.exe'))) fs.cpSync(source, runtime, { recursive: true })
  for (const name of ['WeFlow.exe', 'AstrWeChat.exe', 'Unrelated.exe']) {
    if (!fs.existsSync(path.join(runtime, name))) fs.copyFileSync(path.join(runtime, 'electron.exe'), path.join(runtime, name))
  }
  if (process.env.WCDB_PROBE_BRANDED_EXE) fs.copyFileSync(path.resolve(process.env.WCDB_PROBE_BRANDED_EXE), path.join(runtime, 'AstrWeChat.exe'))
  const dllDir = path.resolve(process.env.WCDB_PROBE_DLL_DIR || path.join(root, 'resources', 'wcdb', 'win32', 'x64'))
  const { sha256, SOURCE_SHA256, PATCHED_SHA256 } = require('./wcdb-host-branding.cjs')
  const dllSha256 = sha256(fs.readFileSync(path.join(dllDir, 'wcdb_api.dll')))
  if (![SOURCE_SHA256, PATCHED_SHA256].includes(dllSha256)) throw new Error('Unsupported probe DLL hash')
  const results = []
  const label = process.env.WCDB_PROBE_LABEL || 'baseline'
  if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Invalid probe label')
  for (const exe of ['electron.exe', 'WeFlow.exe', 'AstrWeChat.exe', 'Unrelated.exe']) {
    for (const context of ['main', 'worker', 'bundled-worker']) {
      const env = { ...process.env, WCDB_PROBE_CHILD: '1', WCDB_PROBE_CONTEXT: context, WCDB_PROBE_DLL_DIR: dllDir,
        WCDB_PROBE_USER_DATA: path.join(work, 'profiles', `${label}-${exe}-${context}`) }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawnSync(path.join(runtime, exe), [__filename], {
        cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
      })
      const line = (child.stdout || '').split(/\r?\n/).find(line => line.startsWith(marker))
      const result = { exe, context, exitCode: child.status,
        ...(line ? JSON.parse(line.slice(marker.length)) : { error: child.error?.message || child.stderr || 'No probe result' }) }
      const expectedSuccess = exe === 'electron.exe' || exe === 'WeFlow.exe' || (exe === 'AstrWeChat.exe' && dllSha256 === PATCHED_SHA256)
      const actualSuccess = context === 'bundled-worker' ? result.success === true : result.protectionRc === 0 && result.initRc === 0
      const expectedFailure = context === 'bundled-worker' ? result.success === false && /-1006/.test(result.nativeError || '') : result.protectionRc === 0 && result.initRc === -1006
      result.passed = !result.error && (expectedSuccess ? actualSuccess && child.status === 0 : expectedFailure && child.status === 1)
      results.push(result)
      console.log(JSON.stringify(result))
    }
  }
  const filename = path.join(work, `${label}.json`)
  fs.writeFileSync(filename, JSON.stringify({ dllDir, dllSha256, results }, null, 2) + '\n')
  console.log(`Report: ${filename}`)
  if (results.some(result => !result.passed)) process.exitCode = 2
}

if (!isMainThread) {
  try { parentPort.postMessage(nativeProbe(workerData.dllDir)) } catch (error) { parentPort.postMessage({ error: error.stack || String(error) }) }
} else if (process.versions.electron && process.env.WCDB_PROBE_CHILD === '1') {
  electronProbe().catch(error => { console.error(error); require('electron').app.exit(2) })
} else runMatrix()
