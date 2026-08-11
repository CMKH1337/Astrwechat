'use strict'

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const packagePath = path.join(root, 'package.json')
const mainPath = path.join(root, 'electron', 'main.ts')
const identityPath = path.join(root, 'electron', 'appIdentity.ts')
const runtimeEnvPath = path.join(root, 'electron', 'runtime-env.ts')

function fail(messages) {
  console.error('[verify-runtime-identity] WCDB 兼容身份检查失败：')
  for (const message of messages) console.error(`  - ${message}`)
  console.error('[verify-runtime-identity] 已停止启动，避免错误使用 %APPDATA%\\astrwechat 并触发 wcdb_init -1006。')
  process.exit(1)
}

const missing = [packagePath, mainPath, identityPath, runtimeEnvPath].filter((file) => !fs.existsSync(file))
if (missing.length > 0) fail(missing.map((file) => `缺少文件：${file}`))

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8').replace(/^\uFEFF/, ''))
const main = fs.readFileSync(mainPath, 'utf8')
const identity = fs.readFileSync(identityPath, 'utf8')
const issues = []

if (String(pkg.name || '').toLowerCase() !== 'weflow') {
  issues.push(`package.json 的内部 name 必须为 weflow，当前为 ${JSON.stringify(pkg.name)}`)
}
if (pkg.build?.productName !== 'AstrWeChat') {
  issues.push(`build.productName 必须保持 AstrWeChat，当前为 ${JSON.stringify(pkg.build?.productName)}`)
}

const identityImport = main.indexOf("import './appIdentity'")
const firstServiceImport = main.indexOf("from './services/")
if (identityImport < 0) {
  issues.push("electron/main.ts 缺少 import './appIdentity'")
} else if (firstServiceImport >= 0 && identityImport > firstServiceImport) {
  issues.push('electron/main.ts 必须在加载 services 之前导入 appIdentity')
}
if (/app\.setName\(\s*['\"]AstrWeChat['\"]\s*\)/.test(main + '\n' + identity)) {
  issues.push("禁止把 Electron 内部名称设置为 AstrWeChat；展示名应只由 build.productName/UI 提供")
}
if (!/app\.setName\(\s*['\"]WeFlow['\"]\s*\)/.test(identity)) {
  issues.push("electron/appIdentity.ts 缺少 app.setName('WeFlow')")
}
const definesLegacyUserData = /join\(\s*app\.getPath\(\s*['\"]appData['\"]\s*\)\s*,\s*['\"]weflow['\"]\s*\)/.test(identity)
const appliesLegacyUserData = /app\.setPath\(\s*['\"]userData['\"]\s*,\s*legacyUserDataPath\s*\)/.test(identity)
if (!definesLegacyUserData || !appliesLegacyUserData) {
  issues.push("electron/appIdentity.ts 没有把 userData 固定到 appData/weflow")
}
for (const variable of ['WEFLOW_PROJECT_NAME', 'WEFLOW_USER_DATA_PATH', 'WEFLOW_CONFIG_CWD']) {
  if (!identity.includes(variable)) issues.push(`electron/appIdentity.ts 缺少 ${variable}`)
}

if (issues.length > 0) fail(issues)

console.log('[verify-runtime-identity] verified appName=WeFlow userData=%APPDATA%\\weflow productName=AstrWeChat')
