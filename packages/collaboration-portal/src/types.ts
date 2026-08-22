export type ThemePreference = 'system' | 'light' | 'dark'
export type Locale = 'zh' | 'en'
export type PortalRoute = 'dashboard' | 'workers' | 'project'
export type PresenceStatus = 'online' | 'busy' | 'offline'
export type ProjectStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled'
export type ProjectRole = 'owner' | 'member' | 'observer'
export type TaskStatus = 'offered' | 'accepted' | 'rejected' | 'running' | 'needs_human' | 'succeeded' | 'failed' | 'cancelled'

export interface PortalUser {
  userId: string
  displayName: string
}

export interface PortalSession {
  authenticated: boolean
  user?: PortalUser
  csrfToken?: string
  idleExpiresAt?: string
  absoluteExpiresAt?: string
}

export interface TaskCounts {
  offered: number
  accepted: number
  rejected: number
  running: number
  needsHuman: number
  succeeded: number
  failed: number
  cancelled: number
}

export interface ProjectSummary {
  projectId: string
  displayName: string
  goal: string
  status: ProjectStatus
  role: ProjectRole
  memberCount: number
  taskCounts: TaskCounts
  pendingResultCount: number
  revision: number
  updatedAt: string
}

export interface ProjectPage {
  schemaVersion: 1
  type: 'project_list_page'
  items: ProjectSummary[]
  nextCursor?: string
}

export interface WorkerGpuSummary {
  vendor?: string
  model?: string
  memoryGB?: number
}

export interface PortalWorker {
  ownerUserId: string
  agentId: string
  displayName: string
  nodeType: 'desktop' | 'server'
  os: {
    family: 'macos' | 'windows' | 'linux'
    architecture: 'x64' | 'arm64'
  }
  runtimeIds: string[]
  capabilityIds: string[]
  gpu: WorkerGpuSummary[]
  status: PresenceStatus
  lastSeenAt: string
  profileExpiresAt: string
  revision: number
}

export interface WorkerDirectoryStats {
  total: number
  online: number
  busy: number
  offline: number
  desktop: number
  server: number
}

export interface WorkerDirectoryPage {
  schemaVersion: 1
  type: 'worker_directory_page'
  items: PortalWorker[]
  stats: WorkerDirectoryStats
  nextCursor?: string
  readAt: string
}

export interface OwnedAgent {
  agentId: string
  displayName: string
  nodeType: 'desktop' | 'server'
  connectionStatus: 'online' | 'offline'
  lastSeenAt?: string
  revision: number
}

export interface OwnedAgentList {
  schemaVersion: 1
  type: 'owned_agent_list'
  items: OwnedAgent[]
}

export interface ProjectBudget {
  maxTasks: number
  maxTasksPerRound: number
  maxCoordinationRounds: number
  maxTaskRetries: number
}

export interface Project {
  schemaVersion: number
  type: 'project'
  projectId: string
  ownerUserId: string
  displayName: string
  goal: string
  memberUserIds: string[]
  coordinatorAgentId: string
  status: ProjectStatus
  budget: ProjectBudget
  revision: number
  createdAt: string
  updatedAt: string
}

export interface ProjectMember {
  userId: string
  displayName: string
  role: ProjectRole
  active: boolean
}

export interface TaskProgress {
  percent: number
  summary: string
  reportedAt: string
}

export interface TaskCriterion {
  criterionId: string
  text: string
}

export interface Task {
  schemaVersion: number
  type: 'task'
  taskId: string
  projectId: string
  executionId: string
  createdByCoordinatorAgentId: string
  assigneeAgentId: string
  assigneeUserId: string
  title: string
  objective: string
  completionCriteria: TaskCriterion[]
  dependencyTaskIds: string[]
  requiredCapabilities: {
    osFamilies?: Array<'windows' | 'macos' | 'linux'>
    capabilityIds: string[]
    minimumEvidenceLevel?: string
    minGpuMemoryGB?: number
    vpnAccessIds: string[]
    slurmClusterIds: string[]
    requiredResourceRefIds: string[]
    requireLogSummary?: boolean
  }
  resourceRefIds: string[]
  authorizationRequirements: Array<{ id: string; kind: string; description: string }>
  status: TaskStatus
  attempt: number
  maxRetries: number
  progress?: TaskProgress
  resultSummary?: string
  resultProjectRecordId?: string
  safeFailureCode?: string
  safeFailureSummary?: string
  completedAt?: string
  revision: number
  createdAt: string
  updatedAt: string
  portalProjection?: { truncated: true; reason: 'item_byte_limit' }
}

