const { parentPort } = require('worker_threads')
const koffi = require('koffi')
const path = require('path')

const root = path.resolve(__dirname, '..')
const dllDir = path.join(root, 'resources', 'wcdb', 'win32', 'x64')
try {
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
  parentPort.postMessage({
    ok: initProtectionRc === 0 && wcdbInitRc === 0,
    initProtection: initProtectionRc,
    wcdbInit: wcdbInitRc,
    nativeLogs,
    identity: {
      context: 'worker', processTitle: process.title, execPath: process.execPath,
      arch: process.arch, electron: process.versions.electron || '', node: process.versions.node || '',
    },
  })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.stack || String(error) })
}
