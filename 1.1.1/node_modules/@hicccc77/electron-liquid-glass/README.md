# Electron-Liquid-Glass

English | [简体中文](README.zh-CN.md)

Low-latency native "liquid glass" backdrop panels for Electron apps on Windows, powered by DXGI Desktop Duplication + D3D11 + DirectComposition.

The liquid glass effect is rendered as a standalone native window pinned right below your Electron window, acting as a live refractive background layer.

![Real render: Electron notification window (content layer) + native glass panel (refraction layer)](https://raw.githubusercontent.com/hicccc77/electron-liquid-glass/main/docs/demo.png)

> Real screenshot, not a mockup: the notification card is a transparent Electron window; the refraction, blur, chromatic aberration behind it — and the luminance sampling that drives the adaptive text color — all come from this module's native panel.

## Features

- **True refraction, not frosted glass**: rounded-rect SDF lens displacement with visible edge refraction and chromatic aberration, crystal-clear center
- **~6ms response**: zero-copy GPU desktop texture via DXGI, D3D11 shading, DirectComposition presentation — pixels never touch the CPU
- **Deeply energy-efficient**: fully event-driven and incremental — no repaint when the desktop is static, no repaint when dirty regions don't intersect the panel, the desktop mirror is maintained incrementally from dirty rects (GPU copy volume proportional to actual changed area, not full screen), DWM "echo" dirty rects caused by the panel's own Present are detected and dropped (no self-sustained repaint loop), and the capture session is released when no panel is visible
- **Adaptive contrast support**: built-in luminance band sampling (mean color + luma p15/p85), repaint-driven and pushed in the same frame as the visual change (capped at ~60Hz), for driving light/dark adaptive text above the glass
- **Z-order anchoring**: the panel pins itself directly below a given Electron window and periodically re-asserts the order (defends against other topmost windows cutting in)
- **Self-capture loop prevention**: `WDA_EXCLUDEFROMCAPTURE` excludes the panel from all screen capture
- **Zero Electron intrusion**: pure N-API native module + command queue, ABI-stable across Electron versions, drops into any Electron app

## How it works

```
DXGI Desktop Duplication (zero-copy GPU desktop texture; frames arrive only when the screen changes)
  → D3D11 three-pass shading (half-res separable Gaussian blur ×2 → rounded-rect SDF lens displacement + RGB dispersion + saturation + rounded-corner AA)
  → DirectComposition premultiplied-alpha swapchain presentation (bypasses the DWM redirection bitmap)
```

- The whole chain runs on one dedicated worker thread + the GPU; no pixels cross processes or threads
- Panel window uses `WS_EX_NOREDIRECTIONBITMAP + WS_EX_TRANSPARENT + WS_EX_NOACTIVATE` (click-through, never steals focus, not in the taskbar)
- Every JS call is posted asynchronously to the worker thread via a command queue — inherently thread-safe
- Layered collaboration: this panel renders "the world behind the glass" (refraction/blur/dispersion); your transparent Electron window renders "the glass surface" (text, highlights, borders, tint)

```
┌─ Electron transparent window (content: text / highlight / border) ─┐   ← your app
│  ┌─ Native glass panel (refraction layer, pinned right below) ──┐  │   ← this module
│  │      live refracted desktop background                       │  │
└──┴──────────────────────────────────────────────────────────────┴──┘
```

## Requirements

| Platform | Status |
|---|---|
| Windows 10 2004 (build 19041)+ | Fully supported |
| Older Windows | `isSupported()` returns `false` (no `WDA_EXCLUDEFROMCAPTURE`) |
| macOS / Linux | Installs and loads fine, `isSupported()` returns `false` — fall back to your own approach (e.g. Chromium desktop capture + WebGL); a native macOS backend (ScreenCaptureKit + Metal) is on the roadmap |

## Install

```bash
npm install @hicccc77/electron-liquid-glass
```

The npm package ships a prebuilt win32-x64 binary (N-API 8, ABI-stable across Electron / Node versions) — **zero compilation on install, no build toolchain required**. On platforms without a prebuild (macOS/Linux) the module degrades gracefully (`isSupported()` returns `false`) and still never triggers a compile.

When packaging with electron-builder, unpack the `.node` binary from asar:

```jsonc
"build": { "asarUnpack": ["node_modules/@hicccc77/electron-liquid-glass/**/*"] }
```

Building from source (repo checkout, Windows): Node.js 18+, VS Build Tools (C++ desktop workload) + Python. `npm run build` produces `build/Release`; `npm run prebuilds` produces the distributable `prebuilds/win32-x64`.

## Quick start (Electron main process)

```js
const { screen } = require('electron')
const glass = require('@hicccc77/electron-liquid-glass')

if (glass.isSupported()) {
  const dpr = screen.getPrimaryDisplay().scaleFactor
  const panel = glass.createPanel({
    // screen physical pixels
    x: 1560, y: 40, width: 344, height: 96,
    cornerRadius: 20, blurSigma: 5,
    displacementScale: 70, aberrationIntensity: 2, saturation: 1.4,
    dpr,
    anchorWindow: myToastWindow,          // pin the panel right below this BrowserWindow
    lumaBands: [                          // luminance bands for adaptive text contrast (panel-local physical px)
      { id: 0, x: 0, y: 0, width: 344, height: 48 },
      { id: 1, x: 0, y: 48, width: 344, height: 48 }
    ],
    onLuma: bands => {
      // bands = { '0': { r, g, b, darkTail, lightTail }, '1': ... }
      // Mean RGB + luma p15/p85 (gamma domain, 0-255). Repaint-driven:
      // pushed in the same frame the background changes (capped ~60Hz),
      // nothing is pushed while the desktop is static.
      // Use it to switch your text between light/dark styles.
    }
  })

  panel.show(120)                          // fade in over 120ms
  panel.setBounds({ x, y, width, height }) // follow window moves/resizes
  panel.hide(240)                          // fade out
  panel.destroy()
} else {
  // Fallback: Chromium desktop stream + WebGL refraction pipeline, or a static backdrop-filter
}
```

Your top window only needs to keep the glass area transparent (Electron `transparent: true` already does) and draw the content layer — text, borders, highlights, tint. The refracted background comes from this panel.

## API

Full types in [`index.d.ts`](index.d.ts). All panel methods are thread-safe.

| Method | Description |
|---|---|
| `isSupported()` | Whether the current environment is supported (Windows 10 2004+ with a native binary available) |
| `createPanel(options)` | Create a panel, returns a handle; returns `null` when unsupported |
| `panel.show(fadeMs?)` / `panel.hide(fadeMs?)` | Fade in / out (`0` = immediate) |
| `panel.setBounds(bounds)` | Move / resize (physical pixels) |
| `panel.setParams(params)` | Update visual params (corner radius, blur, displacement, aberration, saturation) |
| `panel.anchor(windowOrHwnd)` | Re-pin below a window (accepts `BrowserWindow` or an HWND Buffer) |
| `panel.setLumaBands(bands)` / `panel.onLuma(cb)` | Update luminance bands / callback |
| `panel.destroy()` | Destroy the panel |
| `shutdown()` | Stop the worker thread and destroy all panels |

## Measured results (1080p, animated background, Windows 11)

| Metric | Chromium stream approach (getUserMedia + WebGL) | This module |
|---|---|---|
| Perceived position lag (median / p90) | 77ms / 89ms | **6ms / 6ms** |
| CPU delta under load (main + GPU + renderer processes) | ~1.5% | **~0.3%** |
| Static desktop overhead | continuous capture frames | **0 renders / 0 copies** (event-driven) |
| First-frame startup | ~80-300ms (getUserMedia negotiation) | **<150ms** (0 when a persistent panel is reused) |
| 40-round notification stress | — | 1 panel created, 81 reuses, zero memory growth, zero errors |

Measurement method: same-frame differencing — within a single captured frame, compare the counter stripes shown through the glass against the ground-truth stripes in the background; both timestamps come from draw time, so probe latency cancels out.


## Source layout

```
src/
├── addon.cc       N-API binding layer (argument parsing, thread-safe luma callback dispatch)
├── session.cc/h   Scheduler: dedicated worker thread running the capture→render→present loop, command queue, energy policies
├── capture.cc/h   DXGI Desktop Duplication capture (zero-copy GPU texture + dirty regions + self-echo filtering)
├── renderer.cc/h  D3D11 three-pass glass pipeline + luminance band histogram sampling
├── panel.cc/h     DirectComposition no-redirection-bitmap window, fades, z-order anchoring, capture exclusion
├── d3d_utils.cc/h Device creation helper
├── stats.h        Internal performance counters (`_stats` diagnostic export, used by benchmarks)
└── addon_stub.cc  Non-Windows stub (isSupported() = false)
```

## Known limitations

- Native implementation is Windows-only for now (macOS ScreenCaptureKit + Metal backend is on the roadmap; the API is designed for pluggable per-platform backends)
- The panel is excluded from screenshots/recordings (the semantics of `WDA_EXCLUDEFROMCAPTURE`, same as content-protected windows)
- Capture pauses during secure desktop (UAC / lock screen) and resumes automatically afterwards
- Multi-monitor: the capture session follows the display of the first visible panel; moving a panel across displays rebuilds the session automatically

## License

[MIT](LICENSE)
