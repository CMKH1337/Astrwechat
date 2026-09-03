// Explicit install script: overrides npm's implicit "node-gyp rebuild"
// injection for repos containing a binding.gyp. The published tarball ships
// prebuilt binaries only (prebuilds/), no sources and no binding.gyp:
// - Prebuild matches the current platform: pass through (zero compilation)
// - No match (e.g. macOS/Linux): degrade quietly; isSupported() returns false at runtime
// Always exits 0 — never fails or triggers a compile during a consumer's npm install.
try {
    const resolved = require('node-gyp-build').path(require('path').join(__dirname, '..'))
    console.log('[electron-liquid-glass] prebuild ready:', resolved)
} catch {
    console.log(
        '[electron-liquid-glass] no prebuild for ' + process.platform + '-' + process.arch +
        ', isSupported() will return false (see README for fallback guidance)'
    )
}
process.exit(0)
