import {
  Activity, AlertTriangle, Box, Check, ChevronRight, CircleOff, Cpu, HardDrive, Laptop,
  ListChecks, LockKeyhole, RotateCcw, Server, ShieldCheck, UserRound, Users, X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { buildCancelTask, buildRetryTask, buildReviewResult } from '../commands'
import { compactId, formatRelativeTime, formatTimestamp, taskProgress } from '../format'
import type { MessageKey } from '../i18n'
import type { CoordinationView, Locale, PortalCommand, PortalSelection, PortalUser, PortalWorker, Task } from '../types'
import { ActivityFeed, effectiveHumanStatus } from './ActivityFeed'
import { CollectionLoadMore } from './CollectionLoadMore'
import { StatusPill } from './StatusPill'
import type { CoordinationCollection, CoordinationPaginationState } from '../hooks/usePortalData'

interface InspectorProps {
  view: CoordinationView | null
  workers: PortalWorker[]
  selection: PortalSelection
  user: PortalUser
  locale: Locale
  t(key: MessageKey): string
  actionPending: boolean
  pagination: CoordinationPaginationState
  drawerOpen: boolean
  onCloseDrawer(): void
  onLoadMore(collection: CoordinationCollection): Promise<void>
  onRun(command: PortalCommand): Promise<unknown>
}

export function Inspector({ view, workers, selection, user, locale, t, actionPending, pagination, drawerOpen, onCloseDrawer, onLoadMore, onRun }: InspectorProps): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const worker = selection?.kind === 'worker' ? workers.find((item) => item.agentId === selection.id) : undefined
  const task = selection?.kind === 'task' ? view?.tasks.find((item) => item.taskId === selection.id) : undefined
  return (
    <aside className={`inspector${drawerOpen ? ' is-open' : ''}`} aria-label={t('projectInspector')}>
      <header className="inspector__header">
        <div><p className="eyebrow">Inspector</p><h2>{worker ? t('workerInspector') : task ? t('taskInspector') : t('projectInspector')}</h2></div>
        <button className="icon-button inspector__close" aria-label={t('close')} onClick={onCloseDrawer}><X size={17} /></button>
      </header>
      <div className="inspector__scroll" tabIndex={0} aria-label={t('projectInspector')}>
        {worker ? <WorkerInspector worker={worker} locale={locale} t={t} /> : task && view ? <TaskInspector key={taskInspectorKey(task)} task={task} view={view} workers={workers} user={user} locale={locale} t={t} now={now} actionPending={actionPending} onRun={onRun} /> : view ? <ProjectInspector view={view} user={user} locale={locale} t={t} now={now} /> : <div className="inspector-placeholder"><Box size={26} /><p>{t('selectSomething')}</p></div>}
        {view && <section className="inspector-section inspector-section--activity"><header><h3>{t('activity')}</h3><Activity size={14} /></header><ActivityFeed view={view} locale={locale} t={t} limit={8} /><div className="collection-pagination-group"><CollectionLoadMore state={pagination.records} label="Records" t={t} onLoad={() => onLoadMore('records')} /><CollectionLoadMore state={pagination.humanRequests} label="HumanNeeded" t={t} onLoad={() => onLoadMore('humanRequests')} /></div></section>}
      </div>
    </aside>
  )
}

function WorkerInspector({ worker, locale, t }: { worker: PortalWorker; locale: Locale; t(key: MessageKey): string }): React.JSX.Element {
  return <>
    <section className="inspector-hero">
      <div className={`inspector-hero__avatar inspector-hero__avatar--${worker.status}`}>{worker.nodeType === 'desktop' ? <Laptop size={24} /> : <Server size={24} />}</div>
      <div><StatusPill status={worker.status} label={t(worker.status)} /><h3>{worker.displayName}</h3><p>{compactId(worker.agentId, 10)}</p></div>
    </section>
    <section className="inspector-section"><header><h3>{t('livePresence')}</h3><ShieldCheck size={14} /></header>
      <dl className="detail-grid">
        <div><dt>{t('lastSeen')}</dt><dd>{formatRelativeTime(worker.lastSeenAt, locale)}<small>{formatTimestamp(worker.lastSeenAt, locale)}</small></dd></div>
        <div><dt>{t('durableDelivery')}</dt><dd className="success-text"><HardDrive size={13} /> available</dd></div>
        <div><dt>{t('profileUntil')}</dt><dd>{formatTimestamp(worker.profileExpiresAt, locale)}</dd></div>
        <div><dt>{t('os')}</dt><dd>{worker.os.family} · {worker.os.architecture}</dd></div>
      </dl>
    </section>
    <section className="inspector-section"><header><h3>{t('capability')}</h3><Cpu size={14} /></header><div className="tag-cloud">{worker.capabilityIds.map((id) => <span key={id}>{id}</span>)}</div></section>
    <section className="inspector-section"><header><h3>{t('runtime')}</h3><Box size={14} /></header><div className="tag-cloud tag-cloud--muted">{worker.runtimeIds.map((id) => <span key={id}>{id}</span>)}</div></section>
    <section className="inspector-section"><header><h3>{t('gpu')}</h3><Cpu size={14} /></header>{worker.gpu.length === 0 ? <p className="muted-copy">{t('noGpu')}</p> : worker.gpu.map((gpu, index) => <p className="gpu-line" key={`${gpu.model}-${index}`}>{gpu.vendor ?? 'GPU'} · {gpu.model ?? 'model'} <strong>{gpu.memoryGB ?? '—'} GB</strong></p>)}</section>
  </>
}

