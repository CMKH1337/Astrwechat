const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const ts = require('typescript')
// Compile the production TS modules without generating files or loading Electron.
require.extensions['.ts'] = (module, filename) => {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText
  module._compile(source, filename)
}
const { BridgeManager } = require('../electron/services/bridgeManager.ts')
const { BridgeWechatSource } = require('../electron/services/bridgeWechatSource.ts')
const { BridgeConfigStore } = require('../electron/services/bridgeConfigStore.ts')
const { normalizeBridgeConnection, activeBridgeConnection, requiresBridgeRestart, validateBridgeConnection } = require('../shared/bridge-connection.ts')
const defaults = require('../shared/bridge-default-config.json')

function fixture(t, initial = {}, behavior = {}) {
  const tempRoot = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(tempRoot, 'astrwechat-connection-'))
  t.after(() => {
    const resolved = fs.realpathSync(root)
    assert.equal(path.dirname(resolved), tempRoot)
    assert.ok(path.basename(resolved).startsWith('astrwechat-connection-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(root, 'main.py'), '# fake child entry; never executed')
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ...defaults, ...initial }))
  const children = [], events = [], statuses = [], logs = []
  let alive = 0, maxAlive = 0
  const manager = new BridgeManager({
    ...behavior.managerOptions,
    getBridgeDir: () => root, onStatus: value => statuses.push(value), onLog: value => logs.push(value),
    stopTimeoutMs: 20, killTimeoutMs: 20,
    spawnProcess: (_program, _args, options) => {
      assert.equal(options.windowsHide, true)
      const child = new EventEmitter()
      child.spawnOptions = options
      child.spawnArgs = _args
      child.pid = 100 + children.length
      child.exitCode = null; child.signalCode = null
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
      child.commands = []
      child.exit = () => {
        if (child.exitCode !== null) return
        child.exitCode = 0; alive -= 1; events.push(`exit:${child.pid}`)
        child.emit('exit', 0, null)
      }
      child.stdin.on('data', data => {
        const command = JSON.parse(data.toString())
        child.commands.push(command)
        if (command.cmd === 'exit' && !behavior.refuseExit) setTimeout(child.exit, behavior.exitDelay ?? 2)
      })
      child.kill = () => {
        events.push(`kill:${child.pid}`)
        if (!behavior.refuseExit) setTimeout(child.exit, 1)
        return true // A successful signal is deliberately NOT an exit acknowledgment.
      }
      children.push(child); alive += 1; maxAlive = Math.max(maxAlive, alive)
      events.push(`spawn:${child.pid}`)
      if (!behavior.holdSpawn) queueMicrotask(() => child.emit('spawn'))
      return child
    }
  })
  t.after(async () => {
    for (const child of children) child.exit()
    await manager.stop()
  })
  return { manager, root, children, events, statuses, logs, maxAlive: () => maxAlive }
}

test('legacy AstrBot settings migrate without losing either profile or token', () => {
  const config = normalizeBridgeConnection({ astrbot_ob_url: 'ws://localhost:9000/ws', astrbot_ob_token: 'old-token' })
  assert.equal(config.bot_backend, 'astrbot')
  assert.equal(config.astrbot_ob_token, 'old-token')
  assert.equal(config.kourichat_ob_url, 'ws://127.0.0.1:6700')
  assert.equal(activeBridgeConnection({ ...config, bot_backend: 'kourichat', kourichat_ob_token: 'kouri-token' }).token, 'kouri-token')
})

test('selected URL/token validation rejects wrong protocols and credential injection', () => {
  for (const url of ['', 'http://localhost:6700', 'ws://', 'ws://user:pass@localhost', 'ws://localhost/#fragment', 'ws://local host', 'ws://localhost:99999']) {
    assert.ok(validateBridgeConnection({ ...defaults, bot_backend: 'kourichat', kourichat_ob_url: url }), url)
  }
  assert.ok(validateBridgeConnection({ ...defaults, astrbot_ob_token: 'a\r\nb' }))
  assert.ok(validateBridgeConnection({ ...defaults, bot_backend: 'unknown' }))
  assert.equal(validateBridgeConnection({ ...defaults, kourichat_ob_url: '' }), null)
  assert.equal(validateBridgeConnection({ ...defaults, astrbot_ob_url: 'wss://[::1]:6700/ws' }), null)
})

