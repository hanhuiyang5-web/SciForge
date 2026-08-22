import type { PortalCommand, ProjectBudget, ProjectStatus } from './types'

type IdFactory = (prefix: string) => string

const defaultIdFactory: IdFactory = (prefix) => {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `${Date.now()}${Math.random().toString(36).slice(2)}`
  return `${prefix}_${random}`
}

export interface CommandContext {
  idFactory?: IdFactory
}

interface PageInput {
  cursor?: string
  limit?: number
}

interface CreateProjectInput {
  ownerUserId: string
  displayName: string
  goal: string
  memberUserIds: string[]
  coordinatorAgentId: string
  budget?: ProjectBudget
}

interface UpdateMembersInput {
  projectId: string
  expectedRevision: number
  addMemberUserIds: string[]
  removeMemberUserIds: string[]
}

interface CreateTaskInput {
  projectId: string
  expectedRevision: number
  assigneeAgentId: string
  title: string
  objective: string
  completionCriteria: string[]
  dependencyTaskIds?: string[]
  capabilityIds?: string[]
}

interface TaskIdentityInput {
  taskId: string
  executionId: string
  expectedRevision: number
}

const defaultBudget: ProjectBudget = {
  maxTasks: 200,
  maxTasksPerRound: 16,
  maxCoordinationRounds: 50,
  maxTaskRetries: 3
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

function envelope(type: string, context: CommandContext): PortalCommand {
  const idFactory = context.idFactory ?? defaultIdFactory
  return { protocolVersion: '1.0', requestId: idFactory('req'), type }
}

function readCommand(type: string, fields: Record<string, unknown>, context: CommandContext): PortalCommand {
  return Object.freeze(compact({ ...envelope(type, context), ...fields }))
}

function writeCommand(type: string, fields: Record<string, unknown>, context: CommandContext): PortalCommand {
  const idFactory = context.idFactory ?? defaultIdFactory
  return Object.freeze(compact({ ...envelope(type, context), idempotencyKey: idFactory('idem'), ...fields }))
}

function page(input: PageInput): Required<Pick<PageInput, 'limit'>> & Pick<PageInput, 'cursor'> {
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Portal page limit must be between 1 and 50.')
  if (input.cursor !== undefined && (input.cursor.length < 1 || input.cursor.length > 2_048)) throw new TypeError('Invalid page cursor.')
  return compact({ limit, cursor: input.cursor })
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Expected revision must be a positive safe integer.')
}

function required(value: string, label: string, max: number): string {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > max) throw new TypeError(`${label} is required and must not exceed ${max} characters.`)
  return normalized
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

export function buildProjectList(input: PageInput & { statuses?: ProjectStatus[] } = {}, context: CommandContext = {}): PortalCommand {
  return readCommand('project.list', { ...page(input), statuses: input.statuses ? unique(input.statuses) : undefined }, context)
}

export function buildWorkerDirectoryPage(input: PageInput = {}, context: CommandContext = {}): PortalCommand {
  return readCommand('worker.directory.page', page(input), context)
}

export function buildOwnedAgentList(context: CommandContext = {}): PortalCommand {
  return readCommand('agent.owned.list', {}, context)
}

export function buildCoordinationView(projectId: string, context: CommandContext = {}): PortalCommand {
  return readCommand('project.coordination_view.get', { projectId }, context)
}

export function buildCreateProject(input: CreateProjectInput, context: CommandContext = {}): PortalCommand {
  const members = unique(input.memberUserIds)
  if (!members.includes(input.ownerUserId)) members.unshift(input.ownerUserId)
  return writeCommand('project.create', {
    ownerUserId: input.ownerUserId,
    displayName: required(input.displayName, 'Project name', 200),
    goal: required(input.goal, 'Project goal', 32_000),
    memberUserIds: members,
    coordinatorAgentId: input.coordinatorAgentId,
    budget: input.budget ?? defaultBudget
  }, context)
}

export function buildUpdateProjectMembers(input: UpdateMembersInput, context: CommandContext = {}): PortalCommand {
  assertRevision(input.expectedRevision)
  const addMemberUserIds = unique(input.addMemberUserIds)
  const removeMemberUserIds = unique(input.removeMemberUserIds)
  if (addMemberUserIds.some((id) => removeMemberUserIds.includes(id))) throw new TypeError('A member cannot be added and removed in the same command.')
  if (addMemberUserIds.length === 0 && removeMemberUserIds.length === 0) throw new TypeError('Member update must add or remove at least one member.')
  return writeCommand('project.members.update', {
    projectId: input.projectId,
    expectedRevision: input.expectedRevision,
    addMemberUserIds,
    removeMemberUserIds
  }, context)
}

export function buildCreateTask(input: CreateTaskInput, context: CommandContext = {}): PortalCommand {
  assertRevision(input.expectedRevision)
  const criteria = input.completionCriteria.map((criterion) => required(criterion, 'Completion criterion', 2_000))
  if (criteria.length < 1 || criteria.length > 100) throw new TypeError('A Task needs between 1 and 100 completion criteria.')
  return writeCommand('task.create', {
    projectId: input.projectId,
    assigneeAgentId: input.assigneeAgentId,
    title: required(input.title, 'Task title', 200),
    objective: required(input.objective, 'Task objective', 32_000),
    completionCriteria: criteria,
    dependencyTaskIds: unique(input.dependencyTaskIds ?? []),
    requiredCapabilities: {
      capabilityIds: unique(input.capabilityIds ?? []),
      vpnAccessIds: [],
      slurmClusterIds: [],
      requiredResourceRefIds: []
    },
    resourceRefIds: [],
    authorizationRequirements: [],
    expectedRevision: input.expectedRevision
  }, context)
}

export function buildCancelTask(input: TaskIdentityInput, context: CommandContext = {}): PortalCommand {
  assertRevision(input.expectedRevision)
  return writeCommand('task.transition', {
    taskId: input.taskId,
    executionId: input.executionId,
    expectedRevision: input.expectedRevision,
    status: 'cancelled'
  }, context)
}

export function buildRetryTask(input: TaskIdentityInput & { assigneeAgentId: string }, context: CommandContext = {}): PortalCommand {
  assertRevision(input.expectedRevision)
  return writeCommand('task.retry', {
    taskId: input.taskId,
    executionId: input.executionId,
    assigneeAgentId: input.assigneeAgentId,
    expectedRevision: input.expectedRevision
  }, context)
}

export function buildReviewResult(input: { projectRecordId: string; expectedRevision: number; decision: 'accepted' | 'rejected' }, context: CommandContext = {}): PortalCommand {
  assertRevision(input.expectedRevision)
  return writeCommand('project_record.accept', input, context)
}

export function assertExactPortalCommand(command: PortalCommand): PortalCommand {
  const common = ['protocolVersion', 'requestId', 'type']
  const shapes: Record<string, string[]> = {
    'project.list': [...common, 'cursor', 'limit', 'statuses'],
    'worker.directory.page': [...common, 'cursor', 'limit'],
    'agent.owned.list': common,
    'project.coordination_view.get': [...common, 'projectId'],
    'project.create': [...common, 'idempotencyKey', 'ownerUserId', 'displayName', 'goal', 'memberUserIds', 'coordinatorAgentId', 'budget'],
    'project.members.update': [...common, 'idempotencyKey', 'projectId', 'expectedRevision', 'addMemberUserIds', 'removeMemberUserIds'],
    'task.create': [...common, 'idempotencyKey', 'projectId', 'assigneeAgentId', 'title', 'objective', 'completionCriteria', 'dependencyTaskIds', 'requiredCapabilities', 'resourceRefIds', 'authorizationRequirements', 'expectedRevision'],
    'task.transition': [...common, 'idempotencyKey', 'taskId', 'executionId', 'expectedRevision', 'status'],
    'task.retry': [...common, 'idempotencyKey', 'taskId', 'executionId', 'assigneeAgentId', 'expectedRevision'],
    'project_record.accept': [...common, 'idempotencyKey', 'projectRecordId', 'expectedRevision', 'decision']
  }
  const allowed = shapes[command.type]
  if (!allowed) throw new TypeError(`Unsupported Portal command: ${command.type}`)
  const unexpected = Object.keys(command).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new TypeError(`Unexpected fields for ${command.type}: ${unexpected.join(', ')}`)
  if (command.protocolVersion !== '1.0' || !/^req_[A-Za-z0-9]{12,64}$/u.test(command.requestId)) throw new TypeError('Invalid Portal command envelope.')
  if ('idempotencyKey' in command && (typeof command.idempotencyKey !== 'string' || !/^idem_[A-Za-z0-9._:-]{11,123}$/u.test(command.idempotencyKey))) {
    throw new TypeError('Invalid Portal command idempotency key.')
  }
  return command
}
