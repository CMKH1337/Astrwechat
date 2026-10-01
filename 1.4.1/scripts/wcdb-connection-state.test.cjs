'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const ts = require('typescript')
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText
function fixture() {
  const workers = []
  class FakeWorker extends EventEmitter {
    messages = []
    constructor() { super(); workers.push(this) }
    postMessage(message) {
      if (this.throwOnPost) throw new Error('post failed')
      this.messages.push(message)
      if (['setPaths', 'setLogEnabled', 'setMonitor'].includes(message.type)) {
        queueMicrotask(() => this.emit('message', { id: message.id, result: { success: true }, connected: false }))
      }
    }
    respond(type, result, connected, error) {
      const request = this.messages.find(message => message.type === type && !message.replied)
      assert.ok(request, `Missing request: ${type}`)
      request.replied = true
      this.emit('message', { id: request.id, result, connected, error })
    }
    async terminate() { this.emit('exit', 0); return 0 }
  }
  const filename = path.join(__dirname, '../electron/services/wcdbService.ts')
  const module = { exports: {} }
  new Function('require', 'module', 'exports', '__dirname', compile(fs.readFileSync(filename, 'utf8')))(
    name => name === 'worker_threads' ? { Worker: FakeWorker } : require(name), module, module.exports, path.dirname(filename))
  return { service: new module.exports.WcdbService(), workers }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
async function open(f, account = 'account-A') {
  const opening = f.service.open(account, 'fixture-key')
  await tick()
  f.workers.at(-1).respond('open', true, true)
  assert.equal(await opening, true)
}
async function immediateState(service) {
  let timer
  try {
    return await Promise.race([service.isConnected(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Connection status waited behind the busy query queue')), 100)
    })])
  } finally { clearTimeout(timer) }
}
test('confirmed connection status does not queue behind a native session query', async () => {
  const f = fixture(); await open(f)
  const query = f.service.getSessions()
  const worker = f.workers[0], count = worker.messages.length
  assert.equal(await immediateState(f.service), true)
  assert.equal(worker.messages.length, count)
  worker.respond('getSessions', { success: true, sessions: [] }, true)
  await query
})