export interface ProjectRecord {
  schemaVersion: number
  type: 'project_record'
  projectRecordId: string
  projectId: string
  kind: 'observation' | 'proposal' | 'decision' | 'summary' | 'task_result'
  status: 'proposed' | 'accepted' | 'rejected' | 'superseded'
  body: string
  authorUserId: string
  authorAgentId: string | null
  sourceTaskId: string | null
  sourceExecutionId: string | null
  sourceRevision: number
  criterionEvidence: Array<{ criterionId: string; summary: string; resourceRefIds: string[] }>
  resourceRefIds: string[]
  logSummary: string | null
  acceptedByUserId: string | null
  acceptedByAgentId: string | null
  acceptedAt: string | null
  revision: number
  createdAt: string
  updatedAt: string
  portalProjection?: { truncated: true; reason: 'item_byte_limit' }
}

export interface HumanNeeded {
  humanRequestId: string
  projectId: string
  sourceKind: 'worker' | 'coordinator'
  taskId: string | null
  executionId: string | null
  requiredAssurance: 'basic' | 'verified' | 'strong'
  status: 'pending' | 'answered' | 'expired' | 'cancelled'
  expiresAt: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface CoordinationView {
  schemaVersion: number
  type: 'project_coordination_view'
  projectId: string
  projectRevision: number
  project: Project
  members: ProjectMember[]
  tasks: Task[]
  records: ProjectRecord[]
  humanRequests: HumanNeeded[]
  pagination: CoordinationPagination
  readAt: string
}

export interface CoordinationPage {
  limit: number
  version: string
  nextCursor?: string
}

export interface CoordinationPagination {
  tasks: CoordinationPage
  records: CoordinationPage
  humanRequests: CoordinationPage
}

export interface CoordinationQuery {
  tasksCursor?: string
  recordsCursor?: string
  humanCursor?: string
  tasksLimit?: number
  recordsLimit?: number
  humanLimit?: number
}

export type PortalSelection =
  | { kind: 'worker'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'activity'; id: string }
  | null

export interface PortalWakeEvent {
  type?: string
  projectId: string
  changeKind: string
  revision: number
}

export interface ProjectListQuery {
  cursor?: string
  limit?: number
  statuses?: ProjectStatus[]
}

export interface WorkerDirectoryQuery {
  cursor?: string
  limit?: number
}

export interface CreateProjectBody {
  displayName: string
  goal: string
  memberUserIds: string[]
  coordinatorAgentId: string
  budget: ProjectBudget
}

export interface UpdateProjectMembersBody {
  expectedRevision: number
  addMemberUserIds: string[]
  removeMemberUserIds: string[]
}

export interface CreateTaskBody {
  expectedRevision: number
  assigneeAgentId: string
  title: string
  objective: string
  completionCriteria: string[]
  dependencyTaskIds: string[]
  capabilityIds: string[]
}

export interface CancelTaskBody {
  executionId: string
  expectedRevision: number
}

export interface RetryTaskBody extends CancelTaskBody {
  assigneeAgentId: string
}

export interface ReviewProjectRecordBody {
  expectedRevision: number
  decision: 'accepted' | 'rejected'
}

export interface PortalWriteContext {
  csrfToken: string
  idempotencyKey: string
}

export interface PortalSubscriptionError {
  code: 'permission_denied' | 'subscription_limit' | 'websocket_policy_rejected'
  message?: string
}

export type PortalCommand = Readonly<Record<string, unknown> & {
  protocolVersion: '1.0'
  requestId: string
  type: string
}>

export interface PortalClient {
  getSession(): Promise<PortalSession>
  loginUrl(returnTo?: string): string
  logout(csrfToken: string): Promise<void>
  listProjects(query?: ProjectListQuery): Promise<ProjectPage>
  listWorkers(query?: WorkerDirectoryQuery): Promise<WorkerDirectoryPage>
  listOwnedAgents(): Promise<OwnedAgentList>
  getCoordination(projectId: string, query?: CoordinationQuery): Promise<CoordinationView>
  createProject(body: CreateProjectBody, context: PortalWriteContext): Promise<Project>
  updateProjectMembers(projectId: string, body: UpdateProjectMembersBody, context: PortalWriteContext): Promise<Project>
  createTask(projectId: string, body: CreateTaskBody, context: PortalWriteContext): Promise<Task>
  cancelTask(taskId: string, body: CancelTaskBody, context: PortalWriteContext): Promise<Task>
  retryTask(taskId: string, body: RetryTaskBody, context: PortalWriteContext): Promise<Task>
  reviewProjectRecord(projectRecordId: string, body: ReviewProjectRecordBody, context: PortalWriteContext): Promise<ProjectRecord>
  subscribe(
    projectId: string,
    onWake: (event: PortalWakeEvent) => void,
    onState?: (connected: boolean) => void,
    onAuthenticationRequired?: () => void,
    onSubscriptionError?: (error: PortalSubscriptionError) => void
  ): () => void
}
