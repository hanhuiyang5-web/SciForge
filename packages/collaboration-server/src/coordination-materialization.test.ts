import { describe, expect, it } from 'vitest'

import {
  FakeClock,
  FakeCollaborationRepository
} from '../../../test-fixtures/collaboration/fake-adapters.mjs'
import type { UserActor } from './auth.js'
import { toHumanAnswer } from './contracts.js'
import type { StoredHumanAnswer } from './model.js'
import {
  CollaborationService,
  MAX_PROJECT_COORDINATION_MATERIALIZED_BYTES,
  MAX_PROJECT_COORDINATION_MATERIALIZED_ROWS
} from './service.js'

const PROJECT_ID = 'prj_MaterialGuard001'
const OWNER_USER_ID = 'usr_MaterialOwner001'
const COORDINATOR_AGENT_ID = 'agt_MaterialCoord001'
const AT = '2026-08-15T02:00:00.000Z'

function createHarness(): {
  clock: FakeClock
  repository: FakeCollaborationRepository
  owner: UserActor
  service: CollaborationService
} {
  const clock = new FakeClock(AT)
  const repository = new FakeCollaborationRepository()
  repository.state.users.set(OWNER_USER_ID, {
    userId: OWNER_USER_ID,
    displayName: 'Materialization Owner',
    status: 'active',
    revision: 1,
    createdAt: AT,
    updatedAt: AT
  })
  repository.state.projects.set(PROJECT_ID, {
    projectId: PROJECT_ID,
    ownerUserId: OWNER_USER_ID,
    displayName: 'Materialization guard',
    goal: 'Keep a canonical Desktop snapshot within a deterministic heap budget.',
    status: 'active',
    coordinatorAgentId: COORDINATOR_AGENT_ID,
    budgets: { maxTasks: 10_000, maxTasksPerRound: 1_000, maxTaskRetries: 100, maxCoordinationRounds: 10_000 },
    coordinationRound: 1,
    revision: 1,
    createdAt: AT,
    updatedAt: AT
  })
  repository.state.projectMembers.set(`${PROJECT_ID}:${OWNER_USER_ID}`, {
    projectId: PROJECT_ID,
    userId: OWNER_USER_ID,
    role: 'owner',
    active: true,
    createdAt: AT
  })
  const owner: UserActor = {
    kind: 'user',
    actorKey: 'oidc:oid_MaterialOwner001',
    userId: OWNER_USER_ID,
    identityId: 'oid_MaterialOwner001',
    issuer: 'https://login-test.sciforge.cn/realms/SciForge',
    subject: 'material-owner',
    authTime: Date.parse(AT) / 1_000,
    assurance: 'verified'
  }
  return {
    clock,
    repository,
    owner,
    service: new CollaborationService({ repository, now: clock.now })
  }
}