test('only active endpoint, identity and API changes require a restart', () => {
  assert.equal(requiresBridgeRestart(defaults, { ...defaults, kourichat_ob_url: 'ws://localhost:8888' }), false)
  assert.equal(requiresBridgeRestart(defaults, { ...defaults, kourichat_ob_token: 'draft', buffer_seconds: 2 }), false)
  for (const change of [{ bot_backend: 'kourichat' }, { astrbot_ob_token: 'new' }, { astrbot_ob_url: 'ws://localhost:8888' }, { bot_wxid: 'new' }, { access_token: 'new' }]) {
    assert.equal(requiresBridgeRestart(defaults, { ...defaults, ...change }), true)
  }
})

test('stopped profile selection saves both groups without starting a process', async t => {
  const f = fixture(t, { astrbot_ob_token: 'astr-secret' })
  const result = await f.manager.saveConfig({ bot_backend: 'kourichat', kourichat_ob_token: 'kouri-secret' })
  assert.equal(result.success, true)
  assert.equal(f.children.length, 0)
  const saved = await f.manager.getConfig()
  assert.equal(saved.bot_backend, 'kourichat')
  assert.equal(saved.astrbot_ob_token, 'astr-secret')
  assert.equal(saved.kourichat_ob_token, 'kouri-secret')
  assert.equal(f.manager.status.bot_backend, 'kourichat')
})

test('running switch waits for process exit, serializes rapid saves and never overlaps children', async t => {
  const f = fixture(t)
  assert.equal((await f.manager.start()).success, true)
  const first = f.manager.saveConfig({ bot_backend: 'kourichat', kourichat_ob_token: 'kouri-secret' })
  const second = f.manager.saveConfig({ bot_backend: 'astrbot', astrbot_ob_token: 'astr-secret' })
  assert.equal((await first).restarted, true)
  assert.equal((await second).restarted, true)
  assert.equal(f.maxAlive(), 1)
  assert.deepEqual(f.events, ['spawn:100', 'exit:100', 'spawn:101', 'exit:101', 'spawn:102'])
  assert.equal(f.manager.status.bot_backend, 'astrbot')
  const saved = await f.manager.getConfig()
  assert.equal(saved.kourichat_ob_token, 'kouri-secret')
  assert.equal(saved.astrbot_ob_token, 'astr-secret')
  // Stale output and late exit notifications from an old child cannot mutate the new status.
  f.children[0].stdout.write(JSON.stringify({ type: 'status', data: { bot_backend: 'kourichat', ob_connected: true } }) + '\n')
  f.children[0].emit('exit', 0)
  assert.equal(f.manager.status.bot_backend, 'astrbot')
  assert.equal(f.manager.isRunning(), true)
})

test('saving an inactive draft keeps the existing process and hot-updates shared settings', async t => {
  const f = fixture(t)
  await f.manager.start()
  const result = await f.manager.saveConfig({ kourichat_ob_url: '', kourichat_ob_token: 'draft' })
  assert.equal(result.success, true); assert.equal(result.restarted, false)
  assert.equal(f.children.length, 1)
  assert.deepEqual(f.children[0].commands.map(x => x.cmd), ['start', 'update_config'])
})

test('invalid selected profile leaves disk and live child untouched', async t => {
  const f = fixture(t)
  await f.manager.start()
  const before = fs.readFileSync(path.join(f.root, 'config.json'), 'utf8')
  const result = await f.manager.saveConfig({ bot_backend: 'kourichat', kourichat_ob_url: 'http://localhost:6700' })
  assert.equal(result.success, false)
  assert.equal(f.children.length, 1)
  assert.deepEqual(f.children[0].commands.map(x => x.cmd), ['start'])
  assert.equal(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'), before)
})

test('a child that accepts kill but never exits blocks switching and retains previous config', async t => {
  const f = fixture(t, {}, { refuseExit: true })
  await f.manager.start()
  const result = await f.manager.saveConfig({ bot_backend: 'kourichat' })
  assert.equal(result.success, false)
  assert.equal((await f.manager.getConfig()).bot_backend, 'astrbot')
  assert.equal(f.children.length, 1)
  assert.equal(f.manager.isRunning(), true)
  assert.ok(f.manager.status.ob_error.includes('旧 Bridge'))
})

test('fragmented JSON status lines survive chunks and credentials are redacted from logs', async t => {
  const f = fixture(t, { astrbot_ob_token: 'secret-A', kourichat_ob_token: 'secret-K' })
  await f.manager.start()
  const frame = JSON.stringify({ type: 'status', data: { running: true, ob_connected: true, ob_state: 'connected', bot_backend: 'astrbot' } }) + '\n'
  f.children[0].stdout.write(frame.slice(0, 10)); f.children[0].stdout.write(frame.slice(10))
  assert.equal(f.manager.status.ob_connected, true)
  f.children[0].stdout.write(JSON.stringify({ type: 'log', data: { msg: 'secret-A secret-K ws://localhost?token=other-secret', level: 'info' } }) + '\n')
  assert.ok(f.logs.length > 0)
  assert.ok(!f.logs.join('').includes('secret-A') && !f.logs.join('').includes('secret-K') && !f.logs.join('').includes('other-secret'))
})


test('legacy session permission migration is not hidden by injecting new defaults', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify({ astrbot_ob_url: 'ws://localhost:1234/ws', astrbot_ob_token: 'legacy', active_reply_whitelist: ['group@chatroom'] }))
  const config = await f.manager.getConfig()
  assert.equal(config.bot_backend, 'astrbot')
  assert.equal(config.group_reply_filter_mode, undefined)
  assert.deepEqual(config.active_reply_whitelist, ['group@chatroom'])
})

