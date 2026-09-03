/**
 * electron-liquid-glass
 * Low-latency native liquid glass backdrop panels for Windows
 * (DXGI Desktop Duplication + D3D11 + DirectComposition).
 *
 * All coordinates and sizes are screen physical pixels.
 */

/** Glass visual parameters (lengths in physical pixels) */
export interface GlassEffectParams {
    /** Corner radius, default 20 */
    cornerRadius?: number
    /** Gaussian blur sigma, default 5 */
    blurSigma?: number
    /** Edge displacement strength (70 = standard), default 70 */
    displacementScale?: number
    /** RGB chromatic aberration strength (0-3), default 2 */
    aberrationIntensity?: number
    /** Saturation gain, default 1.4 */
    saturation?: number
    /**
     * Offset of the sampled area relative to the panel. Keep 0 for regular
     * glass; non-zero makes the panel refract content from elsewhere
     * (measurement / special-effect scenarios).
     */
    sourceOffsetX?: number
    sourceOffsetY?: number
}

/** Luminance sampling band (rect in panel-local physical pixels) */
export interface LumaBand {
    id: number
    x: number
    y: number
    width: number
    height: number
}

/** Band statistics: mean color of the blurred glass layer + luma p15/p85 (0-255) */
export interface LumaBandStats {
    r: number
    g: number
    b: number
    darkTail: number
    lightTail: number
}

export interface CreatePanelOptions extends GlassEffectParams {
    x: number
    y: number
    width: number
    height: number
    /** Display scale factor (internal geometry constants scale by it), default 1 */
    dpr?: number
    /**
     * Exclude the panel from screen capture (screenshots/recording/DDA/WGC),
     * default true. Must stay true to avoid self-capture feedback loops;
     * disable only for testing.
     */
    excludeFromCapture?: boolean
    /** Pin the panel's z-order right below this window (Electron BrowserWindow or HWND Buffer) */
    anchorWindow?: unknown
    /** Luminance sampling bands (pair with onLuma for adaptive text contrast) */
    lumaBands?: LumaBand[]
    /**
     * Luminance callback: bands is { [bandId]: LumaBandStats }.
     * Repaint-driven: pushed in the same frame the content under the panel
     * changes (capped at ~60Hz); nothing is pushed while the desktop is static.
     */
    onLuma?: (bands: Record<string, LumaBandStats>) => void
}

export interface GlassPanel {
    readonly id: number
    /** Show with fade-in (default 120ms) */
    show(fadeMs?: number): void
    /** Fade out and hide (default 100ms; 0 = immediate) */
    hide(fadeMs?: number): void
    destroy(): void
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void
    /** Update visual parameters (pass the full object; omitted fields fall back to defaults) */
    setParams(params: GlassEffectParams): void
    anchor(windowOrHwnd: unknown): void
    setLumaBands(bands: LumaBand[]): void
    onLuma(cb: (bands: Record<string, LumaBandStats>) => void): void
}

/** Whether native glass is supported here (Windows 10 2004+ with a native binary available) */
export function isSupported(): boolean

/** Create a glass panel; returns null when the native backend is unavailable (callers should fall back) */
export function createPanel(options: CreatePanelOptions): GlassPanel | null

/** Stop the worker thread and destroy all panels (called automatically before process exit) */
export function shutdown(): void
