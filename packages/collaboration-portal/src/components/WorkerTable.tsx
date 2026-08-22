import { ChevronRight, Cpu, HardDrive, Laptop, Server } from 'lucide-react'
import { compactId, formatRelativeTime } from '../format'
import type { MessageKey } from '../i18n'
import type { Locale, PortalWorker } from '../types'
import { StatusPill } from './StatusPill'

interface WorkerTableProps {
  workers: PortalWorker[]
  selectedId: string | null
  locale: Locale
  t(key: MessageKey): string
  onSelect(worker: PortalWorker): void
}

export function WorkerTable({ workers, selectedId, locale, t, onSelect }: WorkerTableProps): React.JSX.Element {
  if (workers.length === 0) return <div className="empty-state"><Cpu size={22} /><p>{t('noWorkers')}</p></div>
  return (
    <div className="worker-table" role="table" aria-label={t('workerDirectory')}>
      <div className="worker-table__head" role="row">
        <span role="columnheader">Worker</span><span role="columnheader">{t('livePresence')}</span><span role="columnheader">{t('runtime')}</span><span role="columnheader">{t('capability')}</span><span role="columnheader">{t('lastSeen')}</span><span aria-hidden="true" />
      </div>
      {workers.map((worker) => (
        <button
          type="button"
          role="row"
          className={`worker-row${selectedId === worker.agentId ? ' is-selected' : ''}`}
          key={worker.agentId}
          onClick={() => onSelect(worker)}
          aria-label={`${worker.displayName}, ${t(worker.status)}`}
        >
          <span className="worker-row__identity" role="cell">
            <i>{worker.nodeType === 'desktop' ? <Laptop size={16} /> : <Server size={16} />}</i>
            <span><strong>{worker.displayName}</strong><small>{worker.os.family} · {worker.os.architecture} · {compactId(worker.agentId)}</small></span>
          </span>
          <span role="cell"><StatusPill status={worker.status} label={t(worker.status)} /><small className="durable-badge"><HardDrive size={11} /> {t('durableDelivery')}</small></span>
          <span className="chip-cell" role="cell">{worker.runtimeIds.slice(0, 2).map((runtime) => <em key={runtime}>{runtime}</em>)}{worker.runtimeIds.length > 2 && <em>+{worker.runtimeIds.length - 2}</em>}</span>
          <span className="chip-cell" role="cell">{worker.capabilityIds.slice(0, 2).map((capability) => <em key={capability}>{capability}</em>)}{worker.capabilityIds.length > 2 && <em>+{worker.capabilityIds.length - 2}</em>}</span>
          <span role="cell"><strong>{formatRelativeTime(worker.lastSeenAt, locale)}</strong><small>{worker.gpu.length > 0 ? `${worker.gpu[0]?.model ?? 'GPU'} · ${worker.gpu[0]?.memoryGB ?? '—'} GB` : t('noGpu')}</small></span>
          <span role="cell" aria-hidden="true"><ChevronRight size={16} /></span>
        </button>
      ))}
    </div>
  )
}
