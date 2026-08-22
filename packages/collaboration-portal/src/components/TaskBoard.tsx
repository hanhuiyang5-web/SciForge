import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, FlaskConical, UserRoundCheck } from 'lucide-react'
import { formatRelativeTime, taskProgress } from '../format'
import type { MessageKey } from '../i18n'
import type { Locale, Task, TaskStatus } from '../types'
import { StatusPill } from './StatusPill'

interface TaskBoardProps {
  tasks: Task[]
  selectedId: string | null
  locale: Locale
  t(key: MessageKey): string
  onSelect(task: Task): void
}

const bands: Array<{ id: string; statuses: TaskStatus[]; icon: typeof Clock3 }> = [
  { id: 'queue', statuses: ['offered', 'accepted'], icon: Clock3 },
  { id: 'active', statuses: ['running', 'needs_human'], icon: FlaskConical },
  { id: 'results', statuses: ['succeeded'], icon: UserRoundCheck },
  { id: 'closed', statuses: ['failed', 'rejected', 'cancelled'], icon: CheckCircle2 }
]

export function TaskBoard({ tasks, selectedId, locale, t, onSelect }: TaskBoardProps): React.JSX.Element {
  if (tasks.length === 0) return <div className="empty-state empty-state--board"><CircleDashed size={24} /><p>{t('noTasks')}</p></div>
  return (
    <div className="task-board" role="region" aria-label={t('taskBoard')}>
      {bands.map((band) => {
        const bandTasks = tasks.filter((task) => band.statuses.includes(task.status))
        const Icon = band.icon
        return (
          <section className="task-band" key={band.id} aria-label={band.id}>
            <header><span><Icon size={14} />{bandTitle(band.id, t)}</span><b>{bandTasks.length}</b></header>
            <div className="task-band__items" role="list">
              {bandTasks.length === 0 && <span className="task-band__empty" role="listitem">—</span>}
              {bandTasks.map((task) => {
                const progress = taskProgress(task.status, task.progress?.percent)
                return (
                  <button type="button" role="listitem" className={`task-card${selectedId === task.taskId ? ' is-selected' : ''}`} key={task.taskId} onClick={() => onSelect(task)}>
                    <span className="task-card__top"><StatusPill status={task.status} label={t(task.status)} /><small>#{task.attempt}</small></span>
                    <strong>{task.title}</strong>
                    <p>{task.progress?.summary ?? task.objective}</p>
                    {task.portalProjection?.truncated && <span className="task-card__attention"><AlertTriangle size={12} /> {t('truncatedProjection')}</span>}
                    {(task.status === 'running' || task.status === 'succeeded') && (
                      <span className="progress-track" aria-label={`${t('progress')} ${progress}%`}><i style={{ width: `${progress}%` }} /><b>{progress}%</b></span>
                    )}
                    {task.status === 'needs_human' && <span className="task-card__attention"><AlertTriangle size={12} /> {t('displayOnly')}</span>}
                    <span className="task-card__foot"><small>{formatRelativeTime(task.updatedAt, locale)}</small><small>{task.requiredCapabilities.capabilityIds.slice(0, 1).join('') || 'general'}</small></span>
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function bandTitle(id: string, t: (key: MessageKey) => string): string {
  if (id === 'queue') return t('waitingTasks')
  if (id === 'active') return t('activeTasks')
  if (id === 'results') return t('projectResults')
  return t('completedTasks')
}
