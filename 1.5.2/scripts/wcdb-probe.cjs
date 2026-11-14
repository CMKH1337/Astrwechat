const { app } = require('electron')
const { Worker } = require('worker_threads')
const koffi = require('koffi')
const path = require('path')

const root = path.resolve(__dirname, '..')
const dllDir = path.join(root, 'resources', 'wcdb', 'win32', 'x64')
const context = process.env.PROBE_CONTEXT || 'main'
app.setName('WeFlow')
try { app.setPath('userData', path.join(app.getPath('appData'), 'weflow')) } catch { }

function executeNative() {
  for (const name of ['WCDB.dll', 'SDL2.dll']) koffi.load(path.join(dllDir, name))
  const lib = koffi.load(path.join(dllDir, 'wcdb_api.dll'))
  const initProtection = lib.func('int32 InitProtection(const char* resourcePath)')
  const wcdbInit = lib.func('int32 wcdb_init()')
  const getLogs = lib.func('int32 wcdb_get_logs(_Out_ void** outJson)')
  const freeString = lib.func('void wcdb_free_string(void* ptr)')
  const initProtectionRc = Number(initProtection(dllDir))
  const wcdbInitRc = Number(wcdbInit())
  const out = [null]
  let nativeLogs = ''
  if (Number(getLogs(out)) === 0 && out[0]) {
    try { nativeLogs = String(koffi.decode(out[0], 'char', -1)) } finally { freeString(out[0]) }
  }
  return {
    ok: initProtectionRc === 0 && wcdbInitRc === 0,
    initProtection: initProtectionRc,
    wcdbInit: wcdbInitRc,
    nativeLogs,
    identity: {
      context,
      appName: app.getName(),
      processTitle: process.title,
      execPath: process.execPath,
      arch: process.arch,
      electron: process.versions.electron || '',
      node: process.versions.node || '',
      isMainThread: context === 'main',
      argv: process.argv,
    },
  }
}

function finish(payload, exitCode = payload.ok ? 0 : 1) {
  console.log(JSON.stringify(payload))
  app.exit(exitCode)
}

async function executeBundledWorker() {
  const workerPath = path.join(root, 'dist-electron', 'wcdbWorker.js')
  const worker = new Worker(workerPath)
  let messageId = 0
  const pending = new Map()
  worker.on('message', (message) => {
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error))
    else waiter.resolve(message.result)
  })
  const call = (type, payload = {}) => new Promise((resolve, reject) => {
    const id = ++messageId
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, type, payload })
  })
  try {
    await call('setPaths', { resourcesPath: path.join(root, 'resources'), userDataPath: app.getPath('userData') })
    await call('setLogEnabled', { enabled: false })
    const result = await call('initialize')
    return {
      ok: result?.success === true,
      initProtection: result?.success === true ? 0 : null,
      wcdbInit: result?.success === true ? 0 : -1006,
      nativeLogs: result?.error || '',
      identity: { context: 'bundled-worker', workerPath, arch: process.arch, electron: process.versions.electron || '' },
    }
  } finally {
    await worker.terminate()
  }
}

app.whenReady().then(async () => {
  if (context === 'worker') {
    const worker = new Worker(path.join(__dirname, 'wcdb-probe-worker.cjs'))
    worker.once('message', (payload) => finish(payload))
    worker.once('error', (error) => finish({ ok: false, error: error.stack || String(error) }, 2))
    return
  }
  try {
    if (context === 'bundled-worker') finish(await executeBundledWorker())
    else finish(executeNative())
  } catch (error) {
    finish({ ok: false, error: error.stack || String(error) }, 2)
  }
})
