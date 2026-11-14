const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const { DatabaseSync } = require('node:sqlite')
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText, filename)
}
const { getStatsDateRange, getStatsCacheKey, formatStatsDate } = require('../shared/stats-range.ts')
const { queryRangedMessageDateCounts } = require('../electron/services/messageDateStats.ts')

function dataFixture(t, overrides = {}) {
  delete require.cache[require.resolve('../src/slim/statsData.ts')]
  const calls = { sessions: [], counts: [], dates: [] }
  const storage = new Map()
  const sessions = [
    { username: 'busy@chatroom', displayName: '活跃群', messageCountHint: 100000 },
    { username: 'old@chatroom', displayName: '历史群', messageCountHint: 999999 },
    { username: 'friend', messageCountHint: 500 },
  ]
  const chat = {
    async getSessions(options) { calls.sessions.push(options); return { success: true, sessions } },
    async getSessionMessageCounts(ids, options) {
      calls.counts.push({ ids, options })
      return { success: true, counts: { 'busy@chatroom': 100000, 'old@chatroom': 999999, friend: 500 } }
    },
    async getMessageDateCountsBatch(ids, range) {
      calls.dates.push({ ids, range })
      const date = formatStatsDate(new Date())
      const all = {
        'busy@chatroom': { [date]: 3 },
        'old@chatroom': range ? {} : { '2020-01-01': 999999 },
        friend: { [date]: 2 },
      }
      return { success: true, data: Object.fromEntries(ids.map(id => [id, all[id] || {}])) }
    },
    ...overrides,
  }
  const previousWindow = global.window
  global.window = {
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    electronAPI: { config: { get: async key => key === 'dbPath' ? 'test-db' : 'test-account' }, chat },
  }
  t.after(() => { global.window = previousWindow })
  return { ...require('../src/slim/statsData.ts'), calls, storage, sessions, chat }
}

test('30-day range includes today, uses local calendar days, and all history stays unbounded', () => {
  for (const now of [new Date(2026, 8, 14, 12, 34, 56), new Date(2026, 0, 5, 0, 0, 0), new Date(2024, 2, 1, 9)]) {
    const range = getStatsDateRange('recent30', now)
    const expected = new Date(now)
    expected.setHours(0, 0, 0, 0)
    expected.setDate(expected.getDate() - 29)
    assert.equal(range.beginTimestamp, expected.getTime() / 1000)
    assert.equal(range.endTimestamp, Math.floor(now.getTime() / 1000) + 1)
    assert.equal(getStatsDateRange('all', now), undefined)
  }
})

test('cache keys separate account, database, scope and each new local day', () => {
  const now = new Date(2026, 8, 14, 12)
  const key = getStatsCacheKey('db', 'wx', 'recent30', now)
  for (const other of [
    getStatsCacheKey('db2', 'wx', 'recent30', now), getStatsCacheKey('db', 'wx2', 'recent30', now),
    getStatsCacheKey('db', 'wx', 'all', now), getStatsCacheKey('db', 'wx', 'recent30', new Date(2026, 8, 15)),
  ]) assert.notEqual(key, other)
})

test('real SQLite applies indexed bounds before aggregation, merges shards and escapes identifiers', async t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE "Msg_""quoted" (create_time INTEGER); CREATE INDEX time_idx ON "Msg_""quoted"(create_time);')
  const range = getStatsDateRange('recent30', new Date(2026, 8, 14, 12))
  const insert = db.prepare('INSERT INTO "Msg_""quoted" VALUES (?)')
  for (const value of [range.beginTimestamp - 1, range.beginTimestamp, range.endTimestamp - 1, range.endTimestamp]) insert.run(value)
  const queries = []
  const metadata = { table_name: 'Msg_"quoted', db_path: 'shard1' }
  const database = {
    async getMessageTables() { return { success: true, tables: [metadata, metadata, { ...metadata, db_path: 'shard2' }] } },
    async execQuery(kind, path, sql) {
      assert.equal(kind, 'message')
      queries.push({ path, sql })
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail).join(' ')
      assert.match(plan, /SEARCH.*time_idx.*create_time>\?.*create_time<\?/)
      return { success: true, rows: db.prepare(sql).all() }
    },
  }
  const result = await queryRangedMessageDateCounts(database, ['group'], range)
  assert.equal(queries.length, 2, 'duplicate metadata must not double-count a shard')
  assert.equal(Object.values(result.group).reduce((sum, count) => sum + count, 0), 4)
  assert.equal(result.group[formatStatsDate(new Date(range.beginTimestamp * 1000))], 2)
  assert.equal(result.group[formatStatsDate(new Date((range.endTimestamp - 1) * 1000))], 2)
})

test('invalid ranges fail before database access; query errors never turn into zero counts', async () => {
  const database = { getMessageTables() { throw new Error('should not query') } }
  for (const range of [null, {}, { beginTimestamp: NaN, endTimestamp: 100 }, { beginTimestamp: 100, endTimestamp: 100 }, { beginTimestamp: '1 OR 1=1', endTimestamp: 100 }]) {
    await assert.rejects(queryRangedMessageDateCounts(database, ['group'], range), /时间范围无效/)
  }
  const range = { beginTimestamp: 100, endTimestamp: 200 }
  await assert.rejects(queryRangedMessageDateCounts({ getMessageTables: async () => ({ success: false, error: 'metadata failed' }) }, ['group'], range), /metadata failed/)
  await assert.rejects(queryRangedMessageDateCounts({
    getMessageTables: async () => ({ success: true, tables: [{ table_name: 'Msg_a', db_path: 'shard' }] }),
    execQuery: async () => ({ success: false, error: 'query failed' }),
  }, ['group'], range), /query failed/)
})

