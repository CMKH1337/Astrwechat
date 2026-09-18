const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const transpile = text => ts.transpileModule(text, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText
require.extensions['.ts'] = (module, filename) => module._compile(transpile(fs.readFileSync(filename, 'utf8')), filename)
const { inspectMessageDbFiles, MESSAGE_DB_UNAVAILABLE } = require('../electron/services/messageDbDiagnostics.ts')
const { WcdbCore } = require('../electron/services/wcdbCore.ts')

// Compile the real service methods, excluding Electron/startup side effects.
function chatFixture(database = {}) {
  const source = ts.createSourceFile('chatService.ts', fs.readFileSync(path.join(root, 'electron/services/chatService.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const klass = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'ChatService')
  const names = new Set(['getMessageDbCountSnapshot', 'getSessionMessageCounts', 'getMessageDateCountsBatch'])
  const methods = klass.members.filter(node => node.name && names.has(node.name.getText(source))).map(node => node.getText(source))
  assert.equal(methods.length, names.size)
  const exports = {}
  new Function('wcdbService', 'MESSAGE_DB_UNAVAILABLE', 'exports', transpile(`export class Subject { ${methods.join('\n')} }`))(database, MESSAGE_DB_UNAVAILABLE, exports)
  const service = new exports.Subject()
  Object.assign(service, {
    ensureConnected: async () => ({ success: true }),
    normalizeExportDiagTraceId: () => undefined, startExportDiagStep: () => 0,
    endExportDiagStep: () => {}, logExportDiag: () => {}, refreshSessionMessageCountCacheScope: () => {},
    messageDbCountSnapshotCacheTtlMs: 8000, sessionMessageCountCacheTtlMs: 8000,
    sessionMessageCountCache: new Map(), sessionMessageCountHintCache: new Map(),
    listMessageDbPathsForCount: async () => ({ success: true, dbPaths: ['message_0.db'] }),
    buildMessageDbSignature: paths => paths.join('|'),
    countSessionMessageCountsByTableScan: async () => ({ success: false, error: 'scan failed' }),
  })
  return service
}

test('empty native discovery is not cached; a later discovery can recover', async () => {
  const service = chatFixture()
  let paths = []
  service.listMessageDbPathsForCount = async () => ({ success: true, dbPaths: paths })
  assert.equal((await service.getMessageDbCountSnapshot()).error, MESSAGE_DB_UNAVAILABLE)
  assert.equal(service.messageDbCountSnapshotCache, null)
  paths = ['message_0.db']
  assert.equal((await service.getMessageDbCountSnapshot()).success, true)
})

test('message DB unavailability is not hidden by session hints or returned as zero stats', async () => {
  const service = chatFixture({ getSessionMessageDateCountsBatch: () => assert.fail('must not query') })
  service.listMessageDbPathsForCount = async () => ({ success: true, dbPaths: [] })
  service.sessionMessageCountHintCache.set('friend', 99)
  assert.equal((await service.getSessionMessageCounts(['friend'])).error, MESSAGE_DB_UNAVAILABLE)
  assert.equal((await service.getMessageDateCountsBatch(['friend'])).error, MESSAGE_DB_UNAVAILABLE)
  assert.equal(service.sessionMessageCountCache.size, 0)
})

test('manual refresh revalidates discovery rather than serving stale successful snapshot', async () => {
  const service = chatFixture()
  await service.getMessageDbCountSnapshot()
  service.listMessageDbPathsForCount = async () => ({ success: true, dbPaths: [] })
  assert.equal((await service.getSessionMessageCounts(['friend'], { bypassSessionCache: true })).success, false)
})

test('failed fallback count query is reported, never cached as zero', async () => {
  const service = chatFixture({ getMessageCounts: async () => ({ success: false, error: 'read failed' }) })
  const result = await service.getSessionMessageCounts(['friend'])
  assert.equal(result.success, false)
  assert.equal(result.error, 'read failed')
  assert.equal(service.sessionMessageCountCache.size, 0)
})

test('legitimate zero counts remain valid with a discovered message DB', async () => {
  const service = chatFixture({
    getMessageCounts: async () => ({ success: true, counts: { friend: 0 } }),
    getSessionMessageDateCountsBatch: async () => ({ success: true, data: { friend: {} } }),
  })
  assert.deepEqual(await service.getSessionMessageCounts(['friend']), { success: true, counts: { friend: 0 } })
  assert.deepEqual(await service.getMessageDateCountsBatch(['friend']), { success: true, data: { friend: {} } })
})

test('empty session selection does not require a message DB', async () => {
  const service = chatFixture()
  service.listMessageDbPathsForCount = () => assert.fail('no discovery needed')
  assert.deepEqual(await service.getSessionMessageCounts([]), { success: true, counts: {} })
  assert.deepEqual(await service.getMessageDateCountsBatch([]), { success: true, data: {} })
})

test('native message DB list rejects malformed payloads but preserves valid arrays', async () => {
  const core = new WcdbCore()
  core.ensureReady = () => true
  core.wcdbListMessageDbs = (_handle, out) => { out[0] = 'fake'; return 0 }
  for (const invalid of [{}, null, [null], [1], [' ']]) {
    core.decodeJsonPtr = () => JSON.stringify(invalid)
    assert.equal((await core.listMessageDbs()).success, false)
  }
  for (const valid of [[], ['message_0.db']]) {
    core.decodeJsonPtr = () => JSON.stringify(valid)
    assert.deepEqual(await core.listMessageDbs(), { success: true, data: valid })
  }
})

function diskFixture(t) {
  const tmp = path.join(root, 'tmp')
  fs.mkdirSync(tmp, { recursive: true })
  const dir = fs.mkdtempSync(path.join(tmp, 'message-db-test-'))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(dir)), fs.realpathSync(tmp))
    fs.rmSync(dir, { recursive: true })
  })
  fs.mkdirSync(path.join(dir, 'Message'))
  fs.mkdirSync(path.join(dir, 'Contact'))
  fs.writeFileSync(path.join(dir, 'Message/message_0.db'), 'not-message-content')
  fs.writeFileSync(path.join(dir, 'Message/message_0.db-wal'), 'wal')
  fs.writeFileSync(path.join(dir, 'Contact/contact.db'), 'contact')
  return dir
}

