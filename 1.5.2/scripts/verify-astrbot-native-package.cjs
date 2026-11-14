'use strict'
// Verify the actual packaged renderer and Bridge, including same-version rebuilds.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const asar = createRequire(require.resolve('app-builder-lib/package.json'))('@electron/asar')
const project = path.resolve(__dirname, '..')
const app = path.resolve(process.argv[2] || path.join(project, 'release/win-unpacked'))
const archive = path.join(app, 'resources/app.asar')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const entries = asar.listPackage(archive).map(name => name.replace(/^[/\\]/, '').replaceAll('\\', '/'))
const html = asar.extractFile(archive, 'dist/index.html').toString('utf8')
const scriptSrc = html.match(/<script\b[^>]*src="([^"]+)"/)
assert.ok(scriptSrc, 'Renderer entry is missing from packaged HTML')
const rendererPath = path.posix.normalize(path.posix.join('dist', scriptSrc[1]))
const renderer = asar.extractFile(archive, path.normalize(rendererPath)).toString('utf8')
assert.ok(renderer.includes('群消息始终逐条转发'), 'Packaged renderer does not contain native AstrBot behavior')
for (const old of ['按概率将普通消息推送给当前服务端', 'config.active_reply_enabled', '群聊回复由 AstrBot 控制', 'AstrBot 群聊控制', '会话过滤', '会话过滤模式', '已选择的会话', '手动输入会话 ID', 'force-push-triggers', '多个开头请用英文逗号分隔']) {
  assert.equal(renderer.includes(old), false, `Old active-reply controls remain in package: ${old}`)
}
let matchedBuildFiles = 0
function compareBuild(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`
    if (entry.isDirectory()) { compareBuild(path.join(dir,entry.name),rel); continue }
    if (rel.endsWith('.map')) continue
    assert.ok(entries.includes(rel), `Build artifact missing from archive: ${rel}`)
    assert.equal(sha256(asar.extractFile(archive,path.normalize(rel))), sha256(fs.readFileSync(path.join(dir,entry.name))), `Stale build artifact: ${rel}`)
    matchedBuildFiles++
  }
}
compareBuild(path.join(project,'dist'),'dist')
compareBuild(path.join(project,'dist-electron'),'dist-electron')
let matchedBridgeFiles = 0
for (const file of fs.readdirSync(path.join(project,'bridge')).filter(name => name.endsWith('.py'))) {
  const packed = path.join(app,'resources/bridge',file)
  assert.ok(fs.existsSync(packed), `Bridge module missing: ${file}`)
  assert.equal(sha256(fs.readFileSync(packed)),sha256(fs.readFileSync(path.join(project,'bridge',file))),`Stale Bridge module: ${file}`)
  matchedBridgeFiles++
}
assert.ok(fs.existsSync(path.join(app,'resources/bridge/astrbot_messages.py')))
console.log(JSON.stringify({passed:true,archive,rendererPath,matchedBuildFiles,matchedBridgeFiles,asarSha256:sha256(fs.readFileSync(archive))},null,2))