test('sessions without message tables produce empty counts', async () => {
  const data = await queryRangedMessageDateCounts({ getMessageTables: async () => ({ success: true, tables: [] }) }, ['empty'], { beginTimestamp: 100, endTimestamp: 200 })
  assert.deepEqual(data, { empty: {} })
})

test('quick mode skips all-history totals and synthetic unread stats; ranking uses only recent counts', async t => {
  const f = dataFixture(t)
  const progress = []
  const snapshot = await f.loadStatsSnapshot('recent30', false, value => progress.push(value))
  assert.deepEqual(f.calls.sessions, [{ skipMessageStats: true }])
  assert.equal(f.calls.counts.length, 0)
  assert.ok(f.calls.dates[0].range.beginTimestamp > 0)
  assert.equal(snapshot.totalMessages, 5)
  assert.equal(snapshot.groupCount, 1)
  assert.deepEqual(snapshot.groups, [{ name: '活跃群', count: 3 }])
  assert.equal(progress.at(-1).percent, 100)
})

test('all-history mode preserves totals and never reuses quick cache; each scope is cached independently', async t => {
  const f = dataFixture(t)
  const quick = await f.loadStatsSnapshot('recent30', false, () => {})
  const full = await f.loadStatsSnapshot('all', false, () => {})
  assert.equal(full.totalMessages, 1100499)
  assert.equal(full.groupCount, 2)
  assert.equal(full.groups[0].name, '历史群')
  assert.equal(f.calls.dates[1].range, undefined)
  assert.equal(await f.loadStatsSnapshot('recent30', false, () => {}), quick)
  assert.equal(await f.loadStatsSnapshot('all', false, () => {}), full)
  assert.equal(f.calls.dates.length, 2)
  assert.equal(f.storage.size, 2)
  await f.loadStatsSnapshot('recent30', true, () => {})
  assert.equal(f.calls.dates.length, 3)
  assert.equal(f.calls.counts.length, 1)
})

test('range queries are batched and expose per-batch progress', async t => {
  const f = dataFixture(t)
  f.sessions.splice(0, f.sessions.length, ...Array.from({ length: 45 }, (_, i) => ({ username: `group${i}@chatroom` })))
  const progress = []
  await f.loadStatsSnapshot('recent30', true, value => progress.push(value))
  assert.deepEqual(f.calls.dates.map(call => call.ids.length), [20, 20, 5])
  assert.ok(progress.some(value => value.detail === '已处理 20/45 个会话'))
  assert.ok(progress.every(value => value.scope === 'recent30'))
})

test('concurrent same-scope loads share work and scope listeners do not receive other jobs', async t => {
  const f = dataFixture(t)
  const events = []
  const unsubscribe = f.subscribeStatsProgress('recent30', value => events.push(value))
  const [a, b] = await Promise.all([f.loadStatsSnapshot('recent30', true, () => {}), f.loadStatsSnapshot('recent30', true, () => {})])
  assert.equal(a, b)
  assert.equal(f.calls.dates.length, 1)
  const previousCount = events.length
  await f.loadStatsSnapshot('all', true, () => {})
  assert.equal(events.length, previousCount)
  unsubscribe()
})

test('failed/incomplete statistics are not cached and can be retried', async t => {
  const f = dataFixture(t, { getMessageDateCountsBatch: async () => ({ success: false, error: 'offline' }) })
  await assert.rejects(f.loadStatsSnapshot('recent30', false, () => {}), /offline/)
  assert.equal(f.storage.size, 0)
  f.chat.getMessageDateCountsBatch = async () => ({ success: true, data: {} })
  await assert.rejects(f.loadStatsSnapshot('recent30', false, () => {}), /不完整/)
  assert.equal(f.storage.size, 0)
  f.chat.getMessageDateCountsBatch = async ids => ({ success: true, data: Object.fromEntries(ids.map(id => [id, {}])) })
  const result = await f.loadStatsSnapshot('recent30', false, () => {})
  assert.equal(result.totalMessages, 0)
  assert.equal(f.storage.size, 1)
})

test('empty session lists succeed without querying dates or dividing progress by zero', async t => {
  const f = dataFixture(t)
  f.sessions.length = 0
  const result = await f.loadStatsSnapshot('recent30', true, value => assert.ok(Number.isFinite(value.percent)))
  assert.equal(result.totalMessages, 0)
  assert.equal(result.groupCount, 0)
  assert.equal(f.calls.dates.length, 0)
})

test('WCDB range dispatch never invokes the native all-history counter', async () => {
  const { WcdbCore } = require('../electron/services/wcdbCore.ts')
  const core = new WcdbCore()
  core.ensureReady = () => true
  let nativeCalls = 0
  core.wcdbGetSessionMessageDateCountsBatch = (_handle, _ids, out) => { nativeCalls++; out[0] = 'fake'; return 0 }
  core.decodeJsonPtr = () => JSON.stringify({ group: { '2020-01-01': 900 } })
  core.getMessageTables = async () => ({ success: true, tables: [] })
  const recent = await core.getSessionMessageDateCountsBatch(['group', 'group'], { beginTimestamp: 100, endTimestamp: 200 })
  assert.deepEqual(recent, { success: true, data: { group: {} } })
  assert.equal(nativeCalls, 0)
  const all = await core.getSessionMessageDateCountsBatch(['group'])
  assert.equal(nativeCalls, 1)
  assert.equal(all.data.group['2020-01-01'], 900)
  const invalid = await core.getSessionMessageDateCountsBatch(['group'], { beginTimestamp: 200, endTimestamp: 100 })
  assert.equal(invalid.success, false)
  assert.equal(nativeCalls, 1)
})
