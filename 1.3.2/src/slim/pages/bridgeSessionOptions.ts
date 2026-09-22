import { sessionDisplayName } from '../../../shared/session-display-name'

export interface SessionOption {
  id: string
  name: string
  displayName: string
  kind: 'group' | 'private'
}

export function buildSessionOptions(
  sessions: Array<{ username?: string; displayName?: string }>,
  contacts: Record<string, { displayName?: string }> = {},
): SessionOption[] {
  const options = new Map<string, SessionOption>()
  for (const session of sessions) {
    const id = String(session.username || '').trim()
    if (!id) continue
    const name = sessionDisplayName(id, contacts[id]?.displayName, session.displayName)
    options.set(id, { id, name, displayName: name, kind: id.endsWith('@chatroom') ? 'group' : 'private' })
  }
  return [...options.values()]
}
