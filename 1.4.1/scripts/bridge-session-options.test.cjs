const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText, filename)
}
const { buildSessionOptions } = require('../src/slim/pages/bridgeSessionOptions.ts')
const { sessionDisplayName } = require('../shared/session-display-name.ts')

test('session picker includes private, group and non-wxid sessions with stable IDs', () => {
  const options = buildSessionOptions([
    { username: 'g@chatroom', displayName: '群A' },
    { username: 'wxid_friend', displayName: '好友A' },
    { username: '1234567', displayName: '旧账号' }
  ])
  assert.deepEqual(options.map(x => [x.id, x.kind]), [
    ['g@chatroom', 'group'], ['wxid_friend', 'private'], ['1234567', 'private']
  ])
})
test('contact enrichment replaces raw IDs and stale cached names', () => {
  const options = buildSessionOptions([{ username: 'wxid_friend', displayName: 'wxid_friend' }], {
    wxid_friend: { displayName: '好友备注' }
  })
  assert.equal(options[0].name, '好友备注')
  assert.equal(options[0].id, 'wxid_friend')
  assert.equal(sessionDisplayName('id', '新备注', '旧昵称'), '新备注')
})
test('missing contact names keep IDs, never latest message summaries', () => {
  const options = buildSessionOptions([{ username: 'wxid_friend', summary: '[消息]' }])
  assert.equal(options[0].name, 'wxid_friend')
  assert.equal(sessionDisplayName('id', 'id', '缓存昵称'), '缓存昵称')
})
test('empty IDs are excluded and repeated IDs deduplicated, same-name sessions retained', () => {
  const options = buildSessionOptions([{ username: '' }, { username: 'a', displayName: '同名' },
    { username: 'b', displayName: '同名' }, { username: ' a ', displayName: '同名' }])
  assert.deepEqual(options.map(x => x.id), ['a', 'b'])
})
test('empty list and partial enrichment remain selectable', () => {
  assert.deepEqual(buildSessionOptions([]), [])
  const options = buildSessionOptions([{ username: 'a' }, { username: 'b' }], { a: { displayName: '备注' } })
  assert.deepEqual(options.map(x => x.name), ['备注', 'b'])
})
test('message and revoke pushes share meaningful-name resolution for private and group sessions', () => {
  const source = fs.readFileSync(require.resolve('../electron/services/messagePushService.ts'), 'utf8')
  assert.equal((source.match(/sessionDisplayName\(sessionId, contactInfo\?\.displayName, session\.displayName\)/g) || []).length, 2)
  assert.equal((source.match(/sessionDisplayName\(sessionId, groupInfo\?\.displayName, session\.displayName\)/g) || []).length, 2)
  assert.equal(sessionDisplayName('wxid_friend', '好友备注', 'wxid_friend'), '好友备注')
})
