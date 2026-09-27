const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  })
  module._compile(result.outputText, filename)
}
const { normalizeLocalCommandConfig, isLocalAdminUid, AW_ATTACHMENT_LABEL } = require('../shared/local-commands.ts')
const { requiresBridgeRestart } = require('../shared/bridge-connection.ts')
const defaults = require('../shared/bridge-default-config.json')
const uid = 'AW-0123456789ABCDEF01234567'

test('legacy config has no implicitly authorized administrator', () => {
  assert.deepEqual(normalizeLocalCommandConfig({}), {
    local_command_admins: [],
    ac_cache_hours: 24, ac_file_max_mb: 100, ac_cache_max_mb: 512
  })
  assert.deepEqual(normalizeLocalCommandConfig(defaults).local_command_admins, [])
})
test('administrator IDs are normalized, validated, deduplicated and notes bounded', () => {
  const actual = normalizeLocalCommandConfig({ local_command_admins: [
    { uid: ` ${uid.toLowerCase()} `, note: '我的微信' }, uid, null, { uid: 'wxid_raw', note: 'not valid' },
    { uid: 'AW-111111111111111111111111', note: 'x'.repeat(200) }
  ] })
  assert.equal(actual.local_command_admins.length, 2)
  assert.deepEqual(actual.local_command_admins[0], { uid, note: '我的微信' })
  assert.equal(actual.local_command_admins[1].note.length, 80)
  assert.equal(isLocalAdminUid(uid), true)
  assert.equal(isLocalAdminUid('AW-short'), false)
})
test('legacy selectable labels are ignored and output wording is fixed', () => {
  const actual = normalizeLocalCommandConfig({ local_attachment_label: '附件码' })
  assert.equal(Object.hasOwn(actual, 'local_attachment_label'), false)
  assert.equal(AW_ATTACHMENT_LABEL, '回溯码')
})
test('cache limits are finite positive bounded integers', () => {
  const actual = normalizeLocalCommandConfig({ ac_cache_hours: -5, ac_file_max_mb: Infinity, ac_cache_max_mb: 100000 })
  assert.equal(actual.ac_cache_hours, 1)
  assert.equal(actual.ac_file_max_mb, 100)
  assert.equal(actual.ac_cache_max_mb, 4096)
  assert.equal(normalizeLocalCommandConfig({ ac_cache_hours: 1.9 }).ac_cache_hours, 1)
})
test('administrator and cache edits do not restart the bridge', () => {
  assert.equal(requiresBridgeRestart(defaults, { ...defaults, local_command_admins: [{ uid, note: '' }], ac_cache_hours: 3 }), false)
})
test('private cached attachments are excluded from packaged bridge resources', () => {
  const packageInfo = require('../package.json')
  const bridge = packageInfo.build.extraResources.find(resource => resource.from === 'bridge')
  assert.ok(bridge.filter.includes('!aw-ac-cache{,/**/*}'))
})