test('disk inventory contains relative metadata and distinguishes candidate shards', t => {
  const dir = diskFixture(t)
  const inventory = inspectMessageDbFiles(dir)
  assert.equal(inventory.files.length, 2)
  assert.equal(inventory.errors.length, 0)
  const candidate = inventory.files.find(file => file.candidate)
  assert.equal(candidate.path, path.join('Message', 'message_0.db'))
  assert.equal(candidate.walBytes, 3)
  assert.ok(!JSON.stringify(inventory).includes('not-message-content'))
  assert.ok(!JSON.stringify(inventory).includes(dir))
  assert.equal(inspectMessageDbFiles(path.join(dir, 'missing')).errors.length, 1)
})

test('post-open diagnostics probe schema at explicit disk paths when native discovery is empty', async t => {
  const dir = diskFixture(t)
  const core = new WcdbCore()
  const logs = [], queries = []
  core.writeLog = line => logs.push(line)
  core.listMessageDbs = async () => ({ success: true, data: [] })
  core.dumpDbStatus = async () => {}
  core.printLogs = async () => {}
  core.execQuery = async (kind, file, sql) => {
    queries.push({ kind, file, sql })
    return { success: true, rows: [{ cnt: 2 }] }
  }
  await core.runPostOpenDiagnostics('account', dir, 'session.db', 'account')
  const probe = queries.find(query => query.kind === 'message')
  assert.equal(probe.file, path.join(dir, 'Message/message_0.db'))
  assert.match(probe.sql, /sqlite_master/)
  assert.ok(logs.some(line => line.includes('[diag:message-db] native success=true count=0')))
  assert.ok(logs.some(line => line.includes('msgTables=2')))
})

// The released 1.2.0 UI previously swallowed both count/date failures.
if (path.basename(root) === '1.2.0') {
  function statsFixture(overrides) {
    const source = fs.readFileSync(path.join(root, 'src/slim/pages/StatsPage.tsx'), 'utf8')
    const head = source.slice(0, source.indexOf('export default function StatsPage'))
      .replace(/^import [^\r\n]*(?:\r?\n|$)/gm, '')
    const storage = new Map()
    const window = { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      electronAPI: { config: { get: async () => 'test' }, chat: {
        getSessions: async () => ({ success: true, sessions: [{ username: 'friend' }] }),
        getSessionMessageCounts: async () => ({ success: true, counts: { friend: 0 } }),
        getMessageDateCountsBatch: async () => ({ success: true, data: { friend: {} } }),
        ...overrides,
      } } }
    const exports = {}
    new Function('window', 'exports', transpile(head + '\nexport { loadStatsSnapshot }'))(window, exports)
    return { storage, load: exports.loadStatsSnapshot }
  }
  for (const method of ['getSessionMessageCounts', 'getMessageDateCountsBatch']) {
    test(`stats page propagates ${method} failure without persisting zeros`, async () => {
      const f = statsFixture({ [method]: async () => ({ success: false, error: 'database unavailable' }) })
      await assert.rejects(f.load(true, () => {}), /database unavailable/)
      assert.equal(f.storage.size, 0)
    })
  }
}
