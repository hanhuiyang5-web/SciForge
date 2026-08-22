import { Cpu, Laptop, RadioTower, Server, Waypoints, Zap } from 'lucide-react'
import type { MessageKey } from '../i18n'
import type { WorkerDirectoryStats } from '../types'

interface MetricStripProps {
  stats: WorkerDirectoryStats
  taskMetrics: { active: number; waiting: number; completed: number; failed: number }
  t(key: MessageKey): string
}

export function MetricStrip({ stats, taskMetrics, t }: MetricStripProps): React.JSX.Element {
  const metrics = [
    { label: t('totalWorkers'), value: stats.total, detail: `${stats.desktop} ${t('desktop')} · ${stats.server} ${t('server')}`, Icon: Waypoints, tone: 'accent' },
    { label: t('online'), value: stats.online, detail: `${stats.busy} ${t('busy')}`, Icon: RadioTower, tone: 'success' },
    { label: t('activeTasks'), value: taskMetrics.active, detail: `${taskMetrics.waiting} ${t('waitingTasks')}`, Icon: Zap, tone: 'active' },
    { label: t('completedTasks'), value: taskMetrics.completed, detail: `${taskMetrics.failed} ${t('failedTasks')}`, Icon: Cpu, tone: 'neutral' }
  ]
  return (
    <section className="metric-strip" aria-label={t('projectPulse')} tabIndex={0}>
      {metrics.map(({ label, value, detail, Icon, tone }) => (
        <article className={`metric-card metric-card--${tone}`} key={label}>
          <div className="metric-card__icon"><Icon size={17} aria-hidden="true" /></div>
          <div className="metric-card__body"><span>{label}</span><strong>{value.toLocaleString()}</strong><small>{detail}</small></div>
        </article>
      ))}
      <div className="metric-strip__motif" aria-hidden="true"><Laptop size={17} /><span /><Server size={17} /></div>
    </section>
  )
}
