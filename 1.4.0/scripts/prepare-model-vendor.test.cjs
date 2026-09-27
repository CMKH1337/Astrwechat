'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { complete, targetComplete, targets, requiredFiles, prepare } = require('./prepare-model-vendor.cjs')

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(parent, 'astrwechat-vendor-test-'))
  t.after(() => {
    const resolved = fs.realpathSync(root)
    assert.equal(path.dirname(resolved), parent)
    assert.ok(path.basename(resolved).startsWith('astrwechat-vendor-test-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return root
}
function populate(root, target) {
  for (const name of requiredFiles(target)) {
    const filename = path.join(root, target.directory, name)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, 'fixture')
  }
}

test('old cp310-only vendor is incomplete for the new dual-runtime package', t => {
  const root = fixture(t)
  populate(root, targets[0])
  assert.equal(targetComplete(root, targets[0]), true)
  assert.equal(complete(root), false)
  populate(root, targets[1])
  assert.equal(complete(root), true)
})

test('missing or empty native cp312 wheels fail readiness', t => {
  const root = fixture(t), target = targets[1]
  populate(root, target)
  const file = path.join(root, target.directory, 'pydantic_core/_pydantic_core.cp312-win_amd64.pyd')
  fs.unlinkSync(file)
  fs.writeFileSync(file.replace('cp312-win_amd64.pyd', 'cp310-win_amd64.pyd'), 'wrong ABI')
  assert.equal(targetComplete(root, target), false)
  fs.writeFileSync(file, '')
  assert.equal(targetComplete(root, target), false)
})

test('missing transitive SDK dependencies fail readiness', t => {
  const root = fixture(t), target = targets[1]
  populate(root, target)
  fs.unlinkSync(path.join(root, target.directory, 'httpx2/__init__.py'))
  assert.equal(targetComplete(root, target), false)
})

test('prepare skips complete bundles and only installs missing ABI into its own directory', t => {
  const root = fixture(t)
  populate(root, targets[0])
  const calls = []
  prepare({ root, uv: 'test-uv', run: (program, args, options) => {
    calls.push({ program, args, options })
    assert.equal(program, 'test-uv')
    assert.equal(args[args.indexOf('--target') + 1], path.join(root, targets[1].directory))
    assert.equal(args[args.indexOf('--python-version') + 1], '3.12')
    assert.equal(args[args.indexOf('--python-platform') + 1], 'x86_64-pc-windows-msvc')
    assert.equal(args[args.indexOf('--only-binary') + 1], ':all:')
    assert.ok(args.includes('--reinstall'))
    assert.equal(options.windowsHide, true)
    populate(root, targets[1])
    return { status: 0 }
  } })
  assert.equal(calls.length, 1)
  assert.equal(complete(root), true)
  prepare({ root, run: () => assert.fail('complete SDK must not download again') })
})

test('prepare fails closed when installation fails or native wheels remain missing', t => {
  const root = fixture(t)
  populate(root, targets[0])
  assert.throws(() => prepare({ root, run: () => ({ error: new Error('test unavailable uv') }) }), /3\.12.*test unavailable uv/)
  assert.throws(() => prepare({ root, run: () => ({ status: 0 }) }), /3\.12.*missing/)
})
