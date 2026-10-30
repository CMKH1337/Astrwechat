const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const vm = require('node:vm')
const ts = require('typescript')

const host = '127.0.0.1'

async function closeServer(server) {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

async function availablePort() {
  const server = http.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const port = server.address().port
  await closeServer(server)
  return port
}

function fixture(t) {
  const servers = []
  const mocks = {
    http: { ...http, createServer: (...args) => {
      const server = http.createServer(...args)
      servers.push(server)
      return server
    } },
    './config': { ConfigService: { getInstance: () => ({ get: () => false }) } },
    './chatService': {}, './wcdbService': {}, './videoService': {},
    './imageDecryptService': {}, './apiMessageMapperPool': {},
    './apiMessageMapping': {}, './export/constants': {}
  }
  const module = { exports: {} }
  const source = fs.readFileSync(path.join(__dirname, '../electron/services/httpService.ts'), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText
  vm.runInNewContext(output, {
    module, exports: module.exports, require: name => mocks[name] || require(name),
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Buffer
  })
  const service = module.exports.httpService
  // Exercise real TCP listeners without starting Electron, database workers or heartbeats.
  service.ensureDbReady = async () => true
  service.getApiMapperPool = () => ({ warmup() {} })
  service.startMessagePushHeartbeat = () => {}
  t.after(async () => {
    // Also close leaked listeners when running this regression against the old implementation.
    await Promise.all(servers.map(closeServer))
    await service.stop()
  })
  return { service, servers }
}

test('overlapping HTTP starts share one listener and stop releases its actual port', { timeout: 5000 }, async t => {
  const { service, servers } = fixture(t)
  const port = await availablePort()
  const results = await Promise.all([service.start(port, host), service.start(port, host)])
  assert.ok(results.every(result => result.success), JSON.stringify(results))
  assert.equal(servers.length, 1)
  assert.equal(service.isRunning(), true)
  await service.stop()
  assert.equal(service.isRunning(), false)
  assert.equal(servers[0].listening, false)
  assert.equal((await service.start(port, host)).success, true)
})

test('stop during HTTP startup completes before a replacement listener starts', { timeout: 5000 }, async t => {
  const { service, servers } = fixture(t)
  const port = await availablePort()
  const starting = service.start(port, host)
  const stopping = service.stop()
  const restarting = service.start(port, host)
  assert.equal((await starting).success, true)
  await stopping
  assert.equal((await restarting).success, true)
  assert.equal(servers.length, 2)
  assert.equal(servers[0].listening, false)
  assert.equal(servers[1].listening, true)
  assert.equal(service.isRunning(), true)
})

test('a real port conflict clears the failed listener and allows retry after the owner exits', { timeout: 5000 }, async t => {
  const { service } = fixture(t)
  const owner = http.createServer()
  t.after(() => closeServer(owner))
  await new Promise(resolve => owner.listen(0, host, resolve))
  const port = owner.address().port
  const result = await service.start(port, host)
  assert.equal(result.success, false)
  assert.match(result.error, /already in use/)
  assert.equal(service.isRunning(), false)
  assert.equal(service.server, null)
  assert.equal(owner.listening, true)
  await closeServer(owner)
  assert.equal((await service.start(port, host)).success, true)
})

test('a synchronous listen failure returns a failed result and does not block subsequent starts', { timeout: 5000 }, async t => {
  const { service } = fixture(t)
  const result = await service.start(-1, host)
  assert.equal(result.success, false)
  assert.equal(service.server, null)
  assert.equal(service.isRunning(), false)
  const port = await availablePort()
  assert.equal((await service.start(port, host)).success, true)
})

test('repeated HTTP stops are safe and a stopped port can be bound again', { timeout: 5000 }, async t => {
  const { service } = fixture(t)
  const port = await availablePort()
  assert.equal((await service.start(port, host)).success, true)
  await Promise.all([service.stop(), service.stop()])
  assert.equal(service.server, null)
  assert.equal(service.isRunning(), false)
  assert.equal((await service.start(port, host)).success, true)
})
