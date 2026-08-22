import type {
  CoordinationView, OwnedAgentList, PortalClient, PortalSession, PortalSubscriptionError, PortalWakeEvent,
  PortalWorker, ProjectPage, ProjectSummary, Task, WorkerDirectoryPage
} from './types'

const now = new Date()
const ago = (seconds: number): string => new Date(now.getTime() - seconds * 1_000).toISOString()
const future = (seconds: number): string => new Date(now.getTime() + seconds * 1_000).toISOString()
const ownerId = 'usr_orchestrator01'
const projectId = 'prj_proteinatlas01'

const workers: PortalWorker[] = [
  worker('agt_structuremac01', ownerId, 'Structure Mac', 'desktop', 'macos', 'arm64', 'online', ['protein.structure', 'scientific.plotting'], ['codex-runtime'], 7, []),
  worker('agt_omicsdesktop01', 'usr_workeromics001', 'Omics Desktop', 'desktop', 'windows', 'x64', 'busy', ['singlecell.analysis', 'workspace.omics'], ['codex-runtime', 'python-3.12'], 12, [{ vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24 }]),
  worker('agt_gpucluster001', 'usr_workergpu0001', 'GPU Server 02', 'server', 'linux', 'x64', 'busy', ['protein.structure', 'image.generation'], ['codex-runtime', 'cuda-12.6'], 4, [{ vendor: 'NVIDIA', model: 'A100', memoryGB: 80 }]),
  worker('agt_plottingmac01', 'usr_workerplot001', 'Plotting Mac mini', 'desktop', 'macos', 'arm64', 'online', ['scientific.plotting', 'workspace.tabular'], ['codex-runtime', 'r-4.5'], 22, []),
  worker('agt_archivebox001', 'usr_workerarchive1', 'Archive Server', 'server', 'linux', 'x64', 'offline', ['workspace.host', 'dataset.archive'], ['codex-runtime'], 184, [])
]

const tasks: Task[] = [
  task('tsk_foldensemble01', workers[2]!, 'Fold ensemble', 'Generate five ranked structures and report confidence.', 'running', 64, 'Model 4 of 5 is being relaxed.'),
  task('tsk_qcclusters001', workers[1]!, 'QC cell clusters', 'Review doublets and annotate cluster quality.', 'needs_human', 45, 'Local dataset approval is needed.'),
  task('tsk_plotmetrics001', workers[3]!, 'Plot benchmark', 'Render the approved benchmark panels.', 'succeeded', 100, 'Five panels rendered and validated.'),
  task('tsk_fetchinputs001', workers[4]!, 'Archive inputs', 'Bind durable input references.', 'offered', 0, 'Queued for durable delivery.'),
  task('tsk_checkmotifs001', workers[0]!, 'Check motifs', 'Compare active-site motifs.', 'accepted', 12, 'Worker acknowledged the offer.')
]

const project: ProjectSummary = {
  projectId, displayName: 'Protein Structure Atlas', goal: 'Build a verified, reproducible atlas of candidate structures.',
  status: 'active', role: 'owner', memberCount: 5,
  taskCounts: { offered: 1, accepted: 1, rejected: 0, running: 1, needsHuman: 1, succeeded: 1, failed: 0, cancelled: 0 },
  pendingResultCount: 1, revision: 18, updatedAt: ago(8)
}

const coordination: CoordinationView = {
  schemaVersion: 1, type: 'project_coordination_view', projectId, projectRevision: 18,
  project: { schemaVersion: 1, type: 'project', projectId, ownerUserId: ownerId, displayName: project.displayName, goal: project.goal, memberUserIds: [...new Set(workers.map((item) => item.ownerUserId))], coordinatorAgentId: workers[0]!.agentId, status: 'active', budget: { maxTasks: 200, maxTasksPerRound: 16, maxCoordinationRounds: 50, maxTaskRetries: 3 }, revision: 18, createdAt: ago(90_000), updatedAt: ago(8) },
  members: [...new Set(workers.map((item) => item.ownerUserId))].map((userId, index) => ({ userId, displayName: index === 0 ? 'Orchestrator Alpha' : `Researcher ${index}`, role: index === 0 ? 'owner' : 'member', active: true })),
  tasks,
  records: [{ schemaVersion: 1, type: 'project_record', projectRecordId: 'rec_plotresult001', projectId, kind: 'task_result', status: 'proposed', body: 'Benchmark panels are ready for Owner review.', authorUserId: workers[3]!.ownerUserId, authorAgentId: workers[3]!.agentId, sourceTaskId: tasks[2]!.taskId, sourceExecutionId: tasks[2]!.executionId, sourceRevision: tasks[2]!.revision, criterionEvidence: [], resourceRefIds: [], logSummary: 'visual-regression: passed', acceptedByUserId: null, acceptedByAgentId: null, acceptedAt: null, revision: 1, createdAt: ago(80), updatedAt: ago(80) }],
  humanRequests: [{ humanRequestId: 'hrq_datasetaccess01', projectId, sourceKind: 'worker', taskId: tasks[1]!.taskId, executionId: tasks[1]!.executionId, requiredAssurance: 'strong', status: 'pending', expiresAt: future(1_800), revision: 1, createdAt: ago(42), updatedAt: ago(42) }],
  pagination: { tasks: { limit: 100, version: 'tasks:3:12' }, records: { limit: 100, version: 'records:1:1' }, humanRequests: { limit: 50, version: 'human:1:2' } },
  readAt: ago(3)
}