test('simultaneous start requests cannot spawn duplicate Bridge processes', async t => {
  const f = fixture(t)
  const results = await Promise.all([f.manager.start(), f.manager.start()])
  assert.equal(results.filter(result => result.success).length, 1)
  assert.equal(f.children.length, 1)
})

test('changing active token restarts the child instead of only changing future reconnects', async t => {
  const f = fixture(t)
  await f.manager.start()
  const result = await f.manager.saveConfig({ astrbot_ob_token: 'new-auth-token' })
  assert.equal(result.restarted, true)
  assert.deepEqual(f.events, ['spawn:100', 'exit:100', 'spawn:101'])
  assert.equal(f.children[0].commands.some(cmd => cmd.cmd === 'update_config'), false)
})


function wechatSourceFixture(overrides = {}, hooks = {}) {
  const settings = { host: '127.0.0.1', port: 5031, token: '', wxid: 'wxid_current', ...overrides }
  const runtime = { connected: true, running: false, host: '127.0.0.1', port: 5031, apiEnabled: false, pushEnabled: false }
  const calls = []
  const source = new BridgeWechatSource({
    getSettings: () => ({ ...settings }),
    isDatabaseConnected: async () => runtime.connected,
    saveToken: token => { settings.token = token; calls.push('token') },
    enableApi: () => { runtime.apiEnabled = true; calls.push('api') },
    enablePush: () => { runtime.pushEnabled = true; calls.push('push') },
    http: {
      isRunning: () => runtime.running,
      getHost: () => runtime.host,
      getPort: () => runtime.port,
      start: async (port, host) => {
        calls.push('listen')
        if (runtime.error) return { success: false, error: runtime.error }
        runtime.running = true; runtime.port = port; runtime.host = host
        return { success: true }
      }
    },
    ...hooks
  })
  return { source, settings, runtime, calls }
}

test('local WeChat source needs no manual push setup: generates a token and enables API/push', async () => {
  const f = wechatSourceFixture()
  await f.source.prepareStart()
  assert.match(f.settings.token, /^[a-f0-9]{64}$/)
  assert.equal(f.runtime.apiEnabled, true)
  assert.equal(f.runtime.pushEnabled, true)
  assert.deepEqual(f.calls, ['token', 'listen', 'api', 'push'])
  assert.deepEqual(f.source.getConfig(), {
    weflow_base_url: 'http://127.0.0.1:5031', access_token: f.settings.token, bot_wxid: 'wxid_current'
  })
  const token = f.settings.token
  await f.source.prepareStart()
  assert.equal(f.settings.token, token)
  assert.equal(f.calls.filter(x => x === 'listen').length, 1)
})

test('local WeChat source preserves existing API credentials and uses the running listener', async () => {
  const f = wechatSourceFixture({ token: ' existing-local-secret ', port: 8000, host: '0.0.0.0' })
  Object.assign(f.runtime, { running: true, port: 5055, host: '127.0.0.1' })
  await f.source.prepareStart()
  assert.deepEqual(f.calls, ['api', 'push'])
  assert.equal(f.source.getConfig().access_token, 'existing-local-secret')
  assert.equal(f.source.getConfig().weflow_base_url, 'http://127.0.0.1:5055')
})

test('bind wildcards and IPv6 addresses become reachable local client URLs', () => {
  for (const [host, urlHost] of [
    ['0.0.0.0', '127.0.0.1'], ['::', '[::1]'], ['[::]', '[::1]'],
    ['::1', '[::1]'], ['[::1]', '[::1]'], ['192.168.1.10', '192.168.1.10']
  ]) {
    const f = wechatSourceFixture({ host })
    assert.equal(f.source.getConfig().weflow_base_url, `http://${urlHost}:5031`)
  }
})