describe('canonical coordination materialization guard', () => {
  it('materializes a small snapshot only after native preflight and leaves repository state unchanged', async () => {
    const { repository, owner, service } = createHarness()
    const calls: string[] = []
    const nativeCounts = repository.getProjectCoordinationMaterializationCounts.bind(repository)
    const nativeBytes = repository.getProjectCoordinationMaterializationBytes.bind(repository)
    const nativeMembers = repository.listActiveProjectMemberViewsBounded.bind(repository)
    repository.getProjectCoordinationMaterializationCounts = async (projectId) => {
      calls.push('counts')
      return nativeCounts(projectId)
    }
    repository.getProjectCoordinationMaterializationBytes = async (projectId) => {
      calls.push('bytes')
      return nativeBytes(projectId)
    }
    repository.listActiveProjectMemberViewsBounded = async (projectId, limit) => {
      calls.push('members')
      return nativeMembers(projectId, limit)
    }
    repository.pruneExpired = async () => { throw new Error('Coordination GET must stay read-only') }
    const before = structuredClone({
      members: [...repository.state.projectMembers.entries()],
      projects: [...repository.state.projects.entries()],
      audits: repository.state.auditEvents,
      receipts: [...repository.state.receipts.entries()]
    })

    const view = await service.getProjectCoordinationView(owner, PROJECT_ID)

    expect(view).toMatchObject({
      project: { projectId: PROJECT_ID },
      members: [{ userId: OWNER_USER_ID, displayName: 'Materialization Owner' }],
      tasks: [],
      records: [],
      humanRequests: [],
      humanAnswers: []
    })
    expect(calls).toEqual(['counts', 'bytes', 'members'])
    expect(structuredClone({
      members: [...repository.state.projectMembers.entries()],
      projects: [...repository.state.projects.entries()],
      audits: repository.state.auditEvents,
      receipts: [...repository.state.receipts.entries()]
    })).toEqual(before)
    expect(Buffer.byteLength(JSON.stringify(view), 'utf8')).toBeLessThan(MAX_PROJECT_COORDINATION_MATERIALIZED_BYTES)
  })

  it('rejects an over-row preflight before any collection materialization or write', async () => {
    const { repository, owner, service } = createHarness()
    repository.getProjectCoordinationMaterializationCounts = async () => ({
      activeMembers: '1',
      tasks: String(MAX_PROJECT_COORDINATION_MATERIALIZED_ROWS),
      records: '0',
      humanRequests: '0',
      humanAnswers: '0'
    })
    const materialized: string[] = []
    repository.getProjectCoordinationMaterializationBytes = async () => {
      materialized.push('bytes')
      return { activeMembers: '0', tasks: '0', records: '0', humanRequests: '0', humanAnswers: '0' }
    }
    repository.listActiveProjectMemberViewsBounded = async () => { materialized.push('members'); return [] }
    repository.listProjectTasks = async () => { materialized.push('tasks'); return [] }
    repository.listProjectRecords = async () => { materialized.push('records'); return [] }
    repository.listHumanRequestsForProject = async () => { materialized.push('humanRequests'); return [] }
    repository.listHumanAnswersForProject = async () => { materialized.push('humanAnswers'); return [] }
    const before = structuredClone({
      members: [...repository.state.projectMembers.entries()],
      projects: [...repository.state.projects.entries()],
      audits: repository.state.auditEvents
    })

    await expect(service.getProjectCoordinationView(owner, PROJECT_ID)).rejects.toMatchObject({
      code: 'payload_too_large',
      message: 'The Project coordination view exceeds the fixed materialization limit.'
    })
    expect(materialized).toEqual([])
    expect(structuredClone({
      members: [...repository.state.projectMembers.entries()],
      projects: [...repository.state.projects.entries()],
      audits: repository.state.auditEvents
    })).toEqual(before)
  })

  it('counts JSON escaping for legal maximum HumanAnswer text and rejects over-bytes before materialization', async () => {
    const { repository, owner, service } = createHarness()
    const maximallyEscapedAnswer = '\u0001'.repeat(32_000)
    let firstAnswer: StoredHumanAnswer | undefined
    for (let index = 0; index < 22; index += 1) {
      const suffix = String(index).padStart(12, '0')
      const humanRequestId = `hrq_ByteGuard${suffix}`
      const humanAnswerId = `han_ByteGuard${suffix}`
      repository.state.humanRequests.set(humanRequestId, {
        humanRequestId,
        projectId: PROJECT_ID,
        sourceKind: 'coordinator',
        sourceInboxMessageId: `ibx_ByteGuard${suffix}`,
        targetUserId: OWNER_USER_ID,
        requestedByAgentId: COORDINATOR_AGENT_ID,
        requiredAssurance: 'verified',
        prompt: 'Continue?',
        status: 'answered',
        revision: 2,
        expiresAt: '2026-08-15T03:00:00.000Z',
        createdAt: AT,
        updatedAt: AT
      })
      const answer: StoredHumanAnswer = {
        humanAnswerId,
        humanRequestId,
        projectId: PROJECT_ID,
        requestRevision: 1,
        answeredByUserId: OWNER_USER_ID,
        answeredFromHumanEndpointId: 'hep_MaterialEndpoint01',
        assurance: 'verified',
        answer: maximallyEscapedAnswer,
        revision: 1,
        answeredAt: AT,
        createdAt: AT,
        updatedAt: AT
      }
      repository.state.humanAnswers.set(humanAnswerId, answer)
      firstAnswer ??= answer
    }
    expect(() => toHumanAnswer(firstAnswer!)).not.toThrow()
    const stats = await repository.getProjectCoordinationMaterializationBytes(PROJECT_ID)
    expect(BigInt(stats.humanAnswers)).toBeGreaterThan(BigInt(MAX_PROJECT_COORDINATION_MATERIALIZED_BYTES))
    const materialized: string[] = []
    const nativeMembers = repository.listActiveProjectMemberViewsBounded.bind(repository)
    const nativeTasks = repository.listProjectTasks.bind(repository)
    const nativeRecords = repository.listProjectRecords.bind(repository)
    const nativeRequests = repository.listHumanRequestsForProject.bind(repository)
    const nativeAnswers = repository.listHumanAnswersForProject.bind(repository)
    repository.listActiveProjectMemberViewsBounded = async () => { materialized.push('members'); return [] }
    repository.listProjectTasks = async () => { materialized.push('tasks'); return [] }
    repository.listProjectRecords = async () => { materialized.push('records'); return [] }
    repository.listHumanRequestsForProject = async () => { materialized.push('humanRequests'); return [] }
    repository.listHumanAnswersForProject = async () => { materialized.push('humanAnswers'); return [] }
    const answersBefore = structuredClone([...repository.state.humanAnswers.entries()])

    await expect(service.getProjectCoordinationView(owner, PROJECT_ID)).rejects.toMatchObject({
      code: 'payload_too_large'
    })
    expect(materialized).toEqual([])
    expect([...repository.state.humanAnswers.entries()]).toEqual(answersBefore)

    // A second guard measures the materialized snapshot itself. It is defense in
    // depth for repository-estimator drift; the native estimator above remains the
    // path that prevents this allocation in normal operation.
    repository.getProjectCoordinationMaterializationBytes = async () => ({
      activeMembers: '0', tasks: '0', records: '0', humanRequests: '0', humanAnswers: '0'
    })
    repository.listActiveProjectMemberViewsBounded = nativeMembers
    repository.listProjectTasks = nativeTasks
    repository.listProjectRecords = nativeRecords
    repository.listHumanRequestsForProject = nativeRequests
    repository.listHumanAnswersForProject = nativeAnswers
    await expect(service.getProjectCoordinationView(owner, PROJECT_ID)).rejects.toMatchObject({
      code: 'payload_too_large'
    })
    expect([...repository.state.humanAnswers.entries()]).toEqual(answersBefore)
  })

  it('does not apply the full-snapshot preflight to the independently paged Portal view', async () => {
    const { repository, owner, service } = createHarness()
    repository.getProjectCoordinationMaterializationCounts = async () => {
      throw new Error('Portal must not call the canonical count preflight')
    }
    repository.getProjectCoordinationMaterializationBytes = async () => {
      throw new Error('Portal must not call the canonical byte preflight')
    }

    await expect(service.getPortalProjectCoordinationView(owner, PROJECT_ID)).resolves.toMatchObject({
      project: { projectId: PROJECT_ID },
      members: [{ userId: OWNER_USER_ID }],
      tasks: [],
      records: [],
      humanRequests: []
    })
  })
})
