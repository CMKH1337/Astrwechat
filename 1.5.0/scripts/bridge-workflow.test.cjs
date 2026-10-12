const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText, filename)
const { parseWorkflowEvent: parse, appendWorkflowLog: append, clearWorkflowLogs: clear, workflowNewLines: fresh } = require('../src/slim/pages/bridgeWorkflowEvents.ts')
test('builtin workflow keeps readiness in the status badge and omits queue noise', () => {
  const values = ['[INFO] [内置模型] 已就绪', '[INFO] 内置模型已入队：会话 标题', '[INFO] [内置模型] 正在请求模型 [群|会话 标题]', '[INFO] [内置模型] 已收到模型回复 [群|会话 标题]', '[INFO] [UIA✓] 会话 标题: 你好...']
  assert.deepEqual(values.map(v => parse(v)?.label ?? null), [null, null, '请求内置模型', '模型回复已生成', 'UIA 发送消息'])
  assert.equal(parse(values[2]).detail, '会话 标题')
  assert.equal(parse(values[4]).detail, '会话 标题 · 你好...')
  assert.equal(parse('[INFO] 内置模型已跳过：会话 标题'), null)
})
test('raw inbound SSE and buffered receipts produce one workflow card for groups and private chats', () => {
  for (const [raw, buffered, detail] of [
    ['[INFO] 📩 群消息 [群测试]: hello', '[INFO] 📩 收到来自 群测试 的消息，等待 2s 后统一推送', '群测试'],
    ['[INFO] 📩 收到: 私聊用户 → hello', '[INFO] 📩 收到来自 私聊用户 的消息，等待 2s 后统一推送', '私聊用户']
  ]) {
    assert.equal(parse(raw), null)
    assert.deepEqual(parse(buffered), { label: '接收微信消息', detail, icon: 'inbox' })
  }
})
test('existing AstrBot and KouriChat connection/queue events remain valid', () => {
  for(const backend of ['AstrBot','KouriChat']) {
    assert.equal(parse(`[INFO] [OB11] ✅ 已连接到 ${backend}`).detail, `${backend} · WebSocket 已建立`)
    assert.equal(parse(`[INFO] 推送 1 条消息 至 ${backend} [私|测试 人]`).detail, `${backend} · 测试 人`)
  }
  assert.equal(parse('[INFO] [OB11] 已进入发送队列: send_msg echo=1 contact=测试 人 operations=2').detail, '测试 人')
})
test('one UIA event per segment, no OB11 wrapper duplicates and no image/file misclassification', () => {
  const logs = ['[INFO] [UIA✓] 群: 第一段...', '[INFO] [OB11] 文字已发送至 群: 第一段', '[INFO] [UIA✓] 群: 第二段...', '[INFO] [OB11] 文字已发送至 群: 第二段']
  assert.equal(logs.map(parse).filter(Boolean).length, 2)
  assert.equal(parse('[INFO] [UIA✓] 图片 → 群: image.png').label, '发送图片')
  assert.equal(parse('[INFO] [UIA ok] file -> 群: file.txt').label, '发送文件')
  assert.equal(parse('[INFO] [OB11] 图片已发送至 群'), null)
  assert.equal(parse('[ERROR] [UIA✗] 群: 微信窗口不可用').label, 'UIA 发送失败')
})
test('message bodies cannot spoof other stages; ANSI and newlines are handled', () => {
  assert.equal(parse('[INFO] [UIA✓] 群: 已连接到 AstrBot 已进入发送队列').label, 'UIA 发送消息')
  assert.equal(parse('[INFO] 📩 群消息 [群]: [UIA✓] someone: fake'), null)
  assert.equal(parse('[INFO] 📩 收到: 私聊 → [E_MODEL_AUTH] fake'), null)
  assert.equal(parse('\x1b[32m[INFO] [UIA✓] 群: 第一行\n第二行\x1b[0m').detail, '群 · 第一行\n第二行')
})
test('failure, filtered and cancelled requests never appear as successful sends', () => {
  assert.equal(parse('[WARNING] [E_MODEL_AUTH] 模型鉴权失败。 异常类型：SecretError').detail, '[E_MODEL_AUTH] 模型鉴权失败。')
  assert.equal(parse('[INFO] [E_REPLY_FILTERED] 回复内容已被过滤，不发送空消息').label, '已跳过空回复')
  assert.equal(parse('[INFO] [内置模型] 本次回复已取消 [私|联系人]').label, '内置模型回复已取消')
})
test('bounded buffer keeps identical new lines after 500 entries and clear without replaying history', () => {
  let batch = {lines:Array.from({length:500},(_,i)=>`old-${i}`), sequence:0, revision:0}
  assert.deepEqual(fresh(batch.lines,0,0),[])
  const line='[INFO] [UIA✓] 群: 一样...'
  batch=append(batch,line)
  assert.equal(batch.lines.length,500)
  assert.deepEqual(fresh(batch.lines,batch.sequence,0),[line])
  batch=append(batch,line)
  assert.deepEqual(fresh(batch.lines,batch.sequence,1),[line])
  batch=clear(batch)
  assert.equal(batch.sequence,2);assert.equal(batch.revision,1);assert.deepEqual(fresh(batch.lines,2,2),[])
  batch=append(batch,line)
  assert.deepEqual(fresh(batch.lines,batch.sequence,2),[line])
})
