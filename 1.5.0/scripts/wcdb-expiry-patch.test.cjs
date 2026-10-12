'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const dll = path.join(__dirname, '../resources/wcdb/win32/x64/wcdb_api.dll')
// Byte offsets of the 2026-10-01 self-destruct gates (.text: VA 0x180001000 -> raw 0x400).
const INIT_PROTECTION_JLE = 0x80dc5      // 0x1800819C5: jle -> -101 self-destruct
const WCDB_INIT_SECURITY = 0xe8550       // 0x1800E9150: SecurityStatus early-return
const WCDB_INIT_CLOCK_JLE = 0xe85d7      // 0x1800E91D7: jle -> 0x1800E930D (2026-09-30 23:59:59)

test('bundled wcdb_api.dll no longer self-destructs after 2026-10-01', () => {
  const d = fs.readFileSync(dll)
  const { sha256, adaptBuffer, SOURCE_SHA256, PATCHED_SHA256 } = require('./wcdb-host-branding.cjs')
  assert.equal(sha256(d), SOURCE_SHA256)
  // InitProtection: branch unconditionally to the healthy path, skipping the -101 return.
  assert.equal(d.subarray(INIT_PROTECTION_JLE, INIT_PROTECTION_JLE + 2).toString('hex'), 'eb0a')
  // wcdb_init: SecurityStatus early-return forced onto the normal path.
  assert.equal(d.subarray(WCDB_INIT_SECURITY, WCDB_INIT_SECURITY + 6).toString('hex'), 'b80000000090')
  // wcdb_init: monotonic elapsed-time "clock rolled back" branch forced to "return 0".
  assert.equal(d.subarray(WCDB_INIT_CLOCK_JLE, WCDB_INIT_CLOCK_JLE + 6).toString('hex'), 'e93101000090')
  // Adaptation chain must still resolve to the reviewed branded hash.
  const adapted = adaptBuffer(d)
  assert.equal(adapted.changed, true)
  assert.equal(sha256(adapted.buffer), PATCHED_SHA256)
})
