import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_CONFIG, normalizeLoadedConfig, type BridgeConfig } from './bridgeConfig'

export default function useBridgeConfig() {
  const [config, setConfig] = useState<BridgeConfig>(DEFAULT_CONFIG)
  const [savedConfig, setSavedConfig] = useState<BridgeConfig>(DEFAULT_CONFIG)
  const [configHydrated, setConfigHydrated] = useState(false)
  const [configLoading, setConfigLoading] = useState(true)
  const [configLoadError, setConfigLoadError] = useState('')
  const [configLoadWarning, setConfigLoadWarning] = useState('')
  const configLoadGeneration = useRef(0)
  const [legacyFilterMigrated, setLegacyFilterMigrated] = useState(false)

  const loadBridgeConfig = useCallback(async () => {
    const generation = ++configLoadGeneration.current
    setConfigLoading(true)
    setConfigHydrated(false)
    setConfigLoadError('')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        window.electronAPI.bridge.getConfig(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('读取配置超时，请重试')), 8000)
        })
      ])
      if (generation !== configLoadGeneration.current) return
      if (!result?.success || !result.config || typeof result.config !== 'object' || Array.isArray(result.config)) {
        throw new Error(result?.error || 'Bridge 配置读取失败')
      }
      const loaded = normalizeLoadedConfig(result.config as Record<string, unknown>)
      setConfig(loaded.config)
      setSavedConfig(loaded.config)
      setLegacyFilterMigrated(loaded.migrated)
      setConfigLoadWarning(result.warning || '')
      setConfigHydrated(true)
    } catch (error) {
      if (generation === configLoadGeneration.current) {
        setConfigLoadError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (generation === configLoadGeneration.current) setConfigLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadBridgeConfig()
    return () => { configLoadGeneration.current += 1 }
  }, [loadBridgeConfig])

  const applySavedConfig = (raw: Record<string, unknown>) => {
    const saved = normalizeLoadedConfig(raw).config
    setConfig(saved)
    setSavedConfig(saved)
    setLegacyFilterMigrated(false)
    setConfigLoadWarning('')
    return saved
  }

  return {
    config, setConfig, savedConfig, configHydrated, configLoading,
    configLoadError, configLoadWarning, legacyFilterMigrated,
    loadBridgeConfig, applySavedConfig
  }
}
