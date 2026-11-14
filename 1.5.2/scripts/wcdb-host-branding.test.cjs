'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Arch } = require('builder-util')
const beforePack = require('./before-pack.cjs')
const { adaptBuffer, replacements, sha256, SOURCE_SHA256, PATCHED_SHA256 } = require('./wcdb-host-branding.cjs')
const sourcePath = path.join(__dirname, '../resources/wcdb/win32/x64/wcdb_api.dll')

test('adapts only reviewed host-name constants without modifying the input', () => {
  const source = fs.readFileSync(sourcePath)
  assert.equal(sha256(source), SOURCE_SHA256)
  const { buffer, changed } = adaptBuffer(source)
  assert.equal(changed, true)
  assert.equal(buffer.length, source.length)
  assert.equal(sha256(source), SOURCE_SHA256)
  assert.equal(sha256(buffer), PATCHED_SHA256)
  const allowed = new Set(replacements.flatMap(({ offset, before }) => Array.from({ length: before.length }, (_, i) => offset + i)))
  for (let i = 0; i < source.length; i++) if (source[i] !== buffer[i]) assert.ok(allowed.has(i), `Unexpected change at ${i}`)
  for (const { offset, after } of replacements) assert.equal(buffer.subarray(offset, offset + after.length).toString('ascii'), after)
})
test('is idempotent on the reviewed adapted binary', () => {
  const first = adaptBuffer(fs.readFileSync(sourcePath))
  const second = adaptBuffer(first.buffer)
  assert.equal(second.changed, false)
  assert.deepEqual(second.buffer, first.buffer)
})
test('refuses changed, truncated and wrong-architecture libraries', () => {
  const changed = fs.readFileSync(sourcePath)
  changed[0x100] ^= 1
  for (const buffer of [changed, Buffer.alloc(0), changed.subarray(0, 512), fs.readFileSync(path.join(__dirname, '../resources/wcdb/win32/arm64/wcdb_api.dll'))]) {
    assert.throws(() => adaptBuffer(buffer), /Unsupported wcdb_api.dll SHA-256/)
  }
})
test('allows Windows x64 and leaves other platforms unchanged, but blocks unverified Windows ARM64', async () => {
  await beforePack({ electronPlatformName: 'win32', arch: Arch.x64 })
  await beforePack({ electronPlatformName: 'darwin', arch: Arch.arm64 })
  await assert.rejects(beforePack({ electronPlatformName: 'win32', arch: Arch.arm64 }), /verified only for Windows x64/)
})
