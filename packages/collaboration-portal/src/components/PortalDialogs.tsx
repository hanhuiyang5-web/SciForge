import { Check, Cpu, Laptop, Server } from 'lucide-react'
import { useMemo, useState } from 'react'
import { buildCreateProject, buildCreateTask, buildUpdateProjectMembers } from '../commands'
import type { MessageKey } from '../i18n'
import type { CoordinationView, OwnedAgent, PortalCommand, PortalUser, PortalWorker } from '../types'
import { Modal } from './Modal'
import { StatusPill } from './StatusPill'

interface SharedDialogProps {
  t(key: MessageKey): string
  actionPending: boolean
  onClose(): void
  onRun(command: PortalCommand): Promise<unknown>
}

export function CreateProjectDialog({ user, workers, agents, t, actionPending, onClose, onRun }: SharedDialogProps & { user: PortalUser; workers: PortalWorker[]; agents: OwnedAgent[] }): React.JSX.Element {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [coordinator, setCoordinator] = useState(agents.find((agent) => agent.connectionStatus === 'online')?.agentId ?? agents[0]?.agentId ?? '')
  const [selectedWorkers, setSelectedWorkers] = useState<string[]>([])
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const memberUserIds = [...new Set(selectedWorkers.map((id) => workers.find((worker) => worker.agentId === id)?.ownerUserId).filter((id): id is string => Boolean(id)))]
    await onRun(buildCreateProject({ ownerUserId: user.userId, displayName: name, goal, memberUserIds, coordinatorAgentId: coordinator }))
    onClose()
  }
  return (
    <Modal title={t('createProject')} description={t('ownerIncluded')} closeLabel={t('close')} onClose={onClose} wide>
      <form className="portal-form" onSubmit={(event) => { void submit(event).catch(() => undefined) }}>
        <div className="form-grid">
          <label><span>{t('projectName')}</span><input required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>{t('coordinator')}</span><select required value={coordinator} onChange={(event) => setCoordinator(event.target.value)}>{agents.map((agent) => <option value={agent.agentId} key={agent.agentId}>{agent.displayName} · {agent.nodeType}</option>)}</select></label>
        </div>
        <label><span>{t('projectGoal')}</span><textarea required maxLength={32_000} rows={4} value={goal} onChange={(event) => setGoal(event.target.value)} /></label>
        <fieldset className="worker-picker"><legend>{t('chooseWorkers')} <small>{selectedWorkers.length} {t('selected')}</small></legend>
          <div className="worker-picker__grid">
            {workers.map((worker) => {
              const checked = selectedWorkers.includes(worker.agentId)
              return <label className={`worker-option${checked ? ' is-selected' : ''}`} key={worker.agentId}>
                <input type="checkbox" checked={checked} onChange={() => setSelectedWorkers((current) => checked ? current.filter((id) => id !== worker.agentId) : [...current, worker.agentId])} />
                <i>{worker.nodeType === 'desktop' ? <Laptop size={16} /> : <Server size={16} />}</i>
                <span><strong>{worker.displayName}</strong><small>{worker.capabilityIds.slice(0, 2).join(' · ') || 'general'}</small></span>
                <StatusPill status={worker.status} label={t(worker.status)} />
                {checked && <Check className="worker-option__check" size={14} />}
              </label>
            })}
          </div>
        </fieldset>
        <footer className="modal-actions"><button type="button" className="button button--ghost" onClick={onClose}>{t('cancel')}</button><button className="button button--primary" disabled={actionPending || !coordinator || selectedWorkers.length === 0}>{t('submit')}</button></footer>
      </form>
    </Modal>
  )
}