function TaskInspector({ task, view, workers, user, locale, t, now, actionPending, onRun }: { task: Task; view: CoordinationView; workers: PortalWorker[]; user: PortalUser; locale: Locale; t(key: MessageKey): string; now: number; actionPending: boolean; onRun(command: PortalCommand): Promise<unknown> }): React.JSX.Element {
  const owner = view.project.ownerUserId === user.userId
  const candidates = workers.filter((worker) => view.project.memberUserIds.includes(worker.ownerUserId))
  const [assignee, setAssignee] = useState(task.assigneeAgentId)
  const record = task.resultProjectRecordId ? view.records.find((item) => item.projectRecordId === task.resultProjectRecordId) : undefined
  const progress = taskProgress(task.status, task.progress?.percent)
  const cancellable = ['offered', 'accepted', 'running', 'needs_human'].includes(task.status)
  const retryable = ['failed', 'rejected'].includes(task.status)
  const eligibleAssignee = candidates.some((worker) => worker.agentId === assignee)
  return <>
    <section className="inspector-hero inspector-hero--task">
      <div className="inspector-hero__avatar"><ListChecks size={23} /></div>
      <div><StatusPill status={task.status} label={t(task.status)} /><h3>{task.title}</h3><p>{compactId(task.taskId, 10)}</p></div>
    </section>
    <section className="inspector-section"><header><h3>{t('progress')}</h3><span>{progress}%</span></header><span className="progress-track progress-track--large"><i style={{ width: `${progress}%` }} /></span><p className="muted-copy">{task.progress?.summary ?? task.objective}</p></section>
    <section className="inspector-section"><header><h3>{t('taskDetails')}</h3><Cpu size={14} /></header>
      <dl className="detail-grid"><div><dt>{t('assignee')}</dt><dd>{workers.find((worker) => worker.agentId === task.assigneeAgentId)?.displayName ?? compactId(task.assigneeAgentId)}</dd></div><div><dt>{t('attempt')}</dt><dd>{task.attempt} / {task.maxRetries + 1}</dd></div><div><dt>{t('execution')}</dt><dd>{compactId(task.executionId, 10)}</dd></div><div><dt>{t('revision')}</dt><dd>{task.revision}</dd></div></dl>
      <h4>{t('objective')}</h4><p className="long-copy">{task.objective}</p>
      <h4>{t('criteria')}</h4><ol className="criteria-list">{task.completionCriteria.map((criterion) => <li key={criterion.criterionId}>{criterion.text}</li>)}</ol>
      {task.portalProjection?.truncated && <p className="permission-note"><AlertTriangle size={13} />{t('truncatedProjection')}</p>}
    </section>
    {task.safeFailureCode && <section className="inspector-section inspector-section--danger"><header><h3>{t('safeFailure')}</h3><AlertTriangle size={14} /></header><code>{task.safeFailureCode}</code><p>{task.safeFailureSummary}</p></section>}
    {record && <section className="inspector-section inspector-section--result"><header><h3>{t('result')}</h3><Check size={14} /></header><StatusPill status={record.status === 'proposed' ? 'pending' : record.status === 'accepted' ? 'succeeded' : 'rejected'} label={record.status === 'proposed' ? t('resultPending') : record.status} /><p className="long-copy">{task.resultSummary ?? record.body}</p>{record.portalProjection?.truncated && <p className="permission-note"><AlertTriangle size={13} />{t('truncatedProjection')}</p>}{record.logSummary && <pre>{record.logSummary}</pre>}{owner && record.status === 'proposed' && <div className="inline-actions"><button className="button button--success" disabled={actionPending} onClick={() => { void onRun(buildReviewResult({ projectRecordId: record.projectRecordId, expectedRevision: record.revision, decision: 'accepted' })).catch(() => undefined) }}><Check size={14} />{t('accept')}</button><button className="button button--danger-soft" disabled={actionPending} onClick={() => { void onRun(buildReviewResult({ projectRecordId: record.projectRecordId, expectedRevision: record.revision, decision: 'rejected' })).catch(() => undefined) }}><X size={14} />{t('reject')}</button></div>}</section>}
    <section className="inspector-section"><header><h3>{t('errorRecovery')}</h3><RotateCcw size={14} /></header>
      {!owner && <p className="permission-note"><LockKeyhole size={13} /> {t('ownerRoleOnly')}</p>}
      {owner && (retryable || assignee !== task.assigneeAgentId) && <label className="compact-field"><span>{t('reassign')}</span><select value={assignee} onChange={(event) => setAssignee(event.target.value)}>{candidates.map((worker) => <option value={worker.agentId} key={worker.agentId}>{worker.displayName} · {t(worker.status)}</option>)}</select></label>}
      {owner && <div className="inline-actions">
        {(retryable || assignee !== task.assigneeAgentId) && <button className="button button--secondary" disabled={actionPending || !eligibleAssignee} onClick={() => { if (eligibleAssignee) void onRun(buildRetryTask({ taskId: task.taskId, executionId: task.executionId, assigneeAgentId: assignee, expectedRevision: task.revision })).catch(() => undefined) }}><RotateCcw size={14} />{assignee === task.assigneeAgentId ? t('retry') : t('reassign')}</button>}
        {cancellable && <button className="button button--danger-soft" disabled={actionPending} onClick={() => { void onRun(buildCancelTask({ taskId: task.taskId, executionId: task.executionId, expectedRevision: task.revision })).catch(() => undefined) }}><CircleOff size={14} />{t('cancel')}</button>}
      </div>}
    </section>
    {view.humanRequests.filter((request) => request.taskId === task.taskId).map((request) => { const status = effectiveHumanStatus(request.status, request.expiresAt, now); return <section className="inspector-section inspector-section--human" key={request.humanRequestId}><header><h3>{t('humanNeeded')}</h3><LockKeyhole size={14} /></header><StatusPill status={status} label={t(status)} /><p>{t('humanNeeded')} · {request.requiredAssurance}</p><small>{t('displayOnly')} · {formatRelativeTime(request.expiresAt, locale)}</small></section> })}
  </>
}