test('disconnected database does not open a port, create credentials or enable push', async () => {
  const f = wechatSourceFixture()
  f.runtime.connected = false
  await assert.rejects(f.source.prepareStart(), /连接微信数据库/)
  assert.deepEqual(f.calls, [])
  assert.equal(f.runtime.apiEnabled, false)
  assert.equal(f.runtime.pushEnabled, false)
})

test('missing account and API listen errors prevent Bridge readiness', async () => {
  const missing = wechatSourceFixture({ wxid: '' })
  await assert.rejects(missing.source.prepareStart(), /账号信息不完整/)
  assert.deepEqual(missing.calls, [])
  const failed = wechatSourceFixture({ token: 'existing-token' })
  failed.runtime.error = 'Port 5031 is already in use'
  await assert.rejects(failed.source.prepareStart(), /自动启动微信推送服务失败.*5031/)
  assert.deepEqual(failed.calls, ['listen'])
  assert.equal(failed.runtime.pushEnabled, false)
})

test('managed source overrides stale or submitted Bridge API/account values, not bot profiles', async t => {
  const source = wechatSourceFixture({ token: 'managed-token' })
  let preparations = 0
  const f = fixture(t, { weflow_base_url: 'http://old-host:9999', access_token: 'old-token', bot_wxid: 'wxid_old' }, {
    managerOptions: { getManagedConfig: () => source.source.getConfig(), prepareStart: async () => { preparations++ } }
  })
  const shown = await f.manager.getConfig()
  assert.equal(shown.access_token, 'managed-token')
  assert.equal(shown.bot_wxid, 'wxid_current')
  const result = await f.manager.saveConfig({
    weflow_base_url: 'http://stale-page:1111', access_token: 'stale-token', bot_wxid: 'wxid_stale',
    astrbot_ob_token: 'astr-token', kourichat_ob_token: 'kouri-token'
  })
  assert.equal(result.success, true)
  assert.equal(preparations, 0) // Editing profiles must not turn on any listener.
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'))
  assert.equal(stored.weflow_base_url, 'http://127.0.0.1:5031')
  assert.equal(stored.access_token, 'managed-token')
  assert.equal(stored.bot_wxid, 'wxid_current')
  assert.equal(stored.astrbot_ob_token, 'astr-token')
  assert.equal(stored.kourichat_ob_token, 'kouri-token')
})

test('desktop Bridge start prepares the local source and persists fresh credentials before Python starts', async t => {
  const source = wechatSourceFixture({ port: 5044 })
  const f = fixture(t, { access_token: 'obsolete', bot_wxid: 'wxid_old' }, {
    managerOptions: { getManagedConfig: () => source.source.getConfig(), prepareStart: () => source.source.prepareStart() }
  })
  assert.equal((await f.manager.start()).success, true)
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'))
  assert.equal(stored.weflow_base_url, 'http://127.0.0.1:5044')
  assert.equal(stored.access_token, source.settings.token)
  assert.match(stored.access_token, /^[a-f0-9]{64}$/)
  assert.equal(stored.bot_wxid, 'wxid_current')
  assert.equal(f.children.length, 1)
  f.children[0].stderr.write(`token=${source.settings.token}`)
  assert.ok(!f.logs.join('').includes(source.settings.token))
})