export function createDemoClient(): PortalClient {
  return {
    async getSession(): Promise<PortalSession> { return { authenticated: true, user: { userId: ownerId, displayName: 'Orchestrator Alpha' }, csrfToken: 'demo-csrf', idleExpiresAt: future(1_800), absoluteExpiresAt: future(28_800) } },
    loginUrl: () => '/portal/',
    async logout(): Promise<void> {},
    async listProjects(): Promise<ProjectPage> { return { schemaVersion: 1, type: 'project_list_page', items: [project] } },
    async listWorkers(): Promise<WorkerDirectoryPage> { return { schemaVersion: 1, type: 'worker_directory_page', stats: { total: workers.length, online: 2, busy: 2, offline: 1, desktop: 3, server: 2 }, items: workers, readAt: ago(3) } },
    async listOwnedAgents(): Promise<OwnedAgentList> { return { schemaVersion: 1, type: 'owned_agent_list', items: [{ agentId: workers[0]!.agentId, displayName: workers[0]!.displayName, nodeType: 'desktop', connectionStatus: 'online', lastSeenAt: ago(7), revision: 4 }] } },
    async getCoordination(): Promise<CoordinationView> { return coordination },
    async createProject() { return coordination.project },
    async updateProjectMembers() { return coordination.project },
    async createTask() { return tasks[0]! },
    async cancelTask() { return tasks[0]! },
    async retryTask() { return tasks[0]! },
    async reviewProjectRecord() { return coordination.records[0]! },
    subscribe(_projectId: string, _onWake: (event: PortalWakeEvent) => void, onState?: (connected: boolean) => void, _onAuthenticationRequired?: () => void, _onSubscriptionError?: (error: PortalSubscriptionError) => void): () => void { onState?.(true); return () => onState?.(false) }
  }
}

function worker(agentId: string, ownerUserId: string, displayName: string, nodeType: 'desktop' | 'server', family: 'macos' | 'windows' | 'linux', architecture: 'x64' | 'arm64', status: PortalWorker['status'], capabilityIds: string[], runtimeIds: string[], seenSeconds: number, gpu: PortalWorker['gpu']): PortalWorker {
  return { ownerUserId, agentId, displayName, nodeType, os: { family, architecture }, runtimeIds, capabilityIds, gpu, status, lastSeenAt: ago(seenSeconds), profileExpiresAt: future(19_000), revision: 3 }
}

function task(taskId: string, assignee: PortalWorker, title: string, objective: string, status: Task['status'], percent: number, summary: string): Task {
  const succeeded = status === 'succeeded'
  return { schemaVersion: 1, type: 'task', taskId, projectId, executionId: `exe_${taskId.slice(4)}`, createdByCoordinatorAgentId: workers[0]!.agentId, assigneeAgentId: assignee.agentId, assigneeUserId: assignee.ownerUserId, title, objective, completionCriteria: [{ criterionId: `cri_${taskId.slice(4)}`, text: 'Return a bounded summary with reproducible evidence.' }], dependencyTaskIds: [], requiredCapabilities: { capabilityIds: assignee.capabilityIds.slice(0, 1), vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: [] }, resourceRefIds: [], authorizationRequirements: [], status, attempt: 1, maxRetries: 3, progress: percent > 0 ? { percent, summary, reportedAt: ago(15) } : undefined, resultSummary: succeeded ? summary : undefined, resultProjectRecordId: succeeded ? 'rec_plotresult001' : undefined, completedAt: succeeded ? ago(80) : undefined, revision: 4, createdAt: ago(2_400), updatedAt: ago(Math.max(8, 100 - percent)) }
}