export function taskInspectorKey(task: Pick<Task, 'taskId' | 'executionId'>): string {
  return `${task.taskId}:${task.executionId}`
}

function ProjectInspector({ view, user, locale, t, now }: { view: CoordinationView; user: PortalUser; locale: Locale; t(key: MessageKey): string; now: number }): React.JSX.Element {
  const currentMember = view.members.find((member) => member.userId === user.userId)
  const pendingHuman = view.humanRequests.filter((request) => effectiveHumanStatus(request.status, request.expiresAt, now) === 'pending')
  return <>
    <section className="inspector-hero">
      <div className="inspector-hero__avatar"><Users size={23} /></div>
      <div><StatusPill status={view.project.status} label={view.project.status} /><h3>{view.project.displayName}</h3><p>{currentMember?.role ?? 'member'} · r{view.projectRevision}</p></div>
    </section>
    <section className="inspector-section"><header><h3>{t('objective')}</h3><ChevronRight size={14} /></header><p className="long-copy">{view.project.goal}</p></section>
    <section className="inspector-section"><header><h3>{t('projectMembers')}</h3><UserRound size={14} /></header><ul className="member-list">{view.members.map((member) => <li key={member.userId}><i>{member.displayName.slice(0, 1).toUpperCase()}</i><span><strong>{member.displayName}</strong><small>{member.role}</small></span>{member.role === 'owner' && <ShieldCheck size={14} />}</li>)}</ul></section>
    {pendingHuman.length > 0 && <section className="inspector-section inspector-section--human"><header><h3>{t('humanNeeded')}</h3><LockKeyhole size={14} /></header>{pendingHuman.map((request) => <div className="human-card" key={request.humanRequestId}><p>{t('humanNeeded')} · {request.requiredAssurance}</p><small>{formatTimestamp(request.expiresAt, locale)} · {t('displayOnly')}</small></div>)}</section>}
  </>
}