test('failed automatic WeChat preparation never spawns Python or rewrites Bridge config', async t => {
  const source = wechatSourceFixture()
  source.runtime.connected = false
  const f = fixture(t, {}, {
    managerOptions: { getManagedConfig: () => source.source.getConfig(), prepareStart: () => source.source.prepareStart() }
  })
  const before = fs.readFileSync(path.join(f.root, 'config.json'), 'utf8')
  const result = await f.manager.start()
  assert.equal(result.success, false)
  assert.match(result.error, /连接微信数据库/)
  assert.equal(f.children.length, 0)
  assert.equal(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'), before)
})

test('invalid bot endpoint is rejected before automatic WeChat setup has any side effects', async t => {
  let preparations = 0
  const f = fixture(t, { astrbot_ob_url: 'http://invalid' }, {
    managerOptions: { prepareStart: async () => { preparations++ } }
  })
  assert.equal((await f.manager.start()).success, false)
  assert.equal(preparations, 0)
})

test('rotating the managed local token safely restarts an active Bridge even after getConfig', async t => {
  const source = wechatSourceFixture({ token: 'first-local-token' })
  const f = fixture(t, {}, {
    managerOptions: { getManagedConfig: () => source.source.getConfig(), prepareStart: () => source.source.prepareStart() }
  })
  await f.manager.start()
  source.settings.token = 'second-local-token'
  assert.equal((await f.manager.getConfig()).access_token, 'second-local-token')
  const result = await f.manager.saveConfig({})
  assert.equal(result.restarted, true)
  assert.deepEqual(f.events, ['spawn:100', 'exit:100', 'spawn:101'])
  assert.equal(f.maxAlive(), 1)
  assert.equal(f.children[0].commands.some(cmd => cmd.cmd === 'update_config'), false)
})


test('Bridge follows the selected database wxid without a separate identity field in the page', async t => {
  const source = wechatSourceFixture({ token: 'local-token', wxid: 'wxid_detected_account' })
  const f = fixture(t, { bot_wxid: 'wxid_obsolete_bridge_identity' }, {
    managerOptions: { getManagedConfig: () => source.source.getConfig(), prepareStart: () => source.source.prepareStart() }
  })
  const first = await f.manager.saveConfig({ bot_backend: 'astrbot', bot_nicknames: ['Bot'] })
  assert.equal(first.config.bot_wxid, 'wxid_detected_account')
  assert.equal((await f.manager.start()).success, true)
  assert.equal(await f.manager.stop(), true)
  // Simulate selecting/connecting another detected account; no identity is sent by Bridge UI.
  source.settings.wxid = 'wxid_another_detected_account'
  assert.equal((await f.manager.start()).success, true)
  const persisted = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'))
  assert.equal(persisted.bot_wxid, 'wxid_another_detected_account')
  assert.deepEqual(persisted.bot_nicknames, ['Bot'])
  assert.equal(f.maxAlive(), 1)
})


function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

test('database preflight logs progress immediately and times out instead of leaving start disabled', { timeout: 2000 }, async t => {
  const database = deferred(), entered = deferred()
  const source = wechatSourceFixture({}, { isDatabaseConnected: () => { entered.resolve(); return database.promise } })
  const f = fixture(t, {}, { managerOptions: {
    startTimeoutMs: 80,
    getManagedConfig: () => source.source.getConfig(),
    prepareStart: context => source.source.prepareStart(context)
  } })
  const started = f.manager.start()
  await entered.promise
  assert.equal(f.manager.status.starting, true)
  assert.equal(f.manager.status.processRunning, false)
  assert.match(f.logs.join('\n'), /检查微信数据库连接/)
  const result = await started
  assert.equal(result.success, false)
  assert.match(result.error, /启动超时：检查微信数据库连接/)
  assert.match(f.logs.join('\n'), /\[ERROR\].*启动超时/)
  assert.equal(f.manager.status.starting, false)
  assert.equal(f.manager.status.ob_state, 'error')
  assert.equal(f.children.length, 0)
  database.resolve(true)
  await nextTurn()
  assert.deepEqual(source.calls, []) // Late native response cannot enable services or spawn Python.
  assert.equal(f.children.length, 0)
})

test('a retry can succeed after timeout; the late old preflight never starts another child', { timeout: 2000 }, async t => {
  const old = deferred()
  let attempt = 0
  const source = wechatSourceFixture({}, { isDatabaseConnected: () => ++attempt === 1 ? old.promise : Promise.resolve(true) })
  const f = fixture(t, {}, { managerOptions: {
    startTimeoutMs: 80, getManagedConfig: () => source.source.getConfig(),
    prepareStart: context => source.source.prepareStart(context)
  } })
  assert.equal((await f.manager.start()).success, false)
  assert.equal((await f.manager.start()).success, true)
  const logCount = f.logs.length
  old.resolve(true)
  await nextTurn()
  assert.equal(f.children.length, 1)
  assert.equal(f.maxAlive(), 1)
  assert.equal(f.logs.length, logCount)
  assert.equal(f.manager.status.starting, false)
  assert.equal(f.manager.status.ob_state, 'connecting')
})

test('an HTTP preflight timeout clears the busy state and blocks late push enablement', { timeout: 2000 }, async t => {
  const listener = deferred()
  const source = wechatSourceFixture({ token: 'existing' })
  source.source.options.http.start = () => listener.promise
  const f = fixture(t, {}, { managerOptions: {
    startTimeoutMs: 80, getManagedConfig: () => source.source.getConfig(),
    prepareStart: context => source.source.prepareStart(context)
  } })
  const result = await f.manager.start()
  assert.equal(result.success, false)
  assert.match(result.error, /启动本地微信消息服务/)
  listener.resolve({ success: true })
  await nextTurn()
  assert.equal(source.runtime.pushEnabled, false)
  assert.equal(f.children.length, 0)
  assert.equal(f.manager.status.starting, false)
})

test('a never-ending session warmup does not block Python startup or later trigger a startup timeout', { timeout: 2000 }, async t => {
  const warmup = deferred()
  let warmed = 0
  const source = wechatSourceFixture({}, { warmupPush: () => { warmed++; return warmup.promise } })
  const f = fixture(t, {}, { managerOptions: {
    startTimeoutMs: 100, getManagedConfig: () => source.source.getConfig(),
    prepareStart: context => source.source.prepareStart(context)
  } })
  assert.equal((await f.manager.start()).success, true)
  assert.equal(warmed, 1)
  assert.equal(source.runtime.pushEnabled, true)
  assert.equal(f.children.length, 1)
  assert.equal(f.manager.status.starting, false)
  assert.match(f.logs.join('\n'), /会话预热在后台进行/)
  assert.match(f.logs.join('\n'), /启动命令已发送/)
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(f.manager.status.ob_state, 'connecting')
  warmup.resolve()
})

test('background warmup failures are observed and logged with credentials redacted', async t => {
  const warmup = deferred()
  const source = wechatSourceFixture({ token: 'local-secret' }, { warmupPush: () => warmup.promise })
  const f = fixture(t, {}, { managerOptions: {
    getManagedConfig: () => source.source.getConfig(), prepareStart: context => source.source.prepareStart(context)
  } })
  assert.equal((await f.manager.start()).success, true)
  warmup.reject(new Error('local-secret: native query failed'))
  await nextTurn()
  assert.match(f.logs.join('\n'), /\[WARN\].*后台初始化失败/)
  assert.ok(!f.logs.join('\n').includes('local-secret'))
  assert.equal(f.manager.status.starting, false)
  assert.equal(f.manager.isRunning(), true)
})

test('a stopped Bridge does not receive warnings from its obsolete background warmup', async t => {
  const warmup = deferred()
  const source = wechatSourceFixture({}, { warmupPush: () => warmup.promise })
  const f = fixture(t, {}, { managerOptions: {
    getManagedConfig: () => source.source.getConfig(), prepareStart: context => source.source.prepareStart(context)
  } })
  await f.manager.start()
  await f.manager.stop()
  const count = f.logs.length
  warmup.reject(new Error('obsolete query failure'))
  await nextTurn()
  assert.equal(f.logs.length, count)
})

test('a child that never reports spawn is timed out, stopped and never sent a late start command', { timeout: 2000 }, async t => {
  const f = fixture(t, {}, { holdSpawn: true, managerOptions: { startTimeoutMs: 80 } })
  const result = await f.manager.start()
  assert.equal(result.success, false)
  assert.match(result.error, /启动 Python Bridge 进程/)
  assert.equal(f.manager.status.starting, false)
  assert.equal(f.manager.isRunning(), false)
  assert.deepEqual(f.children[0].commands.map(c => c.cmd), ['exit'])
  f.children[0].emit('spawn')
  await nextTurn()
  assert.deepEqual(f.children[0].commands.map(c => c.cmd), ['exit'])
})

test('message push baseline and subsequent refresh use lightweight sessions, preserving native unread counts', async () => {
  const vm = require('node:vm')
  const requested = []
  const session = { username: 'friend', lastTimestamp: 100, unreadCount: 3 }
  const config = { get: key => key === 'messagePushEnabled', getCacheBasePath: () => os.tmpdir() }
  const module = { exports: {} }
  const mocks = {
    './config': { ConfigService: { getInstance: () => config } },
    './chatService': { chatService: {
      connect: async () => ({ success: true }),
      getSessions: async options => { requested.push(options); return { success: true, sessions: [{ ...session }] } }
    } },
    './wcdbService': { wcdbService: {} },
    './httpService': { httpService: {} },
    './export/constants': { FILE_APP_LOCAL_TYPE_SET: new Set() }
  }
  const source = fs.readFileSync(path.join(__dirname, '../electron/services/messagePushService.ts'), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  vm.runInNewContext(output, { module, exports: module.exports, require: name => mocks[name] || require(name), console, setTimeout, clearTimeout, URL, Buffer })
  const service = module.exports.messagePushService
  await service.handleConfigChanged('messagePushEnabled')
  assert.equal(service.sessionBaseline.get('friend').unreadCount, 3)
  await service.flushPendingChanges()
  assert.equal(service.sessionBaseline.get('friend').unreadCount, 3)
  assert.equal(requested.length, 2)
  assert.ok(requested.every(options => options.skipMessageStats === true))
  service.stop()
})


test('all-zero config after reboot is preserved and replaced by editable defaults with a visible warning', async t => {
  const f = fixture(t)
  const location = path.join(f.root, 'config.json')
  const damaged = Buffer.alloc(627)
  fs.writeFileSync(location, damaged)
  const config = await f.manager.getConfig()
  assert.equal(config.bot_backend, 'astrbot')
  assert.equal(config.astrbot_ob_token, '')
  assert.match(f.manager.configWarning, /配置已损坏.*重新填写/)
  assert.match(f.logs.join('\n'), /\[WARN\]/)
  const preserved = fs.readdirSync(f.root).find(name => name.startsWith('config.json.corrupt-'))
  assert.ok(preserved)
  assert.deepEqual(fs.readFileSync(path.join(f.root, preserved)), damaged)
  assert.equal(JSON.parse(fs.readFileSync(location, 'utf8')).bot_backend, 'astrbot')
  const result = await f.manager.saveConfig({ astrbot_ob_token: 'new-user-token' })
  assert.equal(result.success, true)
  assert.equal(f.manager.configWarning, undefined)
  assert.equal((await f.manager.getConfig()).astrbot_ob_token, 'new-user-token')
})

test('a truncated config recovers the last good saved backup without leaking token fragments', async t => {
  const f = fixture(t, { astrbot_ob_token: 'last-good-token', group_reply_filter_sessions: ['allowed@chatroom'] })
  await f.manager.saveConfig({ astrbot_ob_token: 'newer-token' })
  fs.writeFileSync(path.join(f.root, 'config.json'), '{"astrbot_ob_token":"private-fragment')
  const config = await f.manager.getConfig()
  assert.equal(config.astrbot_ob_token, 'last-good-token')
  assert.deepEqual(config.group_reply_filter_sessions, ['allowed@chatroom'])
  assert.match(f.manager.configWarning, /有效备份恢复/)
  assert.ok(!f.logs.join('\n').includes('private-fragment'))
  assert.ok(!f.logs.join('\n').includes('last-good-token'))
})

test('new user config migrates both profiles once from the install directory and Python uses its new path', async t => {
  const f = fixture(t, { astrbot_ob_token: 'legacy-A', kourichat_ob_token: 'legacy-K', bot_backend: 'kourichat', group_reply_filter_sessions: ['group@chatroom'] }, {
    managerOptions: { getConfigDir: () => path.join(f.root, 'user-data') }
  })
  const legacyPath = path.join(f.root, 'config.json')
  const before = fs.readFileSync(legacyPath)
  const migrated = await f.manager.getConfig()
  assert.equal(migrated.astrbot_ob_token, 'legacy-A')
  assert.equal(migrated.kourichat_ob_token, 'legacy-K')
  assert.deepEqual(migrated.group_reply_filter_sessions, ['group@chatroom'])
  const userPath = path.join(f.root, 'user-data', 'config.json')
  assert.equal((await f.manager.saveConfig({ kourichat_ob_token: 'user-K' })).success, true)
  assert.deepEqual(fs.readFileSync(legacyPath), before)
  assert.equal(JSON.parse(fs.readFileSync(userPath, 'utf8')).kourichat_ob_token, 'user-K')
  assert.equal((await f.manager.start()).success, true)
  assert.deepEqual(f.children[0].spawnArgs, [path.join(f.root, 'main.py')])
  assert.equal(f.children[0].spawnOptions.cwd, path.dirname(userPath))
  assert.equal(f.children[0].spawnOptions.env.WEFLOW_BRIDGE_CONFIG, userPath)
  assert.equal(f.children[0].spawnOptions.env.PYTHONDONTWRITEBYTECODE, '1')
})

test('corrupt legacy install config is copied for evidence without modifying the install directory', async t => {
  const f = fixture(t, {}, { managerOptions: { getConfigDir: () => path.join(f.root, 'user-data') } })
  const original = path.join(f.root, 'config.json'), damaged = Buffer.alloc(627)
  fs.writeFileSync(original, damaged)
  const recovered = await f.manager.getConfig()
  assert.equal(recovered.bot_backend, 'astrbot')
  assert.deepEqual(fs.readFileSync(original), damaged)
  const preserved = fs.readdirSync(f.manager.getConfigDir()).find(name => name.includes('.corrupt-'))
  assert.ok(preserved)
  assert.deepEqual(fs.readFileSync(path.join(f.manager.getConfigDir(), preserved)), damaged)
  assert.match(f.manager.configWarning, /重新填写/)
})

test('a missing user primary recovers its backup before considering obsolete legacy credentials', async t => {
  const f = fixture(t, { astrbot_ob_token: 'obsolete' }, { managerOptions: { getConfigDir: () => path.join(f.root, 'user-data') } })
  fs.mkdirSync(f.manager.getConfigDir())
  fs.writeFileSync(path.join(f.manager.getConfigDir(), 'config.json.bak'), JSON.stringify({ ...defaults, astrbot_ob_token: 'backup-good' }))
  const result = await f.manager.getConfig()
  assert.equal(result.astrbot_ob_token, 'backup-good')
  assert.match(f.manager.configWarning, /有效备份恢复/)
})

test('BOM configs remain readable; invalid root shapes recover rather than permanently disabling the page', async t => {
  const f = fixture(t)
  const location = path.join(f.root, 'config.json')
  fs.writeFileSync(location, '\uFEFF' + JSON.stringify({ ...defaults, astrbot_ob_token: 'bom-token' }))
  assert.equal((await f.manager.getConfig()).astrbot_ob_token, 'bom-token')
  assert.equal(f.manager.configWarning, undefined)
  for (const invalid of ['null', '[]', '"not-an-object"', '']) {
    fs.writeFileSync(location, invalid)
    const value = await f.manager.getConfig()
    assert.equal(value.bot_backend, 'astrbot')
    assert.ok(f.manager.configWarning)
  }
})

test('config reset clears primary and backup so old credentials cannot be resurrected', async t => {
  const f = fixture(t, { astrbot_ob_token: 'private-A', kourichat_ob_token: 'private-K' })
  await f.manager.saveConfig({ bot_nicknames: ['test'] })
  await f.manager.resetConfig()
  for (const name of ['config.json', 'config.json.bak']) {
    const value = JSON.parse(fs.readFileSync(path.join(f.root, name), 'utf8'))
    assert.equal(value.astrbot_ob_token, '')
    assert.equal(value.kourichat_ob_token, '')
  }
  fs.writeFileSync(path.join(f.root, 'config.json'), '\0')
  assert.equal((await f.manager.getConfig()).astrbot_ob_token, '')
})

test('permission and I/O failures do not replace unreadable configs with defaults', async t => {
  const f = fixture(t)
  const vm = require('node:vm')
  const source = fs.readFileSync(path.join(__dirname, '../electron/services/bridgeConfigStore.ts'), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  const mockedFs = { ...fs, readFileSync: () => { const e = new Error('Access denied'); e.code = 'EACCES'; throw e } }
  vm.runInNewContext(output, { module, exports: module.exports, require: name => name === 'fs' ? mockedFs : name.endsWith('bridge-default-config.json') ? defaults : require(name), Buffer })
  const store = new module.exports.BridgeConfigStore({ getDirectory: () => f.root, onWarning: () => {} })
  const before = fs.readFileSync(path.join(f.root, 'config.json'))
  assert.throws(() => store.read(), /Access denied/)
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'config.json')), before)
})

