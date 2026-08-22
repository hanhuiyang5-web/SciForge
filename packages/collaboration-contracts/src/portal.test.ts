import { describe, expect, it } from 'vitest'

import {
  ownedAgentListSchema,
  projectListPageSchema,
  workerDirectoryPageSchema
} from './entities.js'
import { restRequestSchema, restResponseSchema } from './protocol.js'
import { TEST_IDS, TEST_TIMESTAMP } from './testing.js'

const envelope = {
  protocolVersion: '1.0' as const,
  requestId: TEST_IDS.requestId
}

describe('Cloud collaboration Portal contracts', () => {
  it('accepts only bounded Project, Worker, owned-Agent, and member commands', () => {
    expect(restRequestSchema.parse({
      ...envelope,
      type: 'project.list',
      statuses: ['active', 'paused'],
      limit: 50
    }).type).toBe('project.list')
    expect(restRequestSchema.parse({
      ...envelope,
      type: 'worker.directory.page',
      cursor: 'p1.d29ya2VycwBhZ3RfMTIzNDU2Nzg5MDEy',
      limit: 25
    }).type).toBe('worker.directory.page')
    expect(restRequestSchema.parse({ ...envelope, type: 'agent.owned.list' }).type).toBe('agent.owned.list')
    const memberUpdate = {
      ...envelope,
      type: 'project.members.update',
      idempotencyKey: 'idem_portal_members_update_01',
      projectId: TEST_IDS.projectId,
      expectedRevision: 2,
      addMemberUserIds: [TEST_IDS.secondUserId],
      removeMemberUserIds: []
    }
    expect(restRequestSchema.parse(memberUpdate).type).toBe('project.members.update')
    expect(restRequestSchema.safeParse({ ...memberUpdate, removeMemberUserIds: [TEST_IDS.secondUserId] }).success)
      .toBe(false)
    expect(restRequestSchema.safeParse({ ...memberUpdate, addMemberUserIds: [], removeMemberUserIds: [] }).success)
      .toBe(false)
    expect(restRequestSchema.safeParse({ ...envelope, type: 'project.list', limit: 51 }).success).toBe(false)
    expect(restRequestSchema.safeParse({ ...envelope, type: 'worker.directory.page', limit: 0 }).success).toBe(false)
  })

  it('publishes bounded safe Project and owned-Agent projections as REST entities', () => {
    const projectPage = projectListPageSchema.parse({
      schemaVersion: 1,
      type: 'project_list_page',
      items: [{
        projectId: TEST_IDS.projectId,
        displayName: 'Portal project',
        goal: 'Coordinate two Workers.',
        status: 'active',
        role: 'owner',
        memberCount: 3,
        taskCounts: { offered: 1, accepted: 0, rejected: 0, running: 1, needsHuman: 0,
          succeeded: 2, failed: 0, cancelled: 0 },
        pendingResultCount: 1,
        revision: 3,
        updatedAt: TEST_TIMESTAMP
      }]
    })
    const ownedAgents = ownedAgentListSchema.parse({
      schemaVersion: 1,
      type: 'owned_agent_list',
      items: [{ agentId: TEST_IDS.agentId, displayName: 'Coordinator', nodeType: 'desktop',
        connectionStatus: 'online', lastSeenAt: TEST_TIMESTAMP, revision: 2 }]
    })
    expect(restResponseSchema.safeParse({ ...envelope, type: 'rest.entity', entity: projectPage }).success).toBe(true)
    expect(restResponseSchema.safeParse({ ...envelope, type: 'rest.entity', entity: ownedAgents }).success).toBe(true)
  })

  it('returns only the explicitly safe Worker directory fields', () => {
    const workerPage = workerDirectoryPageSchema.parse({
      schemaVersion: 1,
      type: 'worker_directory_page',
      stats: { total: 1, online: 1, busy: 0, offline: 0, desktop: 1, server: 0 },
      items: [{
        ownerUserId: TEST_IDS.userId,
        agentId: TEST_IDS.agentId,
        displayName: 'Linux Worker',
        nodeType: 'desktop',
        os: { family: 'linux', architecture: 'x64' },
        runtimeIds: ['codex.runtime'],
        capabilityIds: ['research.execute'],
        gpu: [{ vendor: 'NVIDIA', model: 'L4', memoryGB: 24 }],
        status: 'online',
        lastSeenAt: TEST_TIMESTAMP,
        profileExpiresAt: '2026-08-16T00:00:00.000Z',
        revision: 2
      }],
      readAt: TEST_TIMESTAMP
    })
    expect(restResponseSchema.safeParse({ ...envelope, type: 'rest.entity', entity: workerPage }).success).toBe(true)
    expect(workerDirectoryPageSchema.safeParse({
      ...workerPage,
      items: [{ ...workerPage.items[0], deviceId: 'dev_SecretDevice0001' }]
    }).success).toBe(false)
    expect(workerDirectoryPageSchema.safeParse({
      ...workerPage,
      items: [{ ...workerPage.items[0], email: 'worker@example.invalid' }]
    }).success).toBe(false)
    expect(workerDirectoryPageSchema.safeParse({
      ...workerPage,
      stats: { ...workerPage.stats, total: 2 }
    }).success).toBe(false)
  })
})