test('unconnected status does not create a worker or infer success from settings', async () => {
  const f = fixture()
  assert.equal(await immediateState(f.service), false)
  assert.equal(f.workers.length, 0)
})
test('initialize alone is not a connected database', async () => {
  const f = fixture(), init = f.service.initialize()
  await tick(); f.workers[0].respond('initialize', { success: true }, false)
  await init
  assert.equal(await immediateState(f.service), false)
})
test('open remains disconnected until the worker confirms the handle', async () => {
  const f = fixture(), opening = f.service.open('account-A', 'fixture-key')
  assert.equal(await immediateState(f.service), false)
  await tick(); f.workers[0].respond('open', true, true)
  await opening
  assert.equal(await immediateState(f.service), true)
})
test('close invalidates status immediately even while its reply is blocked', async () => {
  const f = fixture(); await open(f)
  const closing = f.service.close()
  assert.equal(await immediateState(f.service), false)
  await tick(); f.workers[0].respond('close', undefined, false); await closing
  assert.equal(await immediateState(f.service), false)
})
test('same-account warmup reuses a confirmed connection without enqueueing open', async () => {
  const f = fixture(); await open(f)
  const query = f.service.getSessions(), count = f.workers[0].messages.length
  assert.equal(await f.service.open('account-A', 'fixture-key'), true)
  assert.equal(f.workers[0].messages.length, count)
  assert.equal(await immediateState(f.service), true)
  f.workers[0].respond('getSessions', { success: true, sessions: [] }, true); await query
})
test('same-account open never skips a pending close', async () => {
  const f = fixture(); await open(f)
  const closing = f.service.close(), reopening = f.service.open('account-A', 'fixture-key')
  await tick()
  assert.equal(await immediateState(f.service), false)
  assert.equal(f.workers[0].messages.filter(message => message.type === 'open').length, 1)
  f.workers[0].respond('close', undefined, false); await closing; await tick()
  f.workers[0].respond('open', true, true); await reopening
  assert.equal(await immediateState(f.service), true)
})
test('connection test success does not mean a persistent handle survived restoration', async () => {
  const f = fixture(); await open(f)
  const checking = f.service.testConnection('account-B', 'fixture-key')
  assert.equal(await immediateState(f.service), false)
  await tick(); f.workers[0].respond('testConnection', { success: true }, false); await checking
  assert.equal(await immediateState(f.service), false)
  assert.equal(f.service.activeConnection, null)
})
test('failed test can preserve the original confirmed connection', async () => {
  const f = fixture(); await open(f)
  const checking = f.service.testConnection('account-B', 'fixture-key')
  await tick(); f.workers[0].respond('testConnection', { success: false }, true); await checking
  assert.equal(await immediateState(f.service), true)
})
test('worker error clears state and rejects outstanding requests immediately', async () => {
  const f = fixture(); await open(f)
  const query = f.service.getSessions(); const rejected = assert.rejects(query, /Worker 错误/)
  f.workers[0].emit('error', new Error('fixture worker error'))
  await rejected
  assert.equal(await immediateState(f.service), false)
  assert.equal(f.service.getPendingOperationSummary().count, 0)
})
test('even a zero-code worker exit rejects pending requests and clears connection', async () => {
  const f = fixture(); await open(f)
  const rejected = assert.rejects(f.service.getSessions(), /Worker 已退出/)
  f.workers[0].emit('exit', 0); await rejected
  assert.equal(await immediateState(f.service), false)
})
test('obsolete worker messages and exits cannot change a new account connection', async () => {
  const f = fixture(); await open(f)
  const old = f.workers[0], switching = f.service.open('account-B', 'fixture-key')
  assert.equal(await immediateState(f.service), false)
  await tick(); const current = f.workers[1]
  current.respond('open', true, true); await switching
  const query = f.service.getSessions()
  const id = current.messages.at(-1).id
  old.emit('message', { id, result: { success: false }, connected: false })
  old.emit('exit', 1)
  assert.equal(await immediateState(f.service), true)
  current.respond('getSessions', { success: true, sessions: [] }, true)
  assert.equal((await query).success, true)
})
test('failed open does not retain a confirmed connected state', async () => {
  const f = fixture(), opening = f.service.open('account-A', 'fixture-key')
  await tick(); f.workers[0].respond('open', false, false)
  assert.equal(await opening, false)
  assert.equal(await immediateState(f.service), false)
})
test('postMessage errors do not leak pending entries', async () => {
  const f = fixture(); await open(f)
  f.workers[0].throwOnPost = true
  await assert.rejects(f.service.getSessions(), /post failed/)
  assert.equal(f.service.getPendingOperationSummary().count, 0)
})
test('pending-operation diagnostics never include account, keys or query payloads', async () => {
  const f = fixture(); await open(f)
  const query = f.service.getSessions(), summary = f.service.getPendingOperationSummary()
  assert.equal(summary.count, 1); assert.equal(summary.oldestType, 'getSessions')
  assert.equal(typeof summary.oldestAgeMs, 'number')
  assert.doesNotMatch(JSON.stringify(summary), /fixture-key|account-A/)
  f.workers[0].respond('getSessions', { success: true, sessions: [] }, true); await query
})
test('Bridge preflight continues with a confirmed connection while session queries are busy', async () => {
  const filename = path.join(__dirname, '../electron/services/bridgeWechatSource.ts'), module = { exports: {} }
  new Function('require', 'module', 'exports', compile(fs.readFileSync(filename, 'utf8')))(require, module, module.exports)
  const f = fixture(); await open(f)
  const query = f.service.getSessions()
  const pending = [...f.service.pending.values()][0]; pending.startedAt -= 6000
  const warnings = [], progress = []
  let apiEnabled = false, pushEnabled = false, started = false
  const source = new module.exports.BridgeWechatSource({
    getSettings: () => ({ host: '127.0.0.1', port: 5031, token: 'fixture-token', wxid: 'fixture-wxid' }),
    isDatabaseConnected: () => f.service.isConnected(), getDatabaseActivity: () => f.service.getPendingOperationSummary(),
    saveToken: () => assert.fail('existing token must be preserved'), enableApi: () => { apiEnabled = true },
    enablePush: () => { pushEnabled = true },
    http: { isRunning: () => false, getHost: () => '127.0.0.1', getPort: () => 5031,
      start: async () => { started = true; return { success: true } } },
  })
  await source.prepareStart({ signal: new AbortController().signal, reportProgress: message => progress.push(message), reportWarning: message => warnings.push(message) })
  assert.equal(started && apiEnabled && pushEnabled, true)
  assert.ok(warnings.some(message => message.includes('getSessions')))
  assert.ok(progress.includes('启动本地微信消息服务'))
  assert.equal(f.workers[0].messages.some(message => message.type === 'isConnected'), false)
  f.workers[0].respond('getSessions', { success: true, sessions: [] }, true); await query
})

test('production worker replies publish actual core handle state on success and exceptions', async () => {
  const port = new EventEmitter(), replies = []
  port.postMessage = reply => replies.push(reply)
  let connected = false, fail = false
  class Core {
    isConnected() { return connected }
    async open() { connected = true; return true }
    async testConnection() { connected = false; return { success: true } }
    async getSessions() { if (fail) { connected = false; throw new Error('fixture query failure') }; return { success: true, sessions: [] } }
  }
  const filename = path.join(__dirname, '../electron/wcdbWorker.ts'), module = { exports: {} }
  new Function('require', 'module', 'exports', compile(fs.readFileSync(filename, 'utf8')))(
    name => name === 'worker_threads' ? { parentPort: port } : name === './services/wcdbCore' ? { WcdbCore: Core } : require(name), module, module.exports)
  const dispatch = async (id, type) => { port.emit('message', { id, type, payload: { accountDir: 'fixture', hexKey: 'fixture' } }); await tick(); return replies.at(-1) }
  assert.equal((await dispatch(1, 'open')).connected, true)
  assert.equal((await dispatch(2, 'testConnection')).connected, false)
  await dispatch(3, 'open'); fail = true
  const failed = await dispatch(4, 'getSessions')
  assert.match(failed.error, /fixture query failure/)
  assert.equal(failed.connected, false)
})
