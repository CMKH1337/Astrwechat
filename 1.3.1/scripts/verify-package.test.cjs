'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const asar = createRequire(require.resolve('app-builder-lib/package.json'))('@electron/asar')
const manifest = require('../package.json')
const lock = require('../package-lock.json')
const { verifyWindowsPackage, excludedPackages } = require('./verify-package.cjs')

function write(root, name, content = 'fixture') {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

async function fixture(t, extraArchiveFiles = []) {
  const tempRoot = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(tempRoot, 'astrwechat-packaging-'))
  t.after(() => {
    const resolved = fs.realpathSync(root)
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('astrwechat-packaging-')) {
      throw new Error(`Refusing cleanup outside test workspace: ${resolved}`)
    }
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  const source = path.join(root, 'source')
  const output = path.join(root, 'app')
  write(source, 'package.json', JSON.stringify(manifest))
  write(source, 'dist/index.html')
  for (const name of ['main', 'preload', 'wcdbWorker', 'imageDecryptWorker', 'apiMessageWorker']) write(source, `dist-electron/${name}.js`)
  for (const name of Object.keys(manifest.dependencies)) write(source, `node_modules/${name}/package.json`, '{}')
  write(source, 'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node')
  for (const name of extraArchiveFiles) write(source, name)
  for (const name of ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) write(output, name)
  for (const name of ['WCDB.dll', 'wcdb_api.dll', 'SDL2.dll']) write(output, `resources/resources/wcdb/win32/x64/${name}`)
  write(output, `${manifest.build.win.executableName}.exe`)
  const originalDll = fs.readFileSync(path.join(__dirname, '../resources/wcdb/win32/x64/wcdb_api.dll'))
  fs.writeFileSync(path.join(output, 'resources/resources/wcdb/win32/x64/wcdb_api.dll'), require('./wcdb-host-branding.cjs').adaptBuffer(originalDll).buffer)
  write(output, 'resources/resources/welive/win32/x64/welive.exe')
  write(output, 'resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe')
  write(output, 'resources/app.asar.unpacked/node_modules/silk-wasm/lib/silk.wasm')
  write(output, 'resources/assets/wasm/wasm_video_decode.wasm')
  write(output, 'resources/bridge/main.py')
  for (const name of manifest.build.win.electronLanguages) write(output, `locales/${name}.pak`)
  await asar.createPackageWithOptions(source, path.join(output, 'resources/app.asar'), { unpack: '**/*.node' })
  return output
}

test('lockfile matches dependency classification and unused packages are removed', () => {
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies)
  assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies)
  for (const name of excludedPackages) assert.equal(manifest.dependencies[name], undefined, name)
  for (const name of ['echarts', 'lucide-react', 'react', 'react-dom', 'react-router-dom']) {
    assert.ok(manifest.devDependencies[name], name)
    assert.equal(lock.packages[`node_modules/${name}`].dev, true, name)
  }
  for (const name of ['exceljs', 'jieba-wasm', 'sherpa-onnx-node']) assert.equal(lock.packages[`node_modules/${name}`], undefined, name)
})

test('accepts a complete slim Windows package', async t => {
  const result = verifyWindowsPackage(await fixture(t))
  assert.ok(result.bytes > 0)
  assert.equal(result.locales.length, 3)
})

test('rejects missing FFmpeg instead of silently shipping broken image conversion', async t => {
  const root = await fixture(t)
  fs.unlinkSync(path.join(root, 'resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe'))
  assert.throws(() => verifyWindowsPackage(root), /Missing\/empty runtime file:.*ffmpeg\.exe/)
})

test('rejects renderer dependencies accidentally included a second time', async t => {
  const root = await fixture(t, ['node_modules/echarts/package.json'])
  assert.throws(() => verifyWindowsPackage(root), /unused dependency leaked/)
})

test('rejects source maps', async t => {
  const root = await fixture(t, ['dist-electron/main.js.map'])
  assert.throws(() => verifyWindowsPackage(root), /Source map leaked/)
})

test('rejects private bridge configuration and nested Python caches', async t => {
  const root = await fixture(t)
  write(root, 'resources/bridge/config.json', '{"token":"fixture"}')
  write(root, 'resources/bridge/nested/__pycache__/main.pyc')
  assert.throws(() => verifyWindowsPackage(root), /Private\/generated bridge data leaked/)
})

test('rejects surplus language packs and unused report fonts', async t => {
  const root = await fixture(t)
  write(root, 'locales/fr.pak')
  write(root, 'resources/resources/fonts/annual-report/font.ttf')
  assert.throws(() => verifyWindowsPackage(root), /Unused annual-report fonts[\s\S]*Unexpected Electron locales/)
})


test('rejects missing unpacked Koffi native binding', async t => {
  const root = await fixture(t)
  fs.unlinkSync(path.join(root, 'resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node'))
  assert.throws(() => verifyWindowsPackage(root), /Missing\/empty runtime file:.*koffi\.node/)
})

test('rejects an unadapted WCDB DLL before shipping AstrWeChat.exe', async t => {
  const root = await fixture(t)
  fs.copyFileSync(path.join(__dirname, '../resources/wcdb/win32/x64/wcdb_api.dll'), path.join(root, 'resources/resources/wcdb/win32/x64/wcdb_api.dll'))
  assert.throws(() => verifyWindowsPackage(root), /host-name adaptation missing/)
})

test('rejects a missing branded executable', async t => {
  const root = await fixture(t)
  fs.unlinkSync(path.join(root, `${manifest.build.win.executableName}.exe`))
  assert.throws(() => verifyWindowsPackage(root), /Missing\/empty runtime file:.*AstrWeChat\.exe/)
})

test('afterPack adapts only the packaged copy and verifies the resulting package', async t => {
  const root = await fixture(t)
  const original = path.join(__dirname, '../resources/wcdb/win32/x64/wcdb_api.dll')
  const destination = path.join(root, 'resources/resources/wcdb/win32/x64/wcdb_api.dll')
  const { sha256, SOURCE_SHA256, PATCHED_SHA256 } = require('./wcdb-host-branding.cjs')
  fs.copyFileSync(original, destination)
  await require('./after-pack.cjs')({ electronPlatformName: 'win32', arch: require('builder-util').Arch.x64, appOutDir: root })
  assert.equal(sha256(fs.readFileSync(original)), SOURCE_SHA256)
  assert.equal(sha256(fs.readFileSync(destination)), PATCHED_SHA256)
})
