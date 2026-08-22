import type { MessageKey } from '../i18n'
import type { PresenceStatus, TaskStatus } from '../types'

type Status = PresenceStatus | TaskStatus | 'active' | 'paused' | 'completed' | 'draft' | 'pending' | 'answered' | 'expired'

export function StatusPill({ status, label }: { status: Status; label: string }): React.JSX.Element {
  return (
    <span className={`status-pill status-pill--${status}`}>
      <span className="status-pill__glyph" aria-hidden="true">{glyph(status)}</span>
      {label}
    </span>
  )
}

export function statusMessageKey(status: Status): MessageKey {
  if (status === 'active') return 'online'
  if (status === 'paused') return 'waitingTasks'
  if (status === 'completed') return 'completedTasks'
  if (status === 'draft') return 'pending'
  return status as MessageKey
}

function glyph(status: Status): string {
  if (status === 'online' || status === 'active' || status === 'succeeded' || status === 'completed' || status === 'answered') return '●'
  if (status === 'busy' || status === 'running') return '◐'
  if (status === 'failed' || status === 'rejected' || status === 'cancelled' || status === 'expired') return '×'
  if (status === 'needs_human' || status === 'pending' || status === 'offered' || status === 'accepted' || status === 'paused') return '◆'
  return '○'
}
