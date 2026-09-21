'use strict'

// Windows x64 compatibility adaptation for the exact bundled wcdb_api.dll.
// Only the existing ciphertalk[.exe] comparison constants become astrwechat[.exe].
// Do not disable InitProtection, wcdb_init errors, or the unknown-host rejection.
const fs = require('node:fs')
const { createHash } = require('node:crypto')
const SOURCE_SHA256 = '6397760da70de8062829fbe6a2ec01cf0616d6f2b334e6fe54873898f38f7ad7'
const PATCHED_SHA256 = '2630fe8140957384bdae19721fbff8c0ac7874cf1a72a23f1537555dbffe8ed7'
const replacements = [
  { offset: 0x6cb36, before: 'cipherta', after: 'astrwech' },
  { offset: 0x6cb50, before: 'lk.e', after: 'at.e' },
  { offset: 0x6cb8c, before: 'lk', after: 'at' },
]
function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex') }
function adaptBuffer(original) {
  const hash = sha256(original)
  if (hash === PATCHED_SHA256) return { buffer: Buffer.from(original), changed: false }
  if (hash !== SOURCE_SHA256) throw new Error(`Unsupported wcdb_api.dll SHA-256: ${hash}; refusing version-specific adaptation`)
  const buffer = Buffer.from(original)
  for (const { offset, before, after } of replacements) {
    const oldBytes = Buffer.from(before, 'ascii')
    const newBytes = Buffer.from(after, 'ascii')
    if (oldBytes.length !== newBytes.length || !buffer.subarray(offset, offset + oldBytes.length).equals(oldBytes)) {
      throw new Error(`Unexpected host-name comparison at 0x${offset.toString(16)}`)
    }
    newBytes.copy(buffer, offset)
  }
  if (sha256(buffer) !== PATCHED_SHA256) throw new Error('Adapted DLL hash does not match the reviewed result')
  return { buffer, changed: true }
}
function assertBrandedDll(filename) {
  const hash = sha256(fs.readFileSync(filename))
  if (hash !== PATCHED_SHA256) throw new Error(`WCDB host-name adaptation missing or unsupported: ${filename} (${hash})`)
}
function adaptFile(filename) {
  const result = adaptBuffer(fs.readFileSync(filename))
  if (result.changed) fs.writeFileSync(filename, result.buffer)
  assertBrandedDll(filename)
  return result.changed
}
module.exports = { SOURCE_SHA256, PATCHED_SHA256, replacements, sha256, adaptBuffer, adaptFile, assertBrandedDll }
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/wcdb-host-branding.cjs <copied-wcdb_api.dll>')
    console.log(adaptFile(process.argv[2]) ? 'Applied AstrWeChat host-name adaptation' : 'AstrWeChat host-name adaptation already verified')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
