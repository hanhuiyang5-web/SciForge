import { describe, expect, it } from 'vitest'

import {
  FakeClock,
  FakeCollaborationRepository
} from '../../../test-fixtures/collaboration/fake-adapters.mjs'
import type { AgentActor, UserActor } from './auth.js'
import {
  CollaborationService,
  MAX_ACTIVE_PROJECT_MEMBERSHIPS_PER_USER,
  MAX_HUMAN_REQUESTS_PER_PROJECT,
  MAX_PROJECT_RECORDS_PER_PROJECT
} from './service.js'

const ISSUER = 'https://login-test.sciforge.cn/realms/SciForge'

function seedUser(
  repository: FakeCollaborationRepository,
  userId: string,
  label: string,
  issuer = ISSUER
): UserActor {
  const at = '2026-08-15T01:00:00.000Z'
  const identityId = `oid_${label}Identity001`
  repository.state.users.set(userId, {
    userId, displayName: label, status: 'active', revision: 1, createdAt: at, updatedAt: at
  })
  repository.state.oidcIdentities.set(identityId, {
    identityId,
    userId,
    issuer,
    subject: `subject-${label}`,
    status: 'active',
    revision: 1,
    createdAt: at,
    updatedAt: at
  })
  return {
    kind: 'user',
    actorKey: `oidc:${identityId}`,
    userId,
    identityId,
    issuer,
    subject: `subject-${label}`,
    authTime: Date.parse(at) / 1_000,
    assurance: 'verified'
  }
}

function seedAgent(
  repository: FakeCollaborationRepository,
  input: {
    agentId: string
    ownerUserId: string
    lastSeenAt: string
    connectionStatus?: 'online' | 'offline'
    agentStatus?: 'active' | 'revoked'
    deviceStatus?: 'active' | 'revoked'
    profileExpiresAt?: string
    profileOwnerUserId?: string
    nodeType?: 'desktop' | 'server'
  }
): void {
  const deviceId = `dev_${input.agentId.slice(4)}Device`
  const nodeType = input.nodeType ?? 'desktop'
  repository.state.devices.set(deviceId, {
    deviceId,
    userId: input.ownerUserId,
    installationId: `ins_${input.agentId.slice(4)}Install`,
    displayName: `${input.agentId} device`,
    platform: { os: 'linux', arch: 'x64', appVersion: '0.2.0' },
    publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid: 'portal-test', x: 'test' },
    capabilitySummary: ['research.execute'],
    status: input.deviceStatus ?? 'active',
    revision: 1,
    createdAt: '2026-08-15T01:00:00.000Z',
    updatedAt: input.lastSeenAt
  })
  repository.state.agents.set(input.agentId, {
    agentId: input.agentId,
    deviceId,
    ownerUserId: input.ownerUserId,
    displayName: `${input.agentId} worker`,
    nodeType,
    capabilities: ['research.execute'],
    status: input.agentStatus ?? 'active',
    connectionStatus: input.connectionStatus ?? 'online',
    credentialGeneration: 1,
    revision: 2,
    lastSeenAt: input.lastSeenAt,
    updatedAt: input.lastSeenAt,
    ...(input.agentStatus === 'revoked' ? { revokedAt: input.lastSeenAt } : {})
  })
  repository.state.credentials.set(`credential_${input.agentId.slice(4)}`, {
    credentialId: `credential_${input.agentId.slice(4)}`,
    kind: 'agent_device',
    subjectUserId: input.ownerUserId,
    subjectAgentId: input.agentId,
    tokenDigest: `digest-${input.agentId}`,
    assurance: 'device',
    generation: 1,
    createdAt: input.lastSeenAt
  })
  repository.state.capabilityProfiles.set(input.agentId, {
    agentId: input.agentId,
    ownerUserId: input.profileOwnerUserId ?? input.ownerUserId,
    nodeType: nodeType === 'desktop' ? 'personal_computer' : 'institution_server',
    osFamily: 'linux',
    osArchitecture: 'x64',
    runtimeIds: ['runtime.portal'],
    capabilities: [{ capabilityId: 'research.execute', evidence: {
      level: 'verified', checkedAt: input.lastSeenAt
    } }],
    gpu: [{ vendor: 'NVIDIA', model: 'L4', memoryGB: 24, evidence: {
      level: 'detected', checkedAt: input.lastSeenAt
    } }],
    vpnAccessIds: [],
    slurmClusterIds: [],
    accessibleResourceRefIds: [],
    resultReturnPolicy: { summary: true, evidenceRefs: true, resourceRefs: true, logSummary: true,
      fullFileRequiresConfirmation: true, fullLogRequiresConfirmation: true },
    reportedAt: input.lastSeenAt,
    expiresAt: input.profileExpiresAt ?? '2026-08-15T03:00:00.000Z',
    revision: 1,
    createdAt: input.lastSeenAt,
    updatedAt: input.lastSeenAt
  })
}

function agentActor(agentId: string, userId: string): AgentActor {
  return {
    kind: 'agent_device',
    actorKey: `agent:${agentId}`,
    userId,
    agentId,
    deviceId: `dev_${agentId.slice(4)}Device`,
    credentialId: `credential_${agentId.slice(4)}`,
    credentialGeneration: 1,
    assurance: 'device'
  }
}

function seedActiveMemberships(
  repository: FakeCollaborationRepository,
  userId: string,
  count: number,
  prefix: string
): void {
  for (let index = 0; index < count; index += 1) {
    const projectId = `prj_${prefix}${String(index).padStart(8, '0')}`
    repository.state.projectMembers.set(`${projectId}:${userId}`, {
      projectId,
      userId,
      role: 'member',
      active: true,
      createdAt: '2026-08-15T01:00:00.000Z'
    })
  }
}

function seedProject(
  repository: FakeCollaborationRepository,
  input: {
    projectId: string
    ownerUserId: string
    coordinatorAgentId: string
    memberUserIds: string[]
    updatedAt?: string
  }
): void {
  const at = input.updatedAt ?? '2026-08-15T01:30:00.000Z'
  repository.state.projects.set(input.projectId, {
    projectId: input.projectId,
    ownerUserId: input.ownerUserId,
    displayName: `${input.projectId} project`,
    goal: 'Coordinate a bounded multi-Worker test.',
    status: 'active',
    coordinatorAgentId: input.coordinatorAgentId,
    budgets: { maxTasks: 100, maxTasksPerRound: 20, maxTaskRetries: 2, maxCoordinationRounds: 20 },
    coordinationRound: 1,
    revision: 1,
    createdAt: '2026-08-15T01:00:00.000Z',
    updatedAt: at
  })
  for (const userId of input.memberUserIds) {
    repository.state.projectMembers.set(`${input.projectId}:${userId}`, {
      projectId: input.projectId,
      userId,
      role: userId === input.ownerUserId ? 'owner' : 'member',
      active: true,
      createdAt: '2026-08-15T01:00:00.000Z'
    })
  }
}

