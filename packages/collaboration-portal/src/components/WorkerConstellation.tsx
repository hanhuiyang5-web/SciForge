import { Cpu, Laptop, Server } from 'lucide-react'
import { useMemo } from 'react'
import { formatRelativeTime, taskProgress } from '../format'
import type { MessageKey } from '../i18n'
import type { Locale, PortalWorker, Task } from '../types'

interface WorkerConstellationProps {
  workers: PortalWorker[]
  tasks?: Task[]
  selectedId: string | null
  capabilityFilter: string | null
  locale: Locale
  t(key: MessageKey): string
  onSelect(worker: PortalWorker): void
}

interface NodePosition {
  worker: PortalWorker
  x: number
  y: number
  progress: number
}

export function WorkerConstellation({ workers, tasks = [], selectedId, capabilityFilter, locale, t, onSelect }: WorkerConstellationProps): React.JSX.Element {
  const visible = useMemo(() => workers.filter((worker) => !capabilityFilter || worker.capabilityIds.includes(capabilityFilter)), [capabilityFilter, workers])
  const positions = useMemo(() => constellationLayout(visible, tasks), [tasks, visible])
  const desktopCount = visible.filter((worker) => worker.nodeType === 'desktop').length
  const serverCount = visible.length - desktopCount

  return (
    <div className="constellation" data-testid="worker-constellation">
      <div className="constellation__meta" aria-hidden="true">
        <span><Laptop size={13} /> {desktopCount} {t('desktop')}</span>
        <span><Server size={13} /> {serverCount} {t('server')}</span>
      </div>
      {positions.length === 0 ? (
        <div className="empty-constellation"><Cpu size={22} /><span>{t('noWorkers')}</span></div>
      ) : (
        <svg viewBox="0 0 820 390" role="group" aria-label={t('constellationHint')} preserveAspectRatio="xMidYMid meet">
          <defs>
            <pattern id="portal-grid" width="28" height="28" patternUnits="userSpaceOnUse">
              <path d="M28 0H0V28" className="constellation__grid" />
            </pattern>
            <filter id="node-halo" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
          </defs>
          <rect width="820" height="390" fill="url(#portal-grid)" />
          <path className="constellation__axis" d="M76 195H744" />
          <path className="constellation__orbit constellation__orbit--left" d="M78 195c0-96 84-151 181-151s178 61 178 151-81 151-178 151S78 291 78 195Z" />
          <path className="constellation__orbit constellation__orbit--right" d="M383 195c0-96 80-151 178-151s181 55 181 151-84 151-181 151-178-61-178-151Z" />
          <g className="constellation__hub" aria-hidden="true">
            <circle cx="258" cy="195" r="5" /><path d="m258 181 12 7v14l-12 7-12-7v-14Z" />
            <circle cx="562" cy="195" r="5" /><path d="m562 181 12 7v14l-12 7-12-7v-14Z" />
          </g>
          {positions.map(({ worker, x, y, progress }) => {
            const selected = worker.agentId === selectedId
            const statusLabel = t(worker.status)
            const label = `${worker.displayName}, ${statusLabel}, ${worker.nodeType}, ${worker.os.family}, ${t('lastSeen')} ${formatRelativeTime(worker.lastSeenAt, locale)}`
            const circumference = 2 * Math.PI * 27
            return (
              <g
                key={worker.agentId}
                role="button"
                tabIndex={0}
                aria-label={label}
                aria-pressed={selected}
                className={`constellation-node constellation-node--${worker.status}${selected ? ' is-selected' : ''}`}
                transform={`translate(${x} ${y})`}
                onClick={() => onSelect(worker)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(worker) } }}
              >
                <title>{label}</title>
                {(worker.status === 'online' || worker.status === 'busy') && <circle className="constellation-node__halo" r="31" filter="url(#node-halo)" />}
                <circle className="constellation-node__outer" r="27" />
                {worker.status === 'busy' && (
                  <circle className="constellation-node__progress" r="27" pathLength="100" strokeDasharray={`${Math.max(progress, 8)} ${100 - Math.max(progress, 8)}`} transform="rotate(-90)" />
                )}
                <circle className="constellation-node__inner" r="19" />
                <g className="constellation-node__icon" transform="translate(-8 -8)">
                  {worker.nodeType === 'desktop'
                    ? <path d="M2 2.5h12v8H2zM5 14h6M8 10.5V14" />
                    : <path d="M2 2h12v5H2zM2 9h12v5H2zM4 4.5h.1M4 11.5h.1" />}
                </g>
                <text className="constellation-node__name" textAnchor="middle" y="43">{truncate(worker.displayName, 17)}</text>
                <text className="constellation-node__status" textAnchor="middle" y="57">{statusGlyph(worker.status)} {statusLabel}</text>
                {selected && <path className="constellation-node__selection" d="M-6-36h12M0-42v12" />}
              </g>
            )
          })}
          <text className="constellation__label" x="92" y="31">DESKTOP FIELD</text>
          <text className="constellation__label" x="639" y="31" textAnchor="end">SERVER FIELD</text>
        </svg>
      )}
      <div className="presence-legend" aria-label={t('livePresence')}>
        {(['online', 'busy', 'offline'] as const).map((status) => <span key={status}><i className={`presence-dot presence-dot--${status}`} />{t(status)}</span>)}
      </div>
    </div>
  )
}

export function constellationLayout(workers: PortalWorker[], tasks: Task[]): NodePosition[] {
  const taskByAgent = new Map<string, Task[]>()
  for (const task of tasks) {
    const current = taskByAgent.get(task.assigneeAgentId) ?? []
    current.push(task)
    taskByAgent.set(task.assigneeAgentId, current)
  }
  const groups = [
    workers.filter((worker) => worker.nodeType === 'desktop'),
    workers.filter((worker) => worker.nodeType === 'server')
  ]
  return groups.flatMap((group, groupIndex) => group.map((worker, index) => {
    const centerX = groupIndex === 0 ? 258 : 562
    const count = Math.max(group.length, 1)
    const phase = groupIndex === 0 ? Math.PI : 0
    const angle = phase + (index / count) * Math.PI * 2 + Math.PI / Math.max(count, 4)
    const ring = 82 + (index % 3) * 25
    const agentTasks = taskByAgent.get(worker.agentId) ?? []
    const active = agentTasks.find((task) => task.status === 'running')
    return {
      worker,
      x: centerX + Math.cos(angle) * ring,
      y: 195 + Math.sin(angle) * ring * 0.88,
      progress: taskProgress(active?.status ?? 'offered', active?.progress?.percent)
    }
  }))
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function statusGlyph(status: PortalWorker['status']): string {
  return status === 'online' ? '●' : status === 'busy' ? '◐' : '○'
}
