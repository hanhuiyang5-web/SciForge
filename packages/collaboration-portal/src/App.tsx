import {
  Activity, AlertCircle, ArrowRight, ChevronDown, CircleDot, Filter, FolderPlus, ListPlus,
  LoaderCircle, Plus, RefreshCw, Search, Users, Waypoints, X
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { createPortalClient } from './client'
import { formatRelativeTime } from './format'
import { type CoordinationCollection, type CoordinationPaginationState, usePortalData } from './hooks/usePortalData'
import { type MessageKey, translate } from './i18n'
import { applyPreferences, loadPreferences, savePreferences } from './preferences'
import { canMutateProject } from './permissions'
import type { CoordinationView, Locale, PortalClient, PortalWorker, Task, ThemePreference, WorkerDirectoryStats } from './types'
import { ActivityFeed } from './components/ActivityFeed'
import { CollectionLoadMore } from './components/CollectionLoadMore'
import { BrandMark } from './components/BrandMark'
import { Inspector } from './components/Inspector'
import { MetricStrip } from './components/MetricStrip'
import { CreateProjectDialog, CreateTaskDialog, ManageMembersDialog } from './components/PortalDialogs'
import { MobileNavigation, Sidebar } from './components/Sidebar'
import { TaskBoard } from './components/TaskBoard'
import { WorkerConstellation } from './components/WorkerConstellation'
import { WorkerTable } from './components/WorkerTable'

interface AppProps { client?: PortalClient }
type Dialog = 'project' | 'task' | 'members' | null

export default function App({ client = createPortalClient() }: AppProps): React.JSX.Element {
  const [preferences, setPreferences] = useState(loadPreferences)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [workerSearch, setWorkerSearch] = useState('')
  const [nodeFilter, setNodeFilter] = useState<'all' | 'desktop' | 'server'>('all')
  const [capabilityFilter, setCapabilityFilter] = useState<string | null>(null)
  const data = usePortalData(client)
  const t = useCallback((key: MessageKey): string => translate(preferences.locale, key), [preferences.locale])
  const updateTheme = (theme: ThemePreference): void => updatePreferences({ ...preferences, theme })
  const updateLocale = (locale: Locale): void => updatePreferences({ ...preferences, locale })
  const updatePreferences = (next: typeof preferences): void => { setPreferences(next); savePreferences(next); applyPreferences(next) }

  const selectedTaskId = data.selection?.kind === 'task' ? data.selection.id : null
  const selectedWorkerId = data.selection?.kind === 'worker' ? data.selection.id : null
  const selectWorker = (worker: PortalWorker): void => { data.setSelection({ kind: 'worker', id: worker.agentId }); setDrawerOpen(true) }
  const allCapabilities = useMemo(() => [...new Set(data.workers.flatMap((worker) => worker.capabilityIds))].sort(), [data.workers])
  const filteredWorkers = useMemo(() => {
    const query = workerSearch.trim().toLocaleLowerCase()
    return data.workers.filter((worker) => {
      if (nodeFilter !== 'all' && worker.nodeType !== nodeFilter) return false
      if (capabilityFilter && !worker.capabilityIds.includes(capabilityFilter)) return false
      if (!query) return true
      return [worker.displayName, worker.agentId, ...worker.capabilityIds, ...worker.runtimeIds].some((value) => value.toLocaleLowerCase().includes(query))
    })
  }, [capabilityFilter, data.workers, nodeFilter, workerSearch])
  const taskMetrics = useMemo(() => taskMetricSummary(data.view?.tasks ?? []), [data.view?.tasks])

  if (data.phase === 'loading') return <LoadingScreen t={t} />
  if (data.phase === 'unauthenticated' || !data.session?.authenticated || !data.session.user) return <LoginScreen client={client} locale={preferences.locale} theme={preferences.theme} t={t} onLocale={updateLocale} onTheme={updateTheme} />
  if (data.phase === 'error') return <ErrorScreen message={data.fatalError ?? t('unavailable')} t={t} onRetry={data.retryInitial} />

  const user = data.session.user
  const view = data.view
  const owner = canMutateProject(view, user.userId)
  return (
    <div className="portal-shell">
      <a className="skip-link" href="#portal-main">Skip to content</a>
      <Sidebar user={user} projects={data.projects} pagination={data.projectPagination} route={data.route} selectedProjectId={data.selectedProjectId} theme={preferences.theme} locale={preferences.locale} t={t} onRoute={data.setRoute} onProject={data.selectProject} onCreateProject={() => setDialog('project')} onLoadMoreProjects={data.loadMoreProjects} onTheme={updateTheme} onLocale={updateLocale} onLogout={() => { void data.logout() }} />
      <main className="portal-main" id="portal-main">
        <TopBar
          title={data.route === 'workers' ? t('workerDirectory') : view?.project.displayName ?? t('dashboard')}
          subtitle={data.route === 'workers' ? t('workerDirectoryHint') : view?.project.goal ?? t('researchControlRoom')}
          live={data.websocketConnected}
          updatedAt={data.route === 'workers' ? data.workersReadAt : view?.readAt ?? null}
          locale={preferences.locale}
          t={t}
          onRefresh={() => { void data.refresh() }}
          actions={data.route !== 'workers' && view ? <>
            {owner && <button className="button button--secondary" onClick={() => setDialog('members')}><Users size={15} />{t('manageMembers')}</button>}
            {owner && <button className="button button--primary" onClick={() => setDialog('task')}><ListPlus size={15} />{t('createTask')}</button>}
          </> : <button className="button button--primary" onClick={() => setDialog('project')}><FolderPlus size={15} />{t('createProject')}</button>}
        />
        <div className="portal-canvas">
          {data.route === 'dashboard' && <DashboardView workers={data.workers} stats={data.workerStats} view={view} pagination={data.coordinationPagination} taskMetrics={taskMetrics} selectedWorkerId={selectedWorkerId} selectedTaskId={selectedTaskId} capabilityFilter={capabilityFilter} capabilities={allCapabilities} locale={preferences.locale} t={t} onCapability={setCapabilityFilter} onWorker={selectWorker} onTask={(taskId) => { data.setSelection({ kind: 'task', id: taskId }); setDrawerOpen(true) }} onLoadMore={data.loadMore} onCreateProject={() => setDialog('project')} />}
          {data.route === 'workers' && <WorkerDirectoryView workers={filteredWorkers} stats={data.workerStats} view={view} pagination={data.workerPagination} selectedWorkerId={selectedWorkerId} capabilityFilter={capabilityFilter} capabilities={allCapabilities} search={workerSearch} nodeFilter={nodeFilter} locale={preferences.locale} t={t} onSearch={setWorkerSearch} onNodeFilter={setNodeFilter} onCapability={setCapabilityFilter} onWorker={selectWorker} onLoadMoreWorkers={data.loadMoreWorkers} />}
          {data.route === 'project' && <ProjectView view={view} workers={data.workers} stats={data.workerStats} pagination={data.coordinationPagination} taskMetrics={taskMetrics} selectedWorkerId={selectedWorkerId} selectedTaskId={selectedTaskId} capabilityFilter={capabilityFilter} capabilities={allCapabilities} locale={preferences.locale} t={t} onCapability={setCapabilityFilter} onWorker={selectWorker} onTask={(taskId) => { data.setSelection({ kind: 'task', id: taskId }); setDrawerOpen(true) }} onLoadMore={data.loadMore} canCreateTask={Boolean(owner)} onCreateTask={() => setDialog('task')} />}
        </div>
      </main>
      <Inspector view={view} workers={data.workers} selection={data.selection} user={user} locale={preferences.locale} t={t} actionPending={data.actionPending} pagination={data.coordinationPagination} drawerOpen={drawerOpen} onCloseDrawer={() => setDrawerOpen(false)} onLoadMore={data.loadMore} onRun={data.run} />
      <MobileNavigation route={data.route} t={t} onRoute={data.setRoute} />
      {data.actionError && <div className="error-toast" role="alert"><AlertCircle size={16} /><span>{data.actionError}</span><button aria-label={t('close')} onClick={data.clearActionError}><X size={14} /></button></div>}
      {dialog === 'project' && <CreateProjectDialog user={user} workers={data.workers} agents={data.ownedAgents} t={t} actionPending={data.actionPending} onClose={() => setDialog(null)} onRun={data.run} />}
      {dialog === 'task' && view && owner && <CreateTaskDialog view={view} workers={data.workers} t={t} actionPending={data.actionPending} onClose={() => setDialog(null)} onRun={data.run} />}
      {dialog === 'members' && view && <ManageMembersDialog view={view} workers={data.workers} t={t} actionPending={data.actionPending} onClose={() => setDialog(null)} onRun={data.run} />}
    </div>
  )
}

function TopBar({ title, subtitle, live, updatedAt, locale, t, actions, onRefresh }: { title: string; subtitle: string; live: boolean; updatedAt: string | null; locale: Locale; t(key: MessageKey): string; actions: React.ReactNode; onRefresh(): void }): React.JSX.Element {
  return <header className="topbar"><div className="topbar__identity"><p className="eyebrow">{t('pageTitle')}</p><h1>{title}</h1><p>{subtitle}</p></div><div className="topbar__actions"><span className={`connection-pill${live ? ' is-live' : ''}`} title={t('reconnectHint')}><CircleDot size={13} />{live ? t('systemLive') : t('systemReconnecting')}</span>{updatedAt && <small>{t('updated')} {formatRelativeTime(updatedAt, locale)}</small>}<button className="icon-button" aria-label={t('refresh')} onClick={onRefresh}><RefreshCw size={16} /></button>{actions}</div></header>
}

interface ViewShared { workers: PortalWorker[]; stats: WorkerDirectoryStats; view: CoordinationView | null; pagination: CoordinationPaginationState; taskMetrics: TaskMetricSummary; selectedWorkerId: string | null; selectedTaskId: string | null; capabilityFilter: string | null; capabilities: string[]; locale: Locale; t(key: MessageKey): string; onCapability(value: string | null): void; onWorker(worker: PortalWorker): void; onTask(taskId: string): void; onLoadMore(collection: CoordinationCollection): Promise<void> }
interface TaskMetricSummary { active: number; waiting: number; completed: number; failed: number }

function DashboardView(props: ViewShared & { onCreateProject(): void }): React.JSX.Element {
  const { workers, stats, view, pagination, taskMetrics, selectedWorkerId, selectedTaskId, capabilityFilter, capabilities, locale, t, onCapability, onWorker, onTask, onLoadMore, onCreateProject } = props
  return <div className="canvas-flow">
    <MetricStrip stats={stats} taskMetrics={taskMetrics} t={t} />
    <section className="portal-card portal-card--constellation"><CardHeader title={t('constellation')} description={t('constellationHint')} icon={<Waypoints size={16} />} controls={<CapabilityFilter capabilities={capabilities} value={capabilityFilter} t={t} onChange={onCapability} />} /><WorkerConstellation workers={workers} tasks={view?.tasks} selectedId={selectedWorkerId} capabilityFilter={capabilityFilter} locale={locale} t={t} onSelect={onWorker} /></section>
    <section className="portal-card"><CardHeader title={t('taskBoard')} description={t('taskBoardHint')} icon={<Activity size={16} />} />{view ? <><TaskBoard tasks={view.tasks} selectedId={selectedTaskId} locale={locale} t={t} onSelect={(task) => onTask(task.taskId)} /><CollectionLoadMore state={pagination.tasks} label="Tasks" t={t} onLoad={() => onLoadMore('tasks')} /></> : <EmptyProject t={t} onCreate={onCreateProject} />}</section>
  </div>
}

function WorkerDirectoryView({ workers, stats, view, pagination, selectedWorkerId, capabilityFilter, capabilities, search, nodeFilter, locale, t, onSearch, onNodeFilter, onCapability, onWorker, onLoadMoreWorkers }: Omit<ViewShared, 'taskMetrics' | 'selectedTaskId' | 'onTask' | 'pagination' | 'onLoadMore'> & { pagination: import('./hooks/usePortalData').DirectoryPaginationState; search: string; nodeFilter: 'all' | 'desktop' | 'server'; onSearch(value: string): void; onNodeFilter(value: 'all' | 'desktop' | 'server'): void; onLoadMoreWorkers(): Promise<void> }): React.JSX.Element {
  return <div className="canvas-flow"><section className="directory-toolbar"><label className="search-field"><Search size={15} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder={t('searchWorkers')} /><kbd>⌘K</kbd></label><label className="select-field"><Filter size={14} /><select value={nodeFilter} onChange={(event) => onNodeFilter(event.target.value as typeof nodeFilter)}><option value="all">{t('all')}</option><option value="desktop">{t('desktop')}</option><option value="server">{t('server')}</option></select><ChevronDown size={13} /></label><CapabilityFilter capabilities={capabilities} value={capabilityFilter} t={t} onChange={onCapability} /></section><MetricStrip stats={stats} taskMetrics={taskMetricSummary(view?.tasks ?? [])} t={t} /><section className="portal-card portal-card--constellation portal-card--compact"><CardHeader title={t('constellation')} description={t('constellationHint')} icon={<Waypoints size={16} />} /><WorkerConstellation workers={workers} tasks={view?.tasks} selectedId={selectedWorkerId} capabilityFilter={null} locale={locale} t={t} onSelect={onWorker} /></section><section className="portal-card portal-card--table"><CardHeader title={t('workerDirectory')} description={`${workers.length} ${t('selected')}`} icon={<Users size={16} />} /><WorkerTable workers={workers} selectedId={selectedWorkerId} locale={locale} t={t} onSelect={onWorker} /><CollectionLoadMore state={pagination} label="Workers" t={t} onLoad={onLoadMoreWorkers} /></section></div>
}

function ProjectView({ workers, stats, view, pagination, taskMetrics, selectedWorkerId, selectedTaskId, capabilityFilter, capabilities, locale, t, onCapability, onWorker, onTask, onLoadMore, canCreateTask, onCreateTask }: ViewShared & { canCreateTask: boolean; onCreateTask(): void }): React.JSX.Element {
  if (!view) return <div className="canvas-flow"><div className="empty-project"><i><FolderPlus size={24} /></i><h2>{t('noProjects')}</h2><p>{t('ownerRoleOnly')}</p></div></div>
  const projectWorkers = workers.filter((worker) => view.project.memberUserIds.includes(worker.ownerUserId))
  return <div className="canvas-flow"><MetricStrip stats={{ ...stats, total: projectWorkers.length, online: projectWorkers.filter((worker) => worker.status === 'online').length, busy: projectWorkers.filter((worker) => worker.status === 'busy').length, offline: projectWorkers.filter((worker) => worker.status === 'offline').length, desktop: projectWorkers.filter((worker) => worker.nodeType === 'desktop').length, server: projectWorkers.filter((worker) => worker.nodeType === 'server').length }} taskMetrics={taskMetrics} t={t} /><section className="portal-card portal-card--constellation portal-card--compact"><CardHeader title={t('projectMembers')} description={t('constellationHint')} icon={<Waypoints size={16} />} controls={<CapabilityFilter capabilities={capabilities} value={capabilityFilter} t={t} onChange={onCapability} />} /><WorkerConstellation workers={projectWorkers} tasks={view.tasks} selectedId={selectedWorkerId} capabilityFilter={capabilityFilter} locale={locale} t={t} onSelect={onWorker} /></section><section className="portal-card"><CardHeader title={t('taskBoard')} description={`${view.tasks.length} Tasks · r${view.projectRevision}`} icon={<Activity size={16} />} controls={canCreateTask ? <button className="text-button" onClick={onCreateTask}><Plus size={14} />{t('newTask')}</button> : undefined} /><TaskBoard tasks={view.tasks} selectedId={selectedTaskId} locale={locale} t={t} onSelect={(task) => onTask(task.taskId)} /><CollectionLoadMore state={pagination.tasks} label="Tasks" t={t} onLoad={() => onLoadMore('tasks')} /></section><section className="portal-card portal-card--mobile-activity"><CardHeader title={t('activity')} description={t('taskBoardHint')} icon={<Activity size={16} />} /><ActivityFeed view={view} locale={locale} t={t} /><div className="collection-pagination-group"><CollectionLoadMore state={pagination.records} label="Records" t={t} onLoad={() => onLoadMore('records')} /><CollectionLoadMore state={pagination.humanRequests} label="HumanNeeded" t={t} onLoad={() => onLoadMore('humanRequests')} /></div></section></div>
}

function CardHeader({ title, description, icon, controls }: { title: string; description: string; icon: React.ReactNode; controls?: React.ReactNode }): React.JSX.Element { return <header className="card-header"><div className="card-header__icon">{icon}</div><div><h2>{title}</h2><p>{description}</p></div>{controls && <div className="card-header__controls">{controls}</div>}</header> }
function CapabilityFilter({ capabilities, value, t, onChange }: { capabilities: string[]; value: string | null; t(key: MessageKey): string; onChange(value: string | null): void }): React.JSX.Element { return <label className="select-field select-field--capability"><Filter size={13} /><select aria-label={t('capability')} value={value ?? ''} onChange={(event) => onChange(event.target.value || null)}><option value="">{t('allCapabilities')}</option>{capabilities.map((capability) => <option value={capability} key={capability}>{capability}</option>)}</select><ChevronDown size={12} /></label> }
function EmptyProject({ t, onCreate }: { t(key: MessageKey): string; onCreate(): void }): React.JSX.Element { return <div className="empty-project"><i><FolderPlus size={24} /></i><h2>{t('noProjects')}</h2><p>{t('taskBoardHint')}</p><button className="button button--primary" onClick={onCreate}>{t('createProject')}<ArrowRight size={14} /></button></div> }

function LoginScreen({ client, locale, theme, t, onLocale, onTheme }: { client: PortalClient; locale: Locale; theme: ThemePreference; t(key: MessageKey): string; onLocale(locale: Locale): void; onTheme(theme: ThemePreference): void }): React.JSX.Element {
  return <main className="auth-screen"><div className="auth-screen__grid" aria-hidden="true" /><header><BrandMark /><div><button onClick={() => onLocale(locale === 'zh' ? 'en' : 'zh')}>{locale === 'zh' ? 'EN' : '中'}</button><button onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀' : '◐'}</button></div></header><section className="auth-card"><div className="auth-card__orbital" aria-hidden="true"><i /><i /><i /><span><Waypoints size={26} /></span></div><p className="eyebrow">{t('pageTitle')}</p><h1>{t('signInTitle')}</h1><p>{t('signInBody')}</p><a className="button button--primary button--large" href={client.loginUrl()}>{t('signIn')}<ArrowRight size={16} /></a><small><CircleDot size={11} />{t('oidcBff')}</small></section><footer>cloud-test.sciforge.cn · a-https-oidc-test</footer></main>
}
function LoadingScreen({ t }: { t(key: MessageKey): string }): React.JSX.Element { return <main className="state-screen"><BrandMark /><LoaderCircle className="spin" size={22} /><p>{t('loading')}</p></main> }
function ErrorScreen({ message, t, onRetry }: { message: string; t(key: MessageKey): string; onRetry(): void }): React.JSX.Element { return <main className="state-screen"><BrandMark /><AlertCircle size={25} /><h1>{t('unavailable')}</h1><p>{message}</p><button className="button button--primary" onClick={onRetry}>{t('tryAgain')}</button></main> }
function taskMetricSummary(tasks: Task[]): TaskMetricSummary { return { active: tasks.filter((task) => task.status === 'running').length, waiting: tasks.filter((task) => ['offered', 'accepted', 'needs_human'].includes(task.status)).length, completed: tasks.filter((task) => task.status === 'succeeded').length, failed: tasks.filter((task) => ['failed', 'rejected'].includes(task.status)).length } }
