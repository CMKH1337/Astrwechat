'use strict'

const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const electron = process.platform === 'win32'
  ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(root, 'node_modules', '.bin', 'electron')
const probe = path.join(root, 'scripts', 'wcdb-probe.cjs')
const dllDir = path.join(root, 'resources', 'wcdb', 'win32', 'x64')
const dllNames = ['wcdb_api.dll', 'WCDB.dll', 'SDL2.dll']

function sha256(filePath) {
  if (!fs.existsSync(filePath)) return 'MISSING'
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase()
}

function run(context) {
  const env = { ...process.env, PROBE_CONTEXT: context, NODE_ENV: 'production', WEFLOW_FORCE_PRODUCTION: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(electron, [probe], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  const resultLine = output.split(/\r?\n/).find((line) => line.includes('"initProtection"')) || ''
  console.log(`\n===== ${context} =====`)
  if (resultLine) console.log(resultLine.trim())
  else console.log(output.trim() || `[probe exited without output, code=${result.status}]`)
  if (result.status !== 0 && output && resultLine) console.log(output.trim())
  return { status: result.status, output, resultLine }
}

console.log('WCDB 原生初始化诊断')
console.log(`project=${root}`)
console.log(`electron=${electron}`)
console.log(`node=${process.version} os=${os.platform()} ${os.release()} arch=${os.arch()}`)
console.log(`PROCESSOR_ARCHITECTURE=${process.env.PROCESSOR_ARCHITECTURE || ''}`)
console.log(`PROCESSOR_ARCHITEW6432=${process.env.PROCESSOR_ARCHITEW6432 || ''}`)
console.log(`USERNAME=${process.env.USERNAME || ''}`)
console.log(`COMPUTERNAME=${process.env.COMPUTERNAME || ''}`)
console.log(`timezone=${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
for (const name of dllNames) {
  const filePath = path.join(dllDir, name)
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null
  const motw = fs.existsSync(`${filePath}:Zone.Identifier`)
  console.log(`${name}: size=${stat?.size || 0} sha256=${sha256(filePath)} motw=${motw ? 'yes' : 'no'}`)
}

const main = run('main')
const worker = run('worker')
const bundledWorker = run('bundled-worker')
const ok = main.status === 0 && worker.status === 0 && bundledWorker.status === 0 &&
  /"initProtection":0,"wcdbInit":0/.test(main.resultLine) &&
  /"initProtection":0,"wcdbInit":0/.test(worker.resultLine) &&
  /"initProtection":0,"wcdbInit":0/.test(bundledWorker.resultLine)
console.log(`\n结论=${ok ? 'PASS：主进程、普通 Worker 和正式构建 Worker 均可初始化 WCDB' : 'FAIL：至少一个运行上下文无法通过 WCDB 初始化'}`)
if (!ok) {
  console.log('请把本段完整输出发回；bundled-worker 使用的就是正式应用构建后的 WCDB Worker。')
}
process.exit(ok ? 0 : 1)