test('each persisted replacement is flushed before rename and cancelled writes leave prior config untouched', async t => {
  const f = fixture(t)
  const vm = require('node:vm'), events = []
  const source = fs.readFileSync(path.join(__dirname, '../electron/services/bridgeConfigStore.ts'), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  const mockedFs = { ...fs,
    fsyncSync: fd => { events.push('sync'); return fs.fsyncSync(fd) },
    renameSync: (old, next) => { events.push('rename'); return fs.renameSync(old, next) }
  }
  vm.runInNewContext(output, { module, exports: module.exports, require: name => name === 'fs' ? mockedFs : name.endsWith('bridge-default-config.json') ? defaults : require(name), Buffer })
  const store = new module.exports.BridgeConfigStore({ getDirectory: () => f.root, onWarning: () => {} })
  store.write({ ...defaults, astrbot_ob_token: 'new-token' })
  assert.deepEqual(events, ['sync', 'rename', 'sync', 'rename'])
  const before = fs.readFileSync(path.join(f.root, 'config.json'))
  const cancelled = new AbortController(); cancelled.abort(new Error('cancelled'))
  assert.throws(() => store.write(defaults, cancelled.signal), /cancelled/)
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'config.json')), before)
  assert.equal(fs.readdirSync(f.root).filter(name => name.endsWith('.tmp')).length, 0)
})
