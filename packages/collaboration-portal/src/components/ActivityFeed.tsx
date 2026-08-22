import { Bot, CheckCheck, CircleAlert, CircleDot, LockKeyhole } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatRelativeTime } from '../format'
import type { MessageKey } from '../i18n'
import type { CoordinationView, HumanNeeded, Locale } from '../types'

export interface ActivityItem {
  id: string
  kind: 'task' | 'record' | 'human'
  title: string
  detail: string
  status: string
  at: string
  truncated: boolean
}

export function activityItems(view: CoordinationView, now = Date.now()): ActivityItem[] {
  return [
    ...view.tasks.map((task) => ({ id: task.taskId, kind: 'task' as const, title: task.title, detail: task.progress?.summary ?? task.objective, status: task.status, at: task.updatedAt, truncated: Boolean(task.portalProjection?.truncated) })),
    ...view.records.map((record) => ({ id: record.projectRecordId, kind: 'record' as const, title: record.kind, detail: record.body, status: record.status, at: record.updatedAt, truncated: Boolean(record.portalProjection?.truncated) })),
    ...view.humanRequests.map((request) => ({ id: request.humanRequestId, kind: 'human' as const, title: 'HumanNeeded', detail: `${request.requiredAssurance} assurance`, status: effectiveHumanStatus(request.status, request.expiresAt, now), at: request.updatedAt, truncated: false }))
  ].sort((a, b) => b.at.localeCompare(a.at))
}

export function ActivityFeed({ view, locale, t, limit = 12 }: { view: CoordinationView; locale: Locale; t(key: MessageKey): string; limit?: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const items = activityItems(view, now).slice(0, limit)
  if (items.length === 0) return <div className="empty-activity"><CircleDot size={16} /> {t('noTasks')}</div>
  return (
    <ol className="activity-feed">
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}`}>
          <i className={`activity-feed__icon activity-feed__icon--${item.kind}`}>
            {item.kind === 'human' ? <LockKeyhole size={13} /> : item.kind === 'record' ? <CheckCheck size={13} /> : item.status === 'failed' ? <CircleAlert size={13} /> : <Bot size={13} />}
          </i>
          <span><strong>{item.title}</strong><p>{item.detail}</p><small>{item.status} · {formatRelativeTime(item.at, locale)}{item.truncated ? ` · ${t('truncatedProjection')}` : ''}</small></span>
        </li>
      ))}
    </ol>
  )
}

export function effectiveHumanStatus(status: HumanNeeded['status'], expiresAt: string, now: number): HumanNeeded['status'] {
  if (status !== 'pending') return status
  const expiry = Date.parse(expiresAt)
  return Number.isFinite(expiry) && expiry <= now ? 'expired' : status
}
