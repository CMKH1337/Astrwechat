import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { randomUUID } from 'crypto'
import defaults from '../../shared/bridge-default-config.json'

type Config = Record<string, unknown>
type FileState = { kind: 'missing' } | { kind: 'valid'; value: Config } | { kind: 'corrupt'; bytes: Buffer }
interface Options {
  getDirectory: () => string
  getLegacyPath?: () => string
  onWarning: (message: string) => void
}

/** Small local config files: flush a same-directory temporary file before replacement. */
export class BridgeConfigStore {
  constructor(private options: Options) {}
  getPath(): string { return join(this.options.getDirectory(), 'config.json') }

  private inspect(path: string): FileState {
    let bytes: Buffer
    try { bytes = readFileSync(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
      // Permission and I/O errors are NOT corruption: never overwrite unreadable data.
      throw error
    }
    try {
      const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
      if (value && typeof value === 'object' && !Array.isArray(value)) return { kind: 'valid', value }
    } catch { /* Do not include JSON contents (possibly tokens) in error messages. */ }
    return { kind: 'corrupt', bytes }
  }

  private replace(path: string, bytes: string | Buffer, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      signal?.throwIfAborted()
      renameSync(temporary, path)
    } finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  private preserve(bytes: Buffer): string {
    const path = `${this.getPath()}.corrupt-${Date.now()}-${randomUUID()}`
    this.replace(path, bytes)
    return path
  }

  read(): Config {
    const path = this.getPath()
    const current = this.inspect(path)
    if (current.kind === 'valid') return current.value
    const backup = this.inspect(`${path}.bak`)
    let recovered = backup.kind === 'valid' ? backup.value : undefined
    let damaged = current.kind === 'corrupt'
    if (current.kind === 'corrupt') this.preserve(current.bytes)
    if (backup.kind === 'corrupt') this.preserve(backup.bytes)

    // Migrate only when there is no user config. Never resurrect stale install-time
    // credentials over an existing (even corrupt) per-user configuration.
    const legacyPath = this.options.getLegacyPath?.()
    if (current.kind === 'missing' && !recovered && legacyPath && resolve(legacyPath) !== resolve(path)) {
      const legacy = this.inspect(legacyPath)
      if (legacy.kind === 'valid') recovered = legacy.value
      else if (legacy.kind === 'corrupt') {
        this.preserve(legacy.bytes)
        damaged = true
        const legacyBackup = this.inspect(`${legacyPath}.bak`)
        if (legacyBackup.kind === 'valid') recovered = legacyBackup.value
      }
    }
    const value = recovered || JSON.parse(JSON.stringify(defaults)) as Config
    const serialized = JSON.stringify(value, null, 4)
    this.replace(`${path}.bak`, serialized)
    this.replace(path, serialized)
    if (damaged || (current.kind === 'missing' && backup.kind === 'valid')) {
      this.options.onWarning(recovered
        ? 'Bridge 配置不可用，已从有效备份恢复；请检查机器人连接设置。损坏文件已保留。'
        : 'Bridge 配置已损坏，原文件已保留，但未找到可用备份。已恢复默认设置，请重新填写机器人地址和 Token。')
    }
    return value
  }

  write(config: Config, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    const path = this.getPath()
    const previous = this.inspect(path)
    const serialized = JSON.stringify(config, null, 4)
    // Keep the last readable version; a failed new write cannot truncate it.
    if (previous.kind === 'valid') this.replace(`${path}.bak`, JSON.stringify(previous.value, null, 4), signal)
    else if (previous.kind === 'corrupt') this.preserve(previous.bytes)
    this.replace(path, serialized, signal)
  }

  reset(): void {
    const serialized = JSON.stringify(defaults, null, 4)
    this.replace(`${this.getPath()}.bak`, serialized)
    this.replace(this.getPath(), serialized)
  }
}
