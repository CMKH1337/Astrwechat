import { readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

export const MESSAGE_DB_UNAVAILABLE = '未识别到消息数据库：会话库连接成功不代表消息库可用，请检查数据库诊断日志中的 [diag:message-db]。'

/** Metadata only: never read message bodies, keys or follow directory links. */
export function inspectMessageDbFiles(root: string) {
  const files: Array<{ path: string; bytes: number; walBytes: number; candidate: boolean }> = []
  const errors: string[] = []
  let visited = 0
  let truncated = false
  function walk(dir: string, depth: number) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (++visited > 2000) { truncated = true; return }
        if (entry.isSymbolicLink()) continue
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (depth < 3) walk(fullPath, depth + 1)
          else truncated = true
        } else if (entry.isFile() && /\.db$/i.test(entry.name)) {
          try {
            let walBytes = 0
            try { walBytes = statSync(fullPath + '-wal').size } catch { /* optional WAL */ }
            files.push({ path: relative(root, fullPath), bytes: statSync(fullPath).size, walBytes,
              candidate: /^(?:message|msg)_\d+\.db$/i.test(entry.name) })
          } catch (error) { errors.push(`${relative(root, fullPath)}: ${String(error)}`) }
        }
        if (visited > 2000) return
      }
    } catch (error) { errors.push(`${relative(root, dir) || '.'}: ${String(error)}`) }
  }
  walk(root, 0)
  return { files, errors, truncated }
}
