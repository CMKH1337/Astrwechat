'use strict'

// Fail before producing an incorrectly named package on an unverified architecture.
module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return
  const { Arch } = require('builder-util')
  const arch = Arch[context.arch]
  if (arch !== 'x64') {
    throw new Error(`AstrWeChat 1.3.1 host-name adaptation is verified only for Windows x64, not ${arch}`)
  }
}
