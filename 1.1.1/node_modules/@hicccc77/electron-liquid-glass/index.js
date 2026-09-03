// electron-liquid-glass JS entry: guarded native module loading + panel handle wrapper.
// node-gyp-build tries prebuilds/<platform>-<arch> first (prebuilt binaries shipped
// on npm, N-API 8, no local compilation for consumers), then build/Release
// (in-repo development builds).
// When the native side is unavailable (non-Windows, OS too old, no prebuild),
// isSupported() returns false and callers should fall back to their own approach
// (e.g. a Chromium screen-capture pipeline).
let native = null
try {
    native = require('node-gyp-build')(__dirname)
} catch {
    native = null
}

const panels = new Map()
let lumaHooked = false

function ensureLumaDispatch() {
    if (lumaHooked || !native) return
    lumaHooked = true
    native.setLumaCallback((panelId, bands) => {
        const panel = panels.get(panelId)
        if (panel && panel._onLuma) panel._onLuma(bands)
    })
}

function isSupported() {
    return Boolean(native && native.isSupported())
}

/**
 * Create a glass panel (all lengths are physical pixels; dpr scales internal
 * geometry constants). Returns a panel handle object, or null when the native
 * backend is unavailable.
 */
function createPanel(options) {
    if (!isSupported()) return null
    const { onLuma, lumaBands, anchorWindow, ...config } = options
    if (anchorWindow) config.anchorHwnd = resolveHwnd(anchorWindow)

    const id = native.createPanel(config)
    const panel = {
        id,
        _onLuma: onLuma ?? null,
        show(fadeMs = 120) { native.showPanel(id, fadeMs) },
        hide(fadeMs = 100) { native.hidePanel(id, fadeMs) },
        destroy() {
            panels.delete(id)
            native.destroyPanel(id)
        },
        setBounds(bounds) { native.setPanelBounds(id, bounds) },
        setParams(params) { native.setPanelParams(id, params) },
        anchor(windowOrHwnd) { native.anchorPanel(id, resolveHwnd(windowOrHwnd)) },
        setLumaBands(bands) { native.setLumaBands(id, bands) },
        onLuma(cb) { panel._onLuma = cb }
    }
    panels.set(id, panel)
    if (lumaBands) native.setLumaBands(id, lumaBands)
    if (onLuma) ensureLumaDispatch()
    return panel
}

// Accepts an Electron BrowserWindow or a Buffer from getNativeWindowHandle()
function resolveHwnd(windowOrHwnd) {
    if (!windowOrHwnd) return null
    if (Buffer.isBuffer(windowOrHwnd)) return windowOrHwnd
    if (typeof windowOrHwnd.getNativeWindowHandle === 'function') {
        return windowOrHwnd.getNativeWindowHandle()
    }
    return null
}

function shutdown() {
    // The non-Windows stub only exports isSupported/osBuild; guard everything else
    if (native && typeof native.shutdown === 'function') native.shutdown()
    panels.clear()
    lumaHooked = false
}

module.exports = { isSupported, createPanel, shutdown, _native: native }
