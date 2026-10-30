import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotBackend } from '../../../shared/bridge-connection'

export interface BridgeStatus {
  starting?: boolean
  startup_stage?: string
  running: boolean
  paused: boolean
  ob_connected: boolean
  weflow_url?: string
  ob_url?: string
  processRunning: boolean
  bot_backend?: BotBackend
  ob_state?: string
  ob_error?: string
}

export default function useBridgeStatus() {
  const [status, setStatus] = useState<BridgeStatus>({
    running: false, paused: false, ob_connected: false, processRunning: false
  })
  const statusVersion = useRef(0)
  const requestVersion = useRef(0)
  const mounted = useRef(false)

  const refreshStatus = useCallback(async () => {
    const eventVersion = statusVersion.current
    const request = ++requestVersion.current
    try {
      const value = await window.electronAPI.bridge.status()
      if (mounted.current && request === requestVersion.current && eventVersion === statusVersion.current) {
        setStatus(value)
      }
    } catch { /* A later status event or poll can recover. */ }
  }, [])

  useEffect(() => {
    mounted.current = true
    const removeStatus = window.electronAPI.bridge.onStatus(value => {
      statusVersion.current += 1
      setStatus(prev => ({ ...prev, ...value }))
    })
    void refreshStatus()
    const timer = setInterval(() => void refreshStatus(), 3000)
    return () => {
      mounted.current = false
      requestVersion.current += 1
      removeStatus()
      clearInterval(timer)
    }
  }, [refreshStatus])

  return { status, refreshStatus }
}
