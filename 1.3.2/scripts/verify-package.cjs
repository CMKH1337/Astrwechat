'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
// Use the ASAR implementation belonging to electron-builder, not a global tool.
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const asar = builderRequire('@electron/asar')
const manifest = require('../package.json')

const excludedPackages = [
  'echarts', 'echarts-for-react', 'lucide-react', 'react', 'react-dom',
  'react-router-dom', 'wechat-emojis', 'exceljs', 'html2canvas', 'jieba-wasm',
  'jszip', 'react-markdown', 'react-virtuoso', 'remark-gfm', 'sherpa-onnx-node', 'zustand',
]

function directoryBytes(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const filename = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link in package: ${filename}`)
    return total + (entry.isDirectory() ? directoryBytes(filename) : fs.statSync(filename).size)
  }, 0)
}

function verifyWindowsPackage(appOutDir, arch = 'x64') {
  const resources = path.join(appOutDir, 'resources')
  const archive = path.join(resources, 'app.asar')
  const errors = []
  const entries = new Set(asar.listPackage(archive).map(name => name.replace(/\\/g, '/').replace(/^\//, '')))
  const requireFile = relative => {
    const filename = path.join(appOutDir, relative)
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile() || fs.statSync(filename).size === 0) {
      errors.push(`Missing/empty runtime file: ${relative}`)
    }
  }
  const requireArchivedFile = relative => {
    if (!entries.has(relative)) errors.push(`Missing ASAR entry: ${relative}`)
  }

  requireFile(`${manifest.build.win.executableName}.exe`)
  if (arch !== 'x64') errors.push(`Unverified AstrWeChat WCDB architecture: ${arch}`)
  else {
    try {
      require('./wcdb-host-branding.cjs').assertBrandedDll(path.join(resources, 'resources', 'wcdb', 'win32', arch, 'wcdb_api.dll'))
    } catch (error) { errors.push(error.message) }
  }

  requireArchivedFile('package.json')
  const packagedManifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  if (packagedManifest.name !== manifest.name || packagedManifest.version !== manifest.version) {
    errors.push('Packaged application identity/version does not match package.json')
  }
  requireArchivedFile('dist/index.html')
  for (const name of ['main', 'preload', 'wcdbWorker', 'imageDecryptWorker', 'apiMessageWorker']) {
    requireArchivedFile(`dist-electron/${name}.js`)
  }
  for (const name of Object.keys(manifest.dependencies)) {
    requireArchivedFile(`node_modules/${name}/package.json`)
  }
  for (const name of entries) {
    if (name.endsWith('.map')) errors.push(`Source map leaked into ASAR: ${name}`)
    if (excludedPackages.some(pkg => name === `node_modules/${pkg}` || name.startsWith(`node_modules/${pkg}/`)) ||
        /^node_modules\/sherpa-onnx-/.test(name)) {
      errors.push(`Build-only/unused dependency leaked into ASAR: ${name}`)
      break
    }
  }

  const koffiBinary = [...entries].find(name =>
    /^node_modules\/(?:@koromix\/koffi-[^/]+|koffi)\//.test(name) &&
    name.endsWith('/koffi.node') && name.includes(`win32_${arch}`))
  if (!koffiBinary) errors.push('Missing Koffi native binding for target architecture')
  else requireFile(`resources/app.asar.unpacked/${koffiBinary}`)

  for (const name of ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) requireFile(name)
  for (const name of ['WCDB.dll', 'wcdb_api.dll', 'SDL2.dll']) requireFile(`resources/resources/wcdb/win32/${arch}/${name}`)
  requireFile(`resources/resources/welive/win32/${arch}/welive.exe`)
  requireFile('resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe')
  requireFile('resources/app.asar.unpacked/node_modules/silk-wasm/lib/silk.wasm')
  requireFile('resources/assets/wasm/wasm_video_decode.wasm')
  requireFile('resources/bridge/main.py')
  if (fs.existsSync(path.join(resources, 'resources/fonts/annual-report'))) errors.push('Unused annual-report fonts were packaged')

  const expectedLocales = manifest.build.win.electronLanguages.map(name => `${name}.pak`).sort()
  const localesDir = path.join(appOutDir, 'locales')
  const locales = fs.existsSync(localesDir) ? fs.readdirSync(localesDir).filter(name => name.endsWith('.pak')).sort() : []
  if (JSON.stringify(locales) !== JSON.stringify(expectedLocales)) errors.push(`Unexpected Electron locales: ${locales.join(', ')}`)
  for (const locale of expectedLocales) requireFile(`locales/${locale}`)

  const bridge = path.join(resources, 'bridge')
  if (fs.existsSync(bridge)) {
    const walk = (dir, relative = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name
        if (name === 'config.json' || /(^|\/)(__pycache__)(\/|$)/.test(name) ||
            /^(data|cache)(\/|$)/.test(name) || /\.(log|pyc|pyo)$/.test(name)) {
          errors.push(`Private/generated bridge data leaked into package: ${name}`)
        }
        if (entry.isDirectory()) walk(path.join(dir, entry.name), name)
      }
    }
    walk(bridge)
  }
  if (errors.length) throw new Error(`Package verification failed:\n${errors.join('\n')}`)
  const bytes = directoryBytes(appOutDir)
  console.log(`[verify-package] Runtime files and packaging exclusions verified; unpacked ${(bytes / 1048576).toFixed(1)} MiB, ASAR ${(fs.statSync(archive).size / 1048576).toFixed(1)} MiB`)
  return { bytes, locales }
}

module.exports = { verifyWindowsPackage, excludedPackages }

if (require.main === module) {
  try {
    verifyWindowsPackage(path.resolve(process.argv[2] || path.join(__dirname, '../release/win-unpacked')), process.argv[3] || 'x64')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
