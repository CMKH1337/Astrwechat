/** A raw session ID is a fallback, not a resolved contact name. */
export function sessionDisplayName(id: string, ...candidates: unknown[]): string {
  const normalized = String(id || '').trim()
  for (const candidate of candidates) {
    const name = typeof candidate === 'string' ? candidate.trim() : ''
    if (name && name !== normalized) return name
  }
  return normalized || '未命名会话'
}