export function CreateTaskDialog({ view, workers, t, actionPending, onClose, onRun }: SharedDialogProps & { view: CoordinationView; workers: PortalWorker[] }): React.JSX.Element {
  const [base] = useState(() => ({ projectId: view.projectId, revision: view.projectRevision }))
  const stale = view.projectId !== base.projectId || view.projectRevision !== base.revision
  const eligibleWorkers = workers.filter((worker) => view.project.memberUserIds.includes(worker.ownerUserId))
  const [assignee, setAssignee] = useState(eligibleWorkers.find((worker) => worker.status !== 'offline')?.agentId ?? eligibleWorkers[0]?.agentId ?? '')
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [criterion, setCriterion] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const eligibleAssignee = eligibleWorkers.some((worker) => worker.agentId === assignee)
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (stale || !eligibleAssignee) return
    await onRun(buildCreateTask({
      projectId: base.projectId,
      expectedRevision: base.revision,
      assigneeAgentId: assignee,
      title,
      objective,
      completionCriteria: criterion.split('\n').map((line) => line.trim()).filter(Boolean),
      capabilityIds: capabilities.split(',').map((item) => item.trim()).filter(Boolean)
    }))
    onClose()
  }
  return (
    <Modal title={t('createTask')} description={view.project.displayName} closeLabel={t('close')} onClose={onClose}>
      <form className="portal-form" onSubmit={(event) => { void submit(event).catch(() => undefined) }}>
        {stale && <p className="permission-note" role="alert">{t('revisionChanged')}</p>}
        <label><span>{t('taskTitle')}</span><input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>{t('assignee')}</span><select required value={assignee} onChange={(event) => setAssignee(event.target.value)}>{eligibleWorkers.map((worker) => <option key={worker.agentId} value={worker.agentId}>{worker.displayName} · {t(worker.status)} · {worker.nodeType}</option>)}</select></label>
        <label><span>{t('taskObjective')}</span><textarea required maxLength={32_000} rows={5} value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
        <label><span>{t('completionCriterion')}</span><textarea required maxLength={8_000} rows={3} placeholder="1 line = 1 criterion" value={criterion} onChange={(event) => setCriterion(event.target.value)} /></label>
        <label><span>{t('requiredCapabilities')}</span><input value={capabilities} onChange={(event) => setCapabilities(event.target.value)} placeholder="scientific.plotting, workspace.host" /></label>
        <footer className="modal-actions"><button type="button" className="button button--ghost" onClick={onClose}>{t('cancel')}</button><button className="button button--primary" disabled={actionPending || stale || !eligibleAssignee}>{t('submit')}</button></footer>
      </form>
    </Modal>
  )
}

export function ManageMembersDialog({ view, workers, t, actionPending, onClose, onRun }: SharedDialogProps & { view: CoordinationView; workers: PortalWorker[] }): React.JSX.Element {
  const [base] = useState(() => ({ projectId: view.projectId, revision: view.projectRevision, memberUserIds: [...view.project.memberUserIds] }))
  const stale = view.projectId !== base.projectId || view.projectRevision !== base.revision
  const candidates = useMemo(() => {
    const byUser = new Map<string, { userId: string; label: string; workers: PortalWorker[] }>()
    for (const member of view.members) byUser.set(member.userId, { userId: member.userId, label: member.displayName, workers: [] })
    for (const worker of workers) {
      const item = byUser.get(worker.ownerUserId) ?? { userId: worker.ownerUserId, label: worker.displayName, workers: [] }
      item.workers.push(worker)
      byUser.set(worker.ownerUserId, item)
    }
    return [...byUser.values()]
  }, [view.members, workers])
  const [selected, setSelected] = useState<string[]>(base.memberUserIds)
  const openTaskOwners = new Set(view.tasks.filter((task) => !['succeeded', 'failed', 'rejected', 'cancelled'].includes(task.status)).map((task) => task.assigneeUserId))
  const coordinatorOwner = workers.find((worker) => worker.agentId === view.project.coordinatorAgentId)?.ownerUserId
  const isLocked = (userId: string): boolean => userId === view.project.ownerUserId || userId === coordinatorOwner || openTaskOwners.has(userId)
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (stale) return
    const addMemberUserIds = selected.filter((userId) => !base.memberUserIds.includes(userId))
    const removeMemberUserIds = base.memberUserIds.filter((userId) => !selected.includes(userId))
    if (addMemberUserIds.length === 0 && removeMemberUserIds.length === 0) { onClose(); return }
    await onRun(buildUpdateProjectMembers({ projectId: base.projectId, expectedRevision: base.revision, addMemberUserIds, removeMemberUserIds }))
    onClose()
  }
  return (
    <Modal title={t('manageMembers')} description={t('memberRules')} closeLabel={t('close')} onClose={onClose} wide>
      <form className="portal-form" onSubmit={(event) => { void submit(event).catch(() => undefined) }}>
        {stale && <p className="permission-note" role="alert">{t('revisionChanged')}</p>}
        <fieldset className="member-picker" disabled={stale}><legend>{t('projectMembers')}</legend>
          {candidates.map((candidate) => {
            const checked = selected.includes(candidate.userId)
            const locked = isLocked(candidate.userId)
            return <label className={`member-option${checked ? ' is-selected' : ''}`} key={candidate.userId}>
              <input type="checkbox" checked={checked} disabled={locked} onChange={() => setSelected((items) => checked ? items.filter((id) => id !== candidate.userId) : [...items, candidate.userId])} />
              <i><Cpu size={15} /></i>
              <span><strong>{candidate.label}</strong><small>{candidate.workers.map((worker) => worker.displayName).join(' · ') || candidate.userId}</small></span>
              <em>{candidate.workers.length} Workers</em>
              {locked && <small className="member-option__locked">locked</small>}
            </label>
          })}
        </fieldset>
        <footer className="modal-actions"><button type="button" className="button button--ghost" onClick={onClose}>{t('cancel')}</button><button className="button button--primary" disabled={actionPending || stale}>{t('saveMembers')}</button></footer>
      </form>
    </Modal>
  )
}
