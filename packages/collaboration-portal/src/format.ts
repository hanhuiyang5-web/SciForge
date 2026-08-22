import type { Locale, PresenceStatus, TaskStatus } from './types'

export function formatRelativeTime(iso: string | undefined, locale: Locale, now = Date.now()): string {
  if (!iso) return '—'
  const deltaSeconds = Math.round((new Date(iso).getTime() - now) / 1_000)
  const formatter = new Intl.RelativeTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { numeric: 'auto' })
  if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, 'second')
  const minutes = Math.round(deltaSeconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  return formatter.format(Math.round(hours / 24), 'day')
}

export function formatTimestamp(iso: string | undefined, locale: Locale): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(iso))
}

export function compactId(id: string, visible = 8): string {
  if (id.length <= visible + 5) return id
  return `${id.slice(0, 4)}…${id.slice(-visible)}`
}

export function taskProgress(status: TaskStatus, reported?: number): number {
  if (reported !== undefined) return reported
  if (status === 'succeeded') return 100
  if (status === 'running') return 38
  if (status === 'accepted') return 12
  return 0
}

export function presenceOrder(status: PresenceStatus): number {
  return status === 'busy' ? 0 : status === 'online' ? 1 : 2
}