function seedTask(repository: FakeCollaborationRepository, input: {
  taskId: string
  projectId: string
  assigneeAgentId: string
  assigneeUserId: string
  status: string
}): void {
  repository.state.tasks.set(input.taskId, {
    ...input,
    executionId: `exe_${input.taskId.slice(4)}Exec`,
    createdByAgentId: input.assigneeAgentId,
    title: 'Portal task',
    objective: 'Exercise Portal state.',
    completionCriteria: [],
    dependencyTaskIds: [],
    requiredCapabilities: { capabilityIds: [], vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: [] },
    resourceRefIds: [],
    authorizationRequirements: [],
    retryCount: 0,
    maxRetries: 2,
    coordinationRound: 1,
    revision: 1,
    createdAt: '2026-08-15T01:30:00.000Z',
    updatedAt: '2026-08-15T01:30:00.000Z'
  })
}

describe('CollaborationService Portal data plane', () => {
  it('lists only a User membership with stable bounded cursors and a lock-free coordination snapshot', async () => {
    const clock = new FakeClock('2026-08-15T02:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const owner = seedUser(repository, 'usr_PortalOwner001', 'PortalOwner')
    const member = seedUser(repository, 'usr_PortalMember01', 'PortalMember')
    seedAgent(repository, { agentId: 'agt_PortalCoord001', ownerUserId: owner.userId,
      lastSeenAt: clock.now().toISOString() })
    seedProject(repository, { projectId: 'prj_PortalProject01', ownerUserId: owner.userId,
      coordinatorAgentId: 'agt_PortalCoord001', memberUserIds: [owner.userId, member.userId],
      updatedAt: '2026-08-15T01:59:00.000Z' })
    seedProject(repository, { projectId: 'prj_PortalProject02', ownerUserId: owner.userId,
      coordinatorAgentId: 'agt_PortalCoord001', memberUserIds: [owner.userId],
      updatedAt: '2026-08-15T01:58:00.000Z' })
    seedTask(repository, { taskId: 'tsk_PortalRunning01', projectId: 'prj_PortalProject01',
      assigneeAgentId: 'agt_PortalCoord001', assigneeUserId: owner.userId, status: 'in_progress' })
    repository.state.projectRecords.set('rec_PortalCandidate1', {
      projectRecordId: 'rec_PortalCandidate1', projectId: 'prj_PortalProject01', kind: 'task_result',
      status: 'candidate', summary: 'Pending result', authorUserId: member.userId,
      criterionEvidence: [], resourceRefIds: [], revision: 1,
      createdAt: '2026-08-15T01:40:00.000Z', updatedAt: '2026-08-15T01:40:00.000Z'
    })
    const service = new CollaborationService({ repository, now: clock.now })
    repository.listProjectsForUser = async () => { throw new Error('Portal Project list must use the keyset summary query') }
    repository.listAgentsForUser = async () => { throw new Error('Portal owned Agents must use the bounded usable JOIN') }

    const first = await service.listProjects(owner, { statuses: ['active'], limit: 1 })
    expect(first.items).toEqual([expect.objectContaining({ projectId: 'prj_PortalProject01', role: 'owner',
      memberCount: 2, pendingResultCount: 1, taskCounts: expect.objectContaining({ running: 1 }) })])
    expect(first.nextCursor).toBeTypeOf('string')
    const second = await service.listProjects(owner, { cursor: first.nextCursor, limit: 1 })
    expect(second.items.map((project) => project.projectId)).toEqual(['prj_PortalProject02'])
    await expect(service.listProjects(member, { limit: 50 })).resolves.toMatchObject({
      items: [expect.objectContaining({ projectId: 'prj_PortalProject01', role: 'member' })]
    })
    await expect(service.listProjects(owner, { cursor: 'p1.invalid', limit: 10 }))
      .rejects.toMatchObject({ code: 'validation_failed' })
    await expect(service.listOwnedAgents(owner)).resolves.toMatchObject({
      items: [expect.objectContaining({ agentId: 'agt_PortalCoord001' })]
    })

    repository.getProjectForUpdate = async () => { throw new Error('read view must not acquire a Project write lock') }
    await expect(service.getProjectCoordinationView(owner, 'prj_PortalProject01')).resolves.toMatchObject({
      project: { projectId: 'prj_PortalProject01' },
      tasks: [expect.objectContaining({ taskId: 'tsk_PortalRunning01' })]
    })
  })

  it('derives global test Worker presence from a 60-second lease and fails closed when disabled', async () => {
    const clock = new FakeClock('2026-08-15T02:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const viewer = seedUser(repository, 'usr_PortalViewer01', 'PortalViewer')
    const worker = seedUser(repository, 'usr_PortalWorker01', 'PortalWorker')
    const otherIssuer = seedUser(repository, 'usr_PortalForeign01', 'PortalForeign',
      'https://foreign.example.invalid/realms/Other')
    seedAgent(repository, { agentId: 'agt_PortalOnline01', ownerUserId: worker.userId,
      lastSeenAt: clock.now().toISOString() })
    seedAgent(repository, { agentId: 'agt_PortalBusy001', ownerUserId: worker.userId,
      lastSeenAt: '2026-08-15T01:59:00.000Z', nodeType: 'server' })
    seedAgent(repository, { agentId: 'agt_PortalStale01', ownerUserId: worker.userId,
      lastSeenAt: '2026-08-15T01:58:59.999Z' })
    seedAgent(repository, { agentId: 'agt_PortalExplicitOff', ownerUserId: worker.userId,
      lastSeenAt: clock.now().toISOString(), connectionStatus: 'offline' })
    seedAgent(repository, { agentId: 'agt_PortalExpired01', ownerUserId: worker.userId,
      lastSeenAt: clock.now().toISOString(), profileExpiresAt: clock.now().toISOString() })
    seedAgent(repository, { agentId: 'agt_PortalRevoked01', ownerUserId: worker.userId,
      lastSeenAt: clock.now().toISOString(), agentStatus: 'revoked' })
    seedAgent(repository, { agentId: 'agt_PortalDeviceRev', ownerUserId: worker.userId,
      lastSeenAt: clock.now().toISOString(), deviceStatus: 'revoked' })
    seedAgent(repository, { agentId: 'agt_PortalWrongOwner', ownerUserId: worker.userId,
      lastSeenAt: clock.now().toISOString(), profileOwnerUserId: viewer.userId })
    seedAgent(repository, { agentId: 'agt_PortalForeign01', ownerUserId: otherIssuer.userId,
      lastSeenAt: clock.now().toISOString() })
    seedTask(repository, { taskId: 'tsk_PortalBusyTask1', projectId: 'prj_PortalBusyProj1',
      assigneeAgentId: 'agt_PortalBusy001', assigneeUserId: worker.userId, status: 'in_progress' })
    const service = new CollaborationService({ repository, now: clock.now, testWorkerDirectoryEnabled: true })
    repository.listAllAgents = async () => { throw new Error('Portal Worker pages must not scan all Agents') }

    const first = await service.getWorkerDirectoryPage(viewer, { limit: 2 })
    expect(first.stats).toEqual({ total: 4, online: 1, busy: 1, offline: 2, desktop: 3, server: 1 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeTypeOf('string')
    const second = await service.getWorkerDirectoryPage(viewer, { cursor: first.nextCursor, limit: 2 })
    const all = [...first.items, ...second.items]
    expect(all).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'agt_PortalOnline01', status: 'online' }),
      expect.objectContaining({ agentId: 'agt_PortalBusy001', status: 'busy', nodeType: 'server' }),
      expect.objectContaining({ agentId: 'agt_PortalStale01', status: 'offline' }),
      expect.objectContaining({ agentId: 'agt_PortalExplicitOff', status: 'offline' })
    ]))
    expect(all.map((entry) => entry.agentId)).not.toContain('agt_PortalExpired01')
    const disabled = new CollaborationService({ repository, now: clock.now })
    await expect(disabled.getWorkerDirectoryPage(viewer, { limit: 10 }))
      .rejects.toMatchObject({ code: 'not_found' })
  })

  it('uses bounded target-only Portal coordination reads and lightweight target watermarks', async () => {
    const clock = new FakeClock('2026-08-15T02:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const owner = seedUser(repository, 'usr_BoundedOwner001', 'BoundedOwner')
    const other = seedUser(repository, 'usr_BoundedOther001', 'BoundedOther')
    seedAgent(repository, { agentId: 'agt_BoundedCoord01', ownerUserId: owner.userId,
      lastSeenAt: clock.now().toISOString() })
    seedProject(repository, { projectId: 'prj_BoundedPortal01', ownerUserId: owner.userId,
      coordinatorAgentId: 'agt_BoundedCoord01', memberUserIds: [owner.userId, other.userId] })
    seedTask(repository, { taskId: 'tsk_BoundedPortal01', projectId: 'prj_BoundedPortal01',
      assigneeAgentId: 'agt_BoundedCoord01', assigneeUserId: owner.userId, status: 'in_progress' })
    seedTask(repository, { taskId: 'tsk_BoundedPortal02', projectId: 'prj_BoundedPortal01',
      assigneeAgentId: 'agt_BoundedCoord01', assigneeUserId: owner.userId, status: 'offered' })
    repository.state.humanRequests.set('hrq_BoundedOwner01', {
      humanRequestId: 'hrq_BoundedOwner01', projectId: 'prj_BoundedPortal01', sourceKind: 'coordinator',
      sourceInboxMessageId: 'ibx_BoundedOwner001', targetUserId: owner.userId,
      requestedByAgentId: 'agt_BoundedCoord01', requiredAssurance: 'verified', prompt: 'owner secret prompt',
      status: 'pending', expiresAt: '2026-08-15T01:59:00.000Z', revision: 1,
      createdAt: '2026-08-15T01:30:00.000Z', updatedAt: '2026-08-15T01:30:00.000Z'
    })
    repository.state.humanRequests.set('hrq_BoundedOther01', {
      humanRequestId: 'hrq_BoundedOther01', projectId: 'prj_BoundedPortal01', sourceKind: 'coordinator',
      sourceInboxMessageId: 'ibx_BoundedOther001', targetUserId: other.userId,
      requestedByAgentId: 'agt_BoundedCoord01', requiredAssurance: 'verified', prompt: 'other secret prompt',
      status: 'pending', expiresAt: '2026-08-15T03:00:00.000Z', revision: 1,
      createdAt: '2026-08-15T01:31:00.000Z', updatedAt: '2026-08-15T01:31:00.000Z'
    })
    repository.state.humanAnswers.set('han_BoundedPrivate1', {
      humanAnswerId: 'han_BoundedPrivate1', humanRequestId: 'hrq_BoundedOwner01',
      projectId: 'prj_BoundedPortal01', requestRevision: 1, answeredByUserId: owner.userId,
      answeredFromHumanEndpointId: 'hep_BoundedPrivate1', assurance: 'verified', answer: 'private answer',
      revision: 1, answeredAt: '2026-08-15T01:40:00.000Z', createdAt: '2026-08-15T01:40:00.000Z',
      updatedAt: '2026-08-15T01:40:00.000Z'
    })
    repository.pruneExpired = async () => { throw new Error('Portal GET must remain read-only') }
    repository.listProjectMembers = async () => { throw new Error('Portal must use bounded active members') }
    repository.listProjectTasks = async () => { throw new Error('Portal must use bounded tasks') }
    repository.listProjectRecords = async () => { throw new Error('Portal must use bounded records') }
    repository.listHumanRequestsForProject = async () => { throw new Error('Portal must use target-only HumanNeeded') }
    repository.listHumanAnswersForProject = async () => { throw new Error('Portal must never load HumanAnswer') }
    repository.getUser = async () => { throw new Error('Portal members must be joined in one bounded query') }
    const service = new CollaborationService({ repository, now: clock.now })

    const view = await service.getPortalProjectCoordinationView(owner, 'prj_BoundedPortal01')
    expect(view.tasks).toHaveLength(2)
    expect(view.humanRequests).toEqual([
      expect.objectContaining({ humanRequestId: 'hrq_BoundedOwner01', targetUserId: owner.userId, status: 'expired' })
    ])
    expect(view).not.toHaveProperty('humanAnswers')
    const firstWake = await service.getPortalProjectWakeSnapshot(owner, 'prj_BoundedPortal01')
    expect(view.pagination.tasks.version).toBe(firstWake.taskVersion)
    expect(view.pagination.records.version).toBe(firstWake.recordVersion)
    expect(view.pagination.humanRequests.version).toBe(firstWake.humanVersion)
    repository.state.humanRequests.get('hrq_BoundedOther01').revision += 1
    const otherWake = await service.getPortalProjectWakeSnapshot(owner, 'prj_BoundedPortal01')
    expect(otherWake.humanVersion).toBe(firstWake.humanVersion)
    repository.state.humanRequests.get('hrq_BoundedOwner01').revision += 1
    const targetWake = await service.getPortalProjectWakeSnapshot(owner, 'prj_BoundedPortal01')
    expect(targetWake.humanVersion).not.toBe(firstWake.humanVersion)
    for (const index of ['01', '02']) {
      repository.state.projectRecords.set(`rec_BoundedPortal${index}`, {
        projectRecordId: `rec_BoundedPortal${index}`, projectId: 'prj_BoundedPortal01', kind: 'observation',
        status: 'candidate', summary: `Bounded record ${index}`, authorUserId: owner.userId,
        criterionEvidence: [], resourceRefIds: [], revision: 1,
        createdAt: '2026-08-15T01:30:00.000Z', updatedAt: '2026-08-15T01:30:00.000Z'
      })
    }
    repository.state.humanRequests.set('hrq_BoundedOwner02', {
      humanRequestId: 'hrq_BoundedOwner02', projectId: 'prj_BoundedPortal01', sourceKind: 'coordinator',
      sourceInboxMessageId: 'ibx_BoundedOwner002', targetUserId: owner.userId,
      requestedByAgentId: 'agt_BoundedCoord01', requiredAssurance: 'verified', prompt: 'second owner prompt',
      status: 'pending', expiresAt: '2026-08-15T03:00:00.000Z', revision: 1,
      createdAt: '2026-08-15T01:32:00.000Z', updatedAt: '2026-08-15T01:32:00.000Z'
    })
    const firstPage = await service.getPortalProjectCoordinationView(owner, 'prj_BoundedPortal01', {
      tasksLimit: 1,
      recordsLimit: 1,
      humanLimit: 1
    })
    expect(firstPage.tasks.map((task) => task.taskId)).toEqual(['tsk_BoundedPortal01'])
    expect(firstPage.records.map((record) => record.projectRecordId)).toEqual(['rec_BoundedPortal01'])
    expect(firstPage.humanRequests.map((request) => request.humanRequestId)).toEqual(['hrq_BoundedOwner01'])
    expect(firstPage.pagination.tasks.nextCursor).toBeTypeOf('string')
    expect(firstPage.pagination.records.nextCursor).toBeTypeOf('string')
    expect(firstPage.pagination.humanRequests.nextCursor).toBeTypeOf('string')
    const secondTaskPage = await service.getPortalProjectCoordinationView(owner, 'prj_BoundedPortal01', {
      tasksLimit: 1,
      tasksCursor: firstPage.pagination.tasks.nextCursor!
    })
    expect(secondTaskPage.tasks.map((task) => task.taskId)).toEqual(['tsk_BoundedPortal02'])
    expect(secondTaskPage.pagination.tasks.nextCursor).toBeUndefined()

    seedTask(repository, { taskId: 'tsk_BoundedPortal01A', projectId: 'prj_BoundedPortal01',
      assigneeAgentId: 'agt_BoundedCoord01', assigneeUserId: owner.userId, status: 'offered' })
    repository.state.projectRecords.set('rec_BoundedPortal01A', {
      projectRecordId: 'rec_BoundedPortal01A', projectId: 'prj_BoundedPortal01', kind: 'observation',
      status: 'candidate', summary: 'Inserted beyond the retained first page', authorUserId: owner.userId,
      criterionEvidence: [], resourceRefIds: [], revision: 1,
      createdAt: '2026-08-15T01:33:00.000Z', updatedAt: '2026-08-15T01:33:00.000Z'
    })
    repository.state.humanRequests.set('hrq_BoundedOwner01A', {
      humanRequestId: 'hrq_BoundedOwner01A', projectId: 'prj_BoundedPortal01', sourceKind: 'coordinator',
      sourceInboxMessageId: 'ibx_BoundedOwner01A', targetUserId: owner.userId,
      requestedByAgentId: 'agt_BoundedCoord01', requiredAssurance: 'verified', prompt: 'inserted owner prompt',
      status: 'pending', expiresAt: '2026-08-15T03:00:00.000Z', revision: 1,
      createdAt: '2026-08-15T01:33:00.000Z', updatedAt: '2026-08-15T01:33:00.000Z'
    })
    const refreshedFirstPage = await service.getPortalProjectCoordinationView(owner, 'prj_BoundedPortal01', {
      tasksLimit: 1,
      recordsLimit: 1,
      humanLimit: 1
    })
    expect(refreshedFirstPage.tasks.map((task) => task.taskId)).toEqual(['tsk_BoundedPortal01'])
    expect(refreshedFirstPage.records.map((record) => record.projectRecordId)).toEqual(['rec_BoundedPortal01'])
    expect(refreshedFirstPage.humanRequests.map((request) => request.humanRequestId))
      .toEqual(['hrq_BoundedOwner01'])
    expect(refreshedFirstPage.pagination.tasks.version).not.toBe(firstPage.pagination.tasks.version)
    expect(refreshedFirstPage.pagination.records.version).not.toBe(firstPage.pagination.records.version)
    expect(refreshedFirstPage.pagination.humanRequests.version)
      .not.toBe(firstPage.pagination.humanRequests.version)
  })

  it('rejects cross-issuer Project creation before persisting Project, Inbox, receipt, or audit state', async () => {
    const clock = new FakeClock('2026-08-15T02:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const owner = seedUser(repository, 'usr_CreateOwner001', 'CreateOwner')
    const foreign = seedUser(repository, 'usr_CreateForeign01', 'CreateForeign',
      'https://foreign.example.invalid/realms/Other')
    seedAgent(repository, { agentId: 'agt_CreateCoord001', ownerUserId: owner.userId,
      lastSeenAt: clock.now().toISOString() })
    const service = new CollaborationService({ repository, now: clock.now })

    await expect(service.createProject(owner, {
      displayName: 'Cross issuer Project', goal: 'This Project must not be persisted.',
      memberUserIds: [owner.userId, foreign.userId], coordinatorAgentId: 'agt_CreateCoord001',
      idempotencyKey: 'idem_create_cross_issuer_01'
    })).rejects.toMatchObject({ code: 'permission_denied' })
    expect(repository.state.projects.size).toBe(0)
    expect(repository.state.projectMembers.size).toBe(0)
    expect(repository.state.inboxes.size).toBe(0)
    expect(repository.state.receipts.size).toBe(0)
    expect(repository.state.auditEvents).toEqual([
      expect.objectContaining({ action: 'project.create', outcome: 'rejected' })
    ])
  })

  it('updates membership only for the owner and enforces revision, coordinator, work, and issuer fences', async () => {
    const clock = new FakeClock('2026-08-15T02:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const owner = seedUser(repository, 'usr_MemberOwner001', 'MemberOwner')
    const coordinatorOwner = seedUser(repository, 'usr_MemberCoordOwn1', 'MemberCoordinator')
    const openMember = seedUser(repository, 'usr_MemberOpen0001', 'MemberOpen')
    const pendingMember = seedUser(repository, 'usr_MemberPending1', 'MemberPending')
    const removable = seedUser(repository, 'usr_MemberRemove01', 'MemberRemove')
    const added = seedUser(repository, 'usr_MemberAdded001', 'MemberAdded')
    const foreign = seedUser(repository, 'usr_MemberForeign1', 'MemberForeign',
      'https://foreign.example.invalid/realms/Other')
    seedAgent(repository, { agentId: 'agt_MemberCoord001', ownerUserId: coordinatorOwner.userId,
      lastSeenAt: clock.now().toISOString() })
    seedProject(repository, { projectId: 'prj_MemberProject01', ownerUserId: owner.userId,
      coordinatorAgentId: 'agt_MemberCoord001',
      memberUserIds: [owner.userId, coordinatorOwner.userId, openMember.userId, pendingMember.userId, removable.userId] })
    seedTask(repository, { taskId: 'tsk_MemberOpenTask1', projectId: 'prj_MemberProject01',
      assigneeAgentId: 'agt_MemberCoord001', assigneeUserId: openMember.userId, status: 'offered' })
    repository.state.humanRequests.set('hrq_MemberPending01', {
      humanRequestId: 'hrq_MemberPending01', projectId: 'prj_MemberProject01', sourceKind: 'coordinator',
      sourceInboxMessageId: 'ibx_MemberSource001', targetUserId: pendingMember.userId,
      requestedByAgentId: 'agt_MemberCoord001', requiredAssurance: 'verified', prompt: 'Pending decision',
      status: 'pending', revision: 1, expiresAt: '2026-08-15T03:00:00.000Z',
      createdAt: '2026-08-15T01:30:00.000Z', updatedAt: '2026-08-15T01:30:00.000Z'
    })
    repository.listProjectMembers = async () => { throw new Error('Member update must not load membership history') }
    repository.listProjectTasks = async () => { throw new Error('Member update must not materialize Task rows') }
    repository.listHumanRequestsForProject = async () => { throw new Error('Member update must not materialize HumanNeeded rows') }
    let blockerQueries = 0
    const nativeBlockers = repository.getProjectMemberRemovalBlockers.bind(repository)
    repository.getProjectMemberRemovalBlockers = async (...parameters) => {
      blockerQueries += 1
      return nativeBlockers(...parameters)
    }
    const service = new CollaborationService({ repository, now: clock.now })
    const base = {
      projectId: 'prj_MemberProject01', expectedRevision: 1,
      addMemberUserIds: [] as string[], removeMemberUserIds: [] as string[]
    }

    await expect(service.updateProjectMembers(openMember, { ...base, addMemberUserIds: [added.userId],
      idempotencyKey: 'idem_members_non_owner_01' })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.updateProjectMembers(owner, { ...base, removeMemberUserIds: [owner.userId],
      idempotencyKey: 'idem_members_remove_owner_01' })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    await expect(service.updateProjectMembers(owner, { ...base, removeMemberUserIds: [coordinatorOwner.userId],
      idempotencyKey: 'idem_members_remove_coord_01' })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    await expect(service.updateProjectMembers(owner, { ...base, removeMemberUserIds: [openMember.userId],
      idempotencyKey: 'idem_members_remove_open_01' })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    await expect(service.updateProjectMembers(owner, { ...base, removeMemberUserIds: [pendingMember.userId],
      idempotencyKey: 'idem_members_remove_pending_01' })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    await expect(service.updateProjectMembers(owner, { ...base, addMemberUserIds: [foreign.userId],
      idempotencyKey: 'idem_members_add_foreign_01' })).rejects.toMatchObject({ code: 'permission_denied' })

    const updated = await service.updateProjectMembers(owner, {
      ...base,
      addMemberUserIds: [added.userId],
      removeMemberUserIds: [removable.userId],
      idempotencyKey: 'idem_members_update_valid_01'
    })
    expect(updated.revision).toBe(2)
    await expect(repository.getProjectMember('prj_MemberProject01', added.userId))
      .resolves.toMatchObject({ active: true, role: 'member' })
    await expect(repository.getProjectMember('prj_MemberProject01', removable.userId))
      .resolves.toMatchObject({ active: false })
    const removedInbox = repository.state.inboxes.get(`user:${removable.userId}`)
    expect(removedInbox?.[0]?.payload).toEqual(expect.objectContaining({
      protocolVersion: '1.0', type: 'project.members.updated', projectId: 'prj_MemberProject01', revision: 2,
      addedUserIds: [added.userId], removedUserIds: [removable.userId]
    }))
    expect(repository.state.auditEvents).toContainEqual(expect.objectContaining({ action: 'project.members.update' }))
    expect(blockerQueries).toBe(3)
    await expect(service.updateProjectMembers(owner, { ...base, addMemberUserIds: [added.userId],
      idempotencyKey: 'idem_members_stale_revision_01' })).rejects.toMatchObject({ code: 'revision_conflict' })
  })

  it('keeps additions and Project response reads bounded despite inactive membership churn', async () => {
    const clock = new FakeClock('2026-08-15T02:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const owner = seedUser(repository, 'usr_BoundedMemberOwn', 'BoundedMemberOwner')
    const addition = seedUser(repository, 'usr_BoundedMemberAdd', 'BoundedMemberAddition')
    seedAgent(repository, { agentId: 'agt_BoundedMemberCo', ownerUserId: owner.userId,
      lastSeenAt: clock.now().toISOString() })
    seedProject(repository, { projectId: 'prj_BoundedMembers01', ownerUserId: owner.userId,
      coordinatorAgentId: 'agt_BoundedMemberCo', memberUserIds: [owner.userId] })
    for (let index = 0; index < 5_000; index += 1) {
      const userId = `usr_Inactive${String(index).padStart(12, '0')}`
      repository.state.projectMembers.set(`prj_BoundedMembers01:${userId}`, {
        projectId: 'prj_BoundedMembers01', userId, role: 'member', active: false,
        createdAt: '2026-08-15T01:00:00.000Z'
      })
    }
    repository.listProjectMembers = async () => { throw new Error('Inactive membership history must stay unread') }
    repository.listProjectRecords = async () => { throw new Error('Project header reads must not load records') }
    repository.listProjectTasks = async () => { throw new Error('Additions-only must not scan Tasks') }
    repository.listHumanRequestsForProject = async () => { throw new Error('Additions-only must not scan HumanNeeded') }
    repository.getProjectMemberRemovalBlockers = async () => {
      throw new Error('Additions-only must not run a removal-blocker query')
    }
    const boundedReads: number[] = []
    const nativeActiveMembers = repository.listActiveProjectMembersBounded.bind(repository)
    repository.listActiveProjectMembersBounded = async (projectId, limit) => {
      boundedReads.push(limit)
      return nativeActiveMembers(projectId, limit)
    }
    const service = new CollaborationService({ repository, now: clock.now })

    await expect(service.updateProjectMembers(owner, {
      projectId: 'prj_BoundedMembers01', expectedRevision: 1,
      addMemberUserIds: [addition.userId], removeMemberUserIds: [],
      idempotencyKey: 'idem_members_bounded_add_01'
    })).resolves.toMatchObject({ revision: 2 })
    const view = await service.getProject(owner, 'prj_BoundedMembers01')
    expect(view.members.map((member) => member.userId)).toEqual([owner.userId, addition.userId].sort())
    expect(boundedReads).toEqual([1_001])
  })

  it('bounds canonical coordination and capability membership reads despite inactive churn', async () => {
    const clock = new FakeClock('2026-08-15T02:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const owner = seedUser(repository, 'usr_BoundedViewsOwner', 'BoundedViewsOwner')
    seedAgent(repository, { agentId: 'agt_BoundedViewsCoord', ownerUserId: owner.userId,
      lastSeenAt: clock.now().toISOString() })
    seedProject(repository, { projectId: 'prj_BoundedViews001', ownerUserId: owner.userId,
      coordinatorAgentId: 'agt_BoundedViewsCoord', memberUserIds: [owner.userId] })
    for (let index = 0; index < 5_000; index += 1) {
      const userId = `usr_ViewInactive${String(index).padStart(12, '0')}`
      repository.state.projectMembers.set(`prj_BoundedViews001:${userId}`, {
        projectId: 'prj_BoundedViews001', userId, role: 'observer', active: false,
        createdAt: '2026-08-15T01:00:00.000Z'
      })
    }
    repository.listProjectMembers = async () => { throw new Error('Canonical views must not load membership history') }
    const memberViewLimits: number[] = []
    const activeMemberLimits: number[] = []
    const nativeMemberViews = repository.listActiveProjectMemberViewsBounded.bind(repository)
    const nativeActiveMembers = repository.listActiveProjectMembersBounded.bind(repository)
    repository.listActiveProjectMemberViewsBounded = async (projectId, limit) => {
      memberViewLimits.push(limit)
      return nativeMemberViews(projectId, limit)
    }
    repository.listActiveProjectMembersBounded = async (projectId, limit) => {
      activeMemberLimits.push(limit)
      return nativeActiveMembers(projectId, limit)
    }
    const service = new CollaborationService({ repository, now: clock.now })

    const coordination = await service.getProjectCoordinationView(owner, 'prj_BoundedViews001')
    expect(coordination.members).toEqual([
      expect.objectContaining({ userId: owner.userId, displayName: 'BoundedViewsOwner' })
    ])
    const capability = await service.getProjectCapabilityDirectory(owner, 'prj_BoundedViews001')
    expect(capability.projectId).toBe('prj_BoundedViews001')
    expect(memberViewLimits).toEqual([1_001])
    expect(activeMemberLimits).toEqual([1_001])
  })

  it('enforces the 1000 active-member invariant before any membership side effect', async () => {
    const clock = new FakeClock('2026-08-15T02:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const owner = seedUser(repository, 'usr_MemberLimitOwn1', 'MemberLimitOwner')
    const addition = seedUser(repository, 'usr_MemberLimitAdd1', 'MemberLimitAddition')
    seedAgent(repository, { agentId: 'agt_MemberLimitCo1', ownerUserId: owner.userId,
      lastSeenAt: clock.now().toISOString() })
    const memberIds = [owner.userId, ...Array.from({ length: 999 }, (_, index) => `usr_Limit${String(index).padStart(12, '0')}`)]
    seedProject(repository, { projectId: 'prj_MemberLimit001', ownerUserId: owner.userId,
      coordinatorAgentId: 'agt_MemberLimitCo1', memberUserIds: memberIds })
    const service = new CollaborationService({ repository, now: clock.now })
    const stateBefore = {
      inboxes: repository.state.inboxes.size,
      audits: repository.state.auditEvents.length,
      receipts: repository.state.receipts.size
    }

    await expect(service.updateProjectMembers(owner, {
      projectId: 'prj_MemberLimit001', expectedRevision: 1,
      addMemberUserIds: [addition.userId], removeMemberUserIds: [],
      idempotencyKey: 'idem_members_limit_reject_01'
    })).rejects.toMatchObject({ code: 'validation_failed' })
    await expect(repository.getProject('prj_MemberLimit001')).resolves.toMatchObject({ revision: 1 })
    await expect(repository.getProjectMember('prj_MemberLimit001', addition.userId)).resolves.toBeNull()
    expect(repository.state.inboxes.size).toBe(stateBefore.inboxes)
    expect(repository.state.auditEvents).toHaveLength(stateBefore.audits + 1)
    expect(repository.state.auditEvents.at(-1)).toEqual(expect.objectContaining({
      action: 'project.members.update', outcome: 'rejected'
    }))
    expect(repository.state.receipts.size).toBe(stateBefore.receipts)

    const smallerIds = memberIds.slice(0, 999)
    seedProject(repository, { projectId: 'prj_MemberLimit002', ownerUserId: owner.userId,
      coordinatorAgentId: 'agt_MemberLimitCo1', memberUserIds: smallerIds })
    await expect(service.updateProjectMembers(owner, {
      projectId: 'prj_MemberLimit002', expectedRevision: 1,
      addMemberUserIds: [addition.userId], removeMemberUserIds: [],
      idempotencyKey: 'idem_members_limit_accept_01'
    })).resolves.toMatchObject({ revision: 2 })
    await expect(repository.getProjectMember('prj_MemberLimit002', addition.userId))
      .resolves.toMatchObject({ active: true })
  })

  it('caps active Project memberships per User for owners and invited members', async () => {
    const clock = new FakeClock('2026-08-15T02:00:00.000Z')
    const ownerRepository = new FakeCollaborationRepository()
    const cappedOwner = seedUser(ownerRepository, 'usr_GlobalCapOwner01', 'GlobalCapOwner')
    seedAgent(ownerRepository, { agentId: 'agt_GlobalCapCoord01', ownerUserId: cappedOwner.userId,
      lastSeenAt: clock.now().toISOString() })
    seedActiveMemberships(ownerRepository, cappedOwner.userId,
      MAX_ACTIVE_PROJECT_MEMBERSHIPS_PER_USER, 'OwnerCap')
    const ownerService = new CollaborationService({ repository: ownerRepository, now: clock.now })

    await expect(ownerService.createProject(cappedOwner, {
      displayName: 'Owner over global cap', goal: 'This Project must not be created.',
      memberUserIds: [cappedOwner.userId], coordinatorAgentId: 'agt_GlobalCapCoord01',
      idempotencyKey: 'idem_global_owner_cap_reject_01'
    })).rejects.toMatchObject({ code: 'validation_failed' })
    expect(ownerRepository.state.projects.size).toBe(0)

    const memberRepository = new FakeCollaborationRepository()
    const owner = seedUser(memberRepository, 'usr_GlobalCapInvite1', 'GlobalCapInviteOwner')
    const member = seedUser(memberRepository, 'usr_GlobalCapMember1', 'GlobalCapMember')
    seedAgent(memberRepository, { agentId: 'agt_GlobalCapCoord02', ownerUserId: owner.userId,
      lastSeenAt: clock.now().toISOString() })
    seedActiveMemberships(memberRepository, member.userId,
      MAX_ACTIVE_PROJECT_MEMBERSHIPS_PER_USER - 1, 'MemberCap')
    const memberService = new CollaborationService({ repository: memberRepository, now: clock.now })
    await expect(memberService.createProject(owner, {
      displayName: 'Last bounded membership', goal: 'Reach, but never exceed, the fixed User cap.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: 'agt_GlobalCapCoord02',
      idempotencyKey: 'idem_global_member_cap_accept_01'
    })).resolves.toMatchObject({ ownerUserId: owner.userId })
    await expect(memberRepository.countActiveProjectMembershipsByUserIds([member.userId]))
      .resolves.toEqual([{ userId: member.userId, count: MAX_ACTIVE_PROJECT_MEMBERSHIPS_PER_USER }])
    seedProject(memberRepository, { projectId: 'prj_GlobalCapAdd001', ownerUserId: owner.userId,
      coordinatorAgentId: 'agt_GlobalCapCoord02', memberUserIds: [owner.userId] })
    await expect(memberService.updateProjectMembers(owner, {
      projectId: 'prj_GlobalCapAdd001', expectedRevision: 1,
      addMemberUserIds: [member.userId], removeMemberUserIds: [],
      idempotencyKey: 'idem_global_member_add_reject_01'
    })).rejects.toMatchObject({ code: 'validation_failed' })
    await expect(memberRepository.getProjectMember('prj_GlobalCapAdd001', member.userId))
      .resolves.toBeNull()
    await expect(memberService.createProject(owner, {
      displayName: 'One Project too many', goal: 'The invited User is already at the fixed cap.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: 'agt_GlobalCapCoord02',
      idempotencyKey: 'idem_global_member_cap_reject_01'
    })).rejects.toMatchObject({ code: 'validation_failed' })
  })

  it('serializes concurrent member reactivation so a User cannot exceed 1000 active Projects', async () => {
    const clock = new FakeClock('2026-08-15T02:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const ownerA = seedUser(repository, 'usr_ReactivateOwnerA', 'ReactivateOwnerA')
    const ownerB = seedUser(repository, 'usr_ReactivateOwnerB', 'ReactivateOwnerB')
    const target = seedUser(repository, 'usr_ReactivateTarget', 'ReactivateTarget')
    seedAgent(repository, { agentId: 'agt_ReactivateCoordA', ownerUserId: ownerA.userId,
      lastSeenAt: clock.now().toISOString() })
    seedAgent(repository, { agentId: 'agt_ReactivateCoordB', ownerUserId: ownerB.userId,
      lastSeenAt: clock.now().toISOString() })
    seedActiveMemberships(repository, target.userId,
      MAX_ACTIVE_PROJECT_MEMBERSHIPS_PER_USER - 1, 'Reactivate')
    seedProject(repository, { projectId: 'prj_ReactivateProjectA', ownerUserId: ownerA.userId,
      coordinatorAgentId: 'agt_ReactivateCoordA', memberUserIds: [ownerA.userId, target.userId] })
    seedProject(repository, { projectId: 'prj_ReactivateProjectB', ownerUserId: ownerB.userId,
      coordinatorAgentId: 'agt_ReactivateCoordB', memberUserIds: [ownerB.userId, target.userId] })
    repository.state.projectMembers.get(`prj_ReactivateProjectA:${target.userId}`).active = false
    repository.state.projectMembers.get(`prj_ReactivateProjectB:${target.userId}`).active = false
    const service = new CollaborationService({ repository, now: clock.now })

    const outcomes = await Promise.allSettled([
      service.updateProjectMembers(ownerA, {
        projectId: 'prj_ReactivateProjectA', expectedRevision: 1,
        addMemberUserIds: [target.userId], removeMemberUserIds: [],
        idempotencyKey: 'idem_reactivate_cap_a_01'
      }),
      service.updateProjectMembers(ownerB, {
        projectId: 'prj_ReactivateProjectB', expectedRevision: 1,
        addMemberUserIds: [target.userId], removeMemberUserIds: [],
        idempotencyKey: 'idem_reactivate_cap_b_01'
      })
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(rejected?.reason).toMatchObject({ code: 'validation_failed' })
    await expect(repository.countActiveProjectMembershipsByUserIds([target.userId]))
      .resolves.toEqual([{ userId: target.userId, count: MAX_ACTIVE_PROJECT_MEMBERSHIPS_PER_USER }])
  })

  it('serializes ProjectRecord and HumanNeeded hard-cap boundaries without partial writes', async () => {
    const clock = new FakeClock('2026-08-15T02:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const owner = seedUser(repository, 'usr_CollectionCapOwn', 'CollectionCapOwner')
    seedAgent(repository, { agentId: 'agt_CollectionCapCo', ownerUserId: owner.userId,
      lastSeenAt: clock.now().toISOString() })
    seedProject(repository, { projectId: 'prj_CollectionCap01', ownerUserId: owner.userId,
      coordinatorAgentId: 'agt_CollectionCapCo', memberUserIds: [owner.userId] })
    const coordinator = agentActor('agt_CollectionCapCo', owner.userId)
    const sourceMessage = {
      recipient: { kind: 'agent' as const, id: coordinator.agentId },
      sequence: 1,
      messageId: 'ibx_CollectionCapSource01',
      messageType: 'project.started',
      payload: { projectId: 'prj_CollectionCap01' },
      disposition: 'active' as const,
      createdAt: '2026-08-15T01:30:00.000Z',
      expiresAt: '2026-08-16T01:30:00.000Z'
    }
    repository.state.inboxes.set(`agent:${coordinator.agentId}`, [sourceMessage])
    const nativeRecordCount = repository.countProjectRecords.bind(repository)
    const nativeHumanCount = repository.countProjectHumanRequests.bind(repository)
    repository.countProjectRecords = async (projectId) => (
      MAX_PROJECT_RECORDS_PER_PROJECT - 1 + await nativeRecordCount(projectId)
    )
    repository.countProjectHumanRequests = async (projectId) => (
      MAX_HUMAN_REQUESTS_PER_PROJECT - 1 + await nativeHumanCount(projectId)
    )
    const service = new CollaborationService({ repository, now: clock.now })

    const recordOutcomes = await Promise.allSettled([
      service.submitProjectRecord(owner, {
        projectId: 'prj_CollectionCap01', kind: 'observation', summary: 'First bounded observation.',
        idempotencyKey: 'idem_record_cap_a_01'
      }),
      service.submitProjectRecord(owner, {
        projectId: 'prj_CollectionCap01', kind: 'observation', summary: 'Second bounded observation.',
        idempotencyKey: 'idem_record_cap_b_01'
      })
    ])
    expect(recordOutcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(recordOutcomes.find((outcome) => outcome.status === 'rejected')?.reason)
      .toMatchObject({ code: 'validation_failed' })
    expect(repository.state.projectRecords.size).toBe(1)

    const humanInput = (idempotencyKey: string) => service.createHumanNeeded(coordinator, {
      projectId: 'prj_CollectionCap01',
      source: { kind: 'coordinator' as const, sourceInboxMessageId: sourceMessage.messageId },
      targetUserId: owner.userId,
      requiredAssurance: 'verified' as const,
      prompt: 'Provide one bounded clarification.',
      expiresAt: '2026-08-15T03:00:00.000Z',
      idempotencyKey
    })
    const humanOutcomes = await Promise.allSettled([
      humanInput('idem_human_cap_a_01'),
      humanInput('idem_human_cap_b_01')
    ])
    expect(humanOutcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(humanOutcomes.find((outcome) => outcome.status === 'rejected')?.reason)
      .toMatchObject({ code: 'validation_failed' })
    expect(repository.state.humanRequests.size).toBe(1)
  })

  it('enforces the ProjectRecord cap on atomic Task completion results', async () => {
    const clock = new FakeClock('2026-08-15T02:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const owner = seedUser(repository, 'usr_ResultCapOwner1', 'ResultCapOwner')
    seedAgent(repository, { agentId: 'agt_ResultCapWorker1', ownerUserId: owner.userId,
      lastSeenAt: clock.now().toISOString() })
    seedProject(repository, { projectId: 'prj_ResultCapProject1', ownerUserId: owner.userId,
      coordinatorAgentId: 'agt_ResultCapWorker1', memberUserIds: [owner.userId] })
    seedTask(repository, { taskId: 'tsk_ResultCapTask001', projectId: 'prj_ResultCapProject1',
      assigneeAgentId: 'agt_ResultCapWorker1', assigneeUserId: owner.userId, status: 'in_progress' })
    repository.countProjectRecords = async () => MAX_PROJECT_RECORDS_PER_PROJECT
    const service = new CollaborationService({ repository, now: clock.now })
    const worker = agentActor('agt_ResultCapWorker1', owner.userId)
    const task = repository.state.tasks.get('tsk_ResultCapTask001')

    await expect(service.transitionTask(worker, {
      taskId: task.taskId, executionId: task.executionId, status: 'completed', expectedRevision: task.revision,
      result: { summary: 'A bounded result.', criterionEvidence: [], resourceRefIds: [] },
      idempotencyKey: 'idem_result_cap_reject_01'
    })).rejects.toMatchObject({ code: 'validation_failed' })
    expect(repository.state.tasks.get(task.taskId)).toMatchObject({ status: 'in_progress', revision: 1 })
    expect(repository.state.projectRecords.size).toBe(0)

    repository.countProjectRecords = async () => MAX_PROJECT_RECORDS_PER_PROJECT - 1
    await expect(service.transitionTask(worker, {
      taskId: task.taskId, executionId: task.executionId, status: 'completed', expectedRevision: task.revision,
      result: { summary: 'A bounded result.', criterionEvidence: [], resourceRefIds: [] },
      idempotencyKey: 'idem_result_cap_accept_01'
    })).resolves.toMatchObject({ status: 'completed', revision: 2 })
    expect(repository.state.projectRecords.size).toBe(1)
  })
})
