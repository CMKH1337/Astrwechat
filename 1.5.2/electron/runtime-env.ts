/**
 * Prevent an inherited Vite development URL from accidentally changing a
 * normal AstrWeChat launch into development mode. WCDB's native runtime is
 * only validated in the built Electron process.
 */
if (process.env.WEFLOW_FORCE_PRODUCTION === '1') {
  if (process.env.VITE_DEV_SERVER_URL) {
    console.log('[Runtime] Ignoring inherited VITE_DEV_SERVER_URL for built launch')
  }
  delete process.env.VITE_DEV_SERVER_URL
  process.env.NODE_ENV = 'production'
}