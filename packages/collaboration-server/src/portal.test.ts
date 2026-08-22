import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { projectRecordSchema, type RestRequest, type RestResponse } from '@sciforge/collaboration-contracts'

import { FakeCollaborationRepository } from '../../../test-fixtures/collaboration/fake-adapters.mjs'

import type { UserActor } from './auth.js'
import { dispatchAuditedCollaborationCommand, type CollaborationHttpOptions } from './api.js'
import { CollaborationPortal, type PortalPackSerializationProbe } from './portal.js'
import type { PortalAssetStore } from './portal-assets.js'
import type { PortalSessionManager } from './portal-session.js'
import { CollaborationService } from './service.js'

const ORIGIN = 'https://cloud-test.sciforge.cn'
const actor: UserActor = {
  kind: 'user',
  actorKey: 'oidc:portal-user',
  userId: 'usr_portalOwner0001',
  identityId: 'oid_portalIdentity01',
  issuer: 'https://login-test.sciforge.cn/realms/SciForge',
  subject: 'portal-user-subject',
  authTime: 1_787_400_000,
  expiresAt: 1_787_400_300,
  assurance: 'verified'
}
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close()
    await once(server, 'close')
  }))
})

describe('Portal HTTP boundary', () => {
  it('serves only bound local assets with SciForge security headers', async () => {
    const runtime = await openPortal()
    const redirect = await fetch(`${runtime.baseUrl}/portal`, { redirect: 'manual' })
    expect(redirect.status).toBe(308)
    expect(redirect.headers.get('location')).toBe('/portal/')

    const index = await fetch(`${runtime.baseUrl}/portal/`)
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('sciforge-portal-root')
    expect(index.headers.get('cache-control')).toBe('no-store')
    expect(index.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(index.headers.get('content-security-policy')).toContain("connect-src 'self'")
    expect(index.headers.get('permissions-policy')).toContain('camera=()')
    expect(index.headers.get('x-frame-options')).toBe('DENY')

    const script = await fetch(`${runtime.baseUrl}/portal/assets/app-abcd1234.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const notModified = await fetch(`${runtime.baseUrl}/portal/assets/app-abcd1234.js`, {
      headers: { 'if-none-match': '"a"' }
    })
    expect(notModified.status).toBe(304)
    expect((await fetch(`${runtime.baseUrl}/portal/unknown.js`)).status).toBe(404)
  })

  it('exposes a safe session snapshot and typed Project resources without a raw command relay', async () => {
    const runtime = await openPortal()
    const session = await fetch(`${runtime.baseUrl}/portal/api/session`, {
      headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: 'session=test' }
    })
    expect(session.status).toBe(200)
    const sessionBody = await session.json() as Record<string, unknown>
    expect(sessionBody).toMatchObject({
      schemaVersion: 1,
      type: 'portal.session',
      authenticated: true,
      user: { userId: actor.userId, displayName: 'Portal Owner' },
      csrfToken: 'C'.repeat(43)
    })
    expect(JSON.stringify(sessionBody)).not.toMatch(/subject|access.?token|refresh.?token|identityId/iu)

    const accepted = await fetch(`${runtime.baseUrl}/portal/api/projects?limit=50`, {
      headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: 'session=test' }
    })
    const acceptedText = await accepted.text()
    expect(accepted.status, acceptedText).toBe(200)
    expect(JSON.parse(acceptedText)).toEqual({ schemaVersion: 1, type: 'project_list_page', items: [] })
    expect(runtime.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      protocolVersion: '1.0', requestId: expect.stringMatching(/^req_/u), type: 'project.list', limit: 50
    }), actor)
    expect(runtime.sessions.authenticate).toHaveBeenCalledTimes(1)
    expect(runtime.sessions.authenticatePassive).toHaveBeenCalledTimes(1)

    const denied = await fetch(`${runtime.baseUrl}/portal/api/commands`, {
      method: 'POST', headers: portalHeaders('idem_portal_revoke_0001'), body: '{}'
    })
    expect(denied.status).toBe(404)
    expect(runtime.dispatch).toHaveBeenCalledTimes(1)
  })

  it('records each Portal cross-Project and stale-revision rejection exactly once', async () => {
    const repository = new FakeCollaborationRepository()
    const at = '2026-08-22T12:00:00.000Z'
    const project = (projectId: string, ownerUserId: string, revision: number) => ({
      projectId,
      ownerUserId,
      displayName: `${projectId} project`,
      goal: 'Verify the shared audited dispatch boundary.',
      status: 'active' as const,
      coordinatorAgentId: 'agt_PortalAuditCoord1',
      budgets: { maxTasks: 10, maxTasksPerRound: 5, maxTaskRetries: 2, maxCoordinationRounds: 5 },
      coordinationRound: 1,
      revision,
      createdAt: at,
      updatedAt: at
    })
    repository.state.projects.set('prj_PortalAuditOwned', project('prj_PortalAuditOwned', actor.userId, 2))
    repository.state.projects.set('prj_PortalAuditOther', project('prj_PortalAuditOther', 'usr_PortalAuditOther', 1))
    repository.state.projectMembers.set(`prj_PortalAuditOwned:${actor.userId}`, {
      projectId: 'prj_PortalAuditOwned', userId: actor.userId, role: 'owner', active: true, createdAt: at
    })
    repository.state.projectMembers.set('prj_PortalAuditOther:usr_PortalAuditOther', {
      projectId: 'prj_PortalAuditOther', userId: 'usr_PortalAuditOther', role: 'owner', active: true, createdAt: at
    })
    const service = new CollaborationService({ repository, now: () => new Date(at) })
    const httpOptions = { service } as CollaborationHttpOptions
    const runtime = await openPortal({
      dispatch: (command, portalActor) => dispatchAuditedCollaborationCommand(command, portalActor, httpOptions)
    })
    const request = (projectId: string, expectedRevision: number, key: string) => fetch(
      `${runtime.baseUrl}/portal/api/projects/${projectId}/members`,
      {
        method: 'PATCH',
        headers: portalHeaders(key),
        body: JSON.stringify({ expectedRevision, addMemberUserIds: [], removeMemberUserIds: [actor.userId] })
      }
    )

    const crossProject = await request('prj_PortalAuditOther', 1, 'idem_portal_audit_cross_01')
    expect(crossProject.status).toBe(403)
    await expect(crossProject.json()).resolves.toMatchObject({ error: { code: 'permission_denied' } })
    const stale = await request('prj_PortalAuditOwned', 1, 'idem_portal_audit_stale_01')
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ error: { code: 'revision_conflict' } })

    expect(repository.state.auditEvents.filter((event) => (
      event.action === 'project.members.update' && event.outcome === 'rejected'
    ))).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ errorCode: 'permission_denied' }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ errorCode: 'revision_conflict' }) })
    ])
  })

  it('rejects malformed payloads and proves executionId is mandatory for cancel and retry', async () => {
    const runtime = await openPortal()
    const missingExecution = await portalMutation(runtime.baseUrl, '/portal/api/tasks/tsk_PortalTask00001/cancel', {
      expectedRevision: 1
    }, 'idem_portal_cancel_0001')
    expect(missingExecution.status).toBe(400)
    expect(runtime.dispatch).not.toHaveBeenCalled()

    const malformed = await fetch(`${runtime.baseUrl}/portal/api/projects`, {
      method: 'POST',
      headers: portalHeaders(),
      body: '{not-json'
    })
    expect(malformed.status).toBe(400)
    expect(JSON.stringify(await malformed.json())).not.toContain('{not-json')
  })

  it('derives one actor-bound Project-create key across a browser reload', async () => {
    const runtime = await openPortal()
    const body = {
      displayName: 'Reload-safe project',
      goal: 'Prove a lost create response cannot duplicate the Project.',
      memberUserIds: ['usr_workerBBBBBBBB', 'usr_workerAAAAAAAA'],
      coordinatorAgentId: 'agt_PortalOwnerAgent1',
      budget: { maxTasks: 20, maxTasksPerRound: 4, maxCoordinationRounds: 5, maxTaskRetries: 2 }
    }
    const first = await portalMutation(runtime.baseUrl, '/portal/api/projects', body, 'idem_browser_before_reload')
    const second = await portalMutation(runtime.baseUrl, '/portal/api/projects', {
      ...body,
      memberUserIds: [...body.memberUserIds].reverse()
    }, 'idem_browser_after_reload')
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const commands = runtime.dispatch.mock.calls.map(([command]) => command as { idempotencyKey: string })
    expect(commands).toHaveLength(2)
    expect(commands[0]!.idempotencyKey).toMatch(/^idem_portal_[a-f0-9]{64}$/u)
    expect(commands[1]!.idempotencyKey).toBe(commands[0]!.idempotencyKey)
    expect(commands[0]!.idempotencyKey).not.toBe('idem_browser_before_reload')
  })

  it('removes HumanAnswer and non-target HumanNeeded content from the typed coordination projection', async () => {
    const runtime = await openPortal()
    runtime.readCoordination.mockImplementationOnce(async () => ({
        schemaVersion: 1, type: 'project_coordination_view', projectId: 'prj_PortalProject01', projectRevision: 1,
        project: { schemaVersion: 1, type: 'project', projectId: 'prj_PortalProject01',
          ownerUserId: actor.userId, displayName: 'Portal Project', goal: 'Verify a safe Portal projection.',
          memberUserIds: [actor.userId], coordinatorAgentId: 'agt_RequestingAgent1', status: 'active',
          budget: { maxTasks: 10, maxTasksPerRound: 5, maxCoordinationRounds: 5, maxTaskRetries: 2 },
          revision: 1, createdAt: '2026-08-22T12:00:00.000Z', updatedAt: '2026-08-22T12:00:00.000Z' },
        members: [{ userId: actor.userId, displayName: 'Portal Owner', role: 'owner', active: true }],
        tasks: [], records: [], readAt: '2026-08-22T12:00:00.000Z',
        humanRequests: [
          { schemaVersion: 1, type: 'human_needed', humanRequestId: 'hrq_TargetRequest01',
            projectId: 'prj_PortalProject01', sourceKind: 'coordinator', taskId: null, executionId: null,
            sourceInboxMessageId: 'ibx_TargetRequest001', targetUserId: actor.userId,
            requestedByAgentId: 'agt_RequestingAgent1', requiredAssurance: 'verified',
            prompt: 'private prompt marker', confirmableAction: null,
            status: 'pending', expiresAt: '2026-08-22T12:10:00.000Z', revision: 1,
            createdAt: '2026-08-22T12:00:00.000Z', updatedAt: '2026-08-22T12:00:00.000Z' },
          { schemaVersion: 1, type: 'human_needed', humanRequestId: 'hrq_OtherRequest001',
            projectId: 'prj_PortalProject01', sourceKind: 'coordinator', taskId: null, executionId: null,
            sourceInboxMessageId: 'ibx_OtherRequest0001', targetUserId: 'usr_OtherPortalUser1', requestedByAgentId: 'agt_RequestingAgent1',
            requiredAssurance: 'verified', prompt: 'other-user-private-marker', confirmableAction: null,
            status: 'pending', expiresAt: '2026-08-22T12:10:00.000Z', revision: 1,
            createdAt: '2026-08-22T12:00:00.000Z', updatedAt: '2026-08-22T12:00:00.000Z' }
        ],
        humanAnswers: [{ schemaVersion: 1, type: 'human_answer', humanAnswerId: 'han_PrivateAnswer01',
          humanRequestId: 'hrq_TargetRequest01', projectId: 'prj_PortalProject01', taskId: null,
          executionId: null, requestRevision: 1, answeredByUserId: actor.userId,
          answeredFromHumanEndpointId: 'hep_PrivateEndpoint1', assurance: 'verified', answer: 'private answer marker',
          decision: null, confirmationId: null, answeredAt: '2026-08-22T12:01:00.000Z', revision: 1,
          createdAt: '2026-08-22T12:01:00.000Z', updatedAt: '2026-08-22T12:01:00.000Z' }]
    }))
    const response = await fetch(`${runtime.baseUrl}/portal/api/projects/prj_PortalProject01/coordination`, {
      headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: 'session=test' }
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toMatch(/private prompt|other-user-private|private answer|confirmableAction|humanAnswers/u)
    expect(JSON.parse(text)).toMatchObject({
      humanRequests: [{ humanRequestId: 'hrq_TargetRequest01', status: 'pending' }]
    })
    expect(runtime.readCoordination).toHaveBeenCalledWith(actor, 'prj_PortalProject01', {
      tasksLimit: 50,
      recordsLimit: 50,
      humanLimit: 25
    })
    expect(runtime.dispatch).not.toHaveBeenCalled()
  })

  it('adaptively packs legal large coordination items and returns a cursor instead of a 2 MiB failure', async () => {
    const runtime = await openPortal()
    const projectId = 'prj_ByteBounded0001'
    const criterion = (index: number) => ({ criterionId: `cri_ByteCriterion${String(index).padStart(4, '0')}`,
      text: 'x'.repeat(32_000) })
    const task = (index: number, criteria: number) => ({
      schemaVersion: 1, type: 'task', taskId: `tsk_ByteTask${String(index).padStart(8, '0')}`, projectId,
      executionId: `exe_ByteTask${String(index).padStart(8, '0')}`, createdByCoordinatorAgentId: 'agt_ByteCoordinator01',
      assigneeAgentId: 'agt_ByteWorker000001', assigneeUserId: actor.userId, title: `Large task ${index}`,
      objective: 'o'.repeat(32_000), completionCriteria: Array.from({ length: criteria }, (_, item) => criterion(item)),
      dependencyTaskIds: [], requiredCapabilities: { capabilityIds: [], vpnAccessIds: [], slurmClusterIds: [],
        requiredResourceRefIds: [] }, resourceRefIds: [], authorizationRequirements: [], status: 'running',
      attempt: 1, maxRetries: 2, revision: 1, createdAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:00:00.000Z'
    })
    const maximumJsonExpansionText = '\u0001'
    const resourceRefIds = Array.from({ length: 1_000 }, (_, index) => (
      `rrf_${String(index).padStart(4, '0')}${'R'.repeat(60)}`
    ))
    const record = {
      schemaVersion: 1, type: 'project_record', projectRecordId: 'rec_ByteRecord00001', projectId,
      kind: 'task_result', status: 'proposed', body: maximumJsonExpansionText.repeat(32_000), authorUserId: actor.userId,
      authorAgentId: 'agt_ByteWorker000001', sourceTaskId: 'tsk_ByteTask00000000',
      sourceExecutionId: 'exe_ByteTask00000000', sourceRevision: 1,
      criterionEvidence: Array.from({ length: 100 }, (_, index) => ({
        criterionId: `cri_${String(index).padStart(4, '0')}${'C'.repeat(60)}`,
        summary: maximumJsonExpansionText.repeat(2_000), resourceRefIds
      })),
      resourceRefIds, logSummary: maximumJsonExpansionText.repeat(2_000), acceptedByUserId: null,
      acceptedByAgentId: null, acceptedAt: null, revision: 1,
      createdAt: '2026-08-22T12:00:00.000Z', updatedAt: '2026-08-22T12:00:00.000Z'
    }
    expect(projectRecordSchema.safeParse(record).success).toBe(true)
    runtime.readCoordination.mockResolvedValueOnce({
      schemaVersion: 1, type: 'project_coordination_view', projectId, projectRevision: 1,
      project: { projectId }, members: [],
      tasks: [task(0, 100), ...Array.from({ length: 29 }, (_, index) => task(index + 1, 2))],
      records: [record], humanRequests: [],
      pagination: {
        tasks: { limit: 50, version: 'tasks:30:30' },
        records: { limit: 50, version: 'records:1:1' },
        humanRequests: { limit: 25, version: 'human:0:0' }
      },
      readAt: '2026-08-22T12:00:00.000Z'
    })

    const response = await fetch(`${runtime.baseUrl}/portal/api/projects/${projectId}/coordination`, {
      headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: 'session=test' }
    })
    const text = await response.text()
    expect(response.status, text.slice(0, 500)).toBe(200)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024)
    const body = JSON.parse(text) as { tasks: Array<Record<string, unknown>>; records: Array<Record<string, unknown>>; pagination: {
      tasks: { version: string; nextCursor?: string }
      records: { version: string; nextCursor?: string }
      humanRequests: { version: string; nextCursor?: string }
    } }
    expect(body.tasks.length).toBeGreaterThan(0)
    expect(body.tasks.length).toBeLessThan(30)
    expect(body.tasks[0]).toMatchObject({ portalProjection: { truncated: true, reason: 'item_byte_limit' } })
    expect(body.records[0]).toMatchObject({ portalProjection: { truncated: true, reason: 'item_byte_limit' } })
    expect(body.records[0]?.criterionEvidence).toHaveLength(1)
    expect(body.records[0]?.resourceRefIds).toHaveLength(10)
    expect(body.pagination.tasks.nextCursor).toMatch(/^p1\./u)
    expect(body.pagination).toMatchObject({
      tasks: { version: 'tasks:30:30' },
      records: { version: 'records:1:1' },
      humanRequests: { version: 'human:0:0' }
    })
  })

  it('adaptively packs a legal maximum Project page and preserves keyset continuity', async () => {
    const pack = createPackSerializationProbe()
    const runtime = await openPortal({ packSerializationProbe: pack.probe })
    const updatedAt = '2026-08-22T12:00:00.000Z'
    const projects = Array.from({ length: 50 }, (_, index) => ({
      projectId: `prj_PackedProject${String(index).padStart(3, '0')}`,
      displayName: `Packed Project ${index}`,
      goal: '\u0001'.repeat(32_000),
      status: 'active' as const,
      role: 'owner' as const,
      memberCount: 1,
      taskCounts: { offered: 0, accepted: 0, rejected: 0, running: 0,
        needsHuman: 0, succeeded: 0, failed: 0, cancelled: 0 },
      pendingResultCount: 0,
      revision: 1,
      updatedAt
    }))
    runtime.dispatch.mockImplementation(async (command) => {
      const typed = command as { requestId: string; type: string; cursor?: string }
      if (typed.type !== 'project.list') throw new Error('Unexpected Portal command')
      const after = typed.cursor ? decodePortalCursor(typed.cursor, 'projects').split('\u001f')[1] : undefined
      return {
        protocolVersion: '1.0' as const,
        requestId: typed.requestId,
        type: 'rest.entity' as const,
        entity: {
          schemaVersion: 1 as const,
          type: 'project_list_page' as const,
          items: projects.filter((item) => !after || item.projectId > after)
        }
      }
    })

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      pack.reset()
      const expectedInputItems = projects.slice(seen.length).map((item) => item.projectId)
      const query = new URLSearchParams({ limit: '50' })
      if (cursor) query.set('cursor', cursor)
      const response = await fetch(`${runtime.baseUrl}/portal/api/projects?${query}`, {
        headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: 'session=test' }
      })
      const text = await response.text()
      expect(response.status, text.slice(0, 500)).toBe(200)
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024)
      expect(pack.events.filter((event) => event.phase === 'header')).toHaveLength(1)
      expect(pack.events.filter((event) => event.phase === 'final')).toHaveLength(1)
      expect(pack.events.filter((event) => event.phase === 'item').map((event) => (
        (event.value as { projectId: string }).projectId
      ))).toEqual(expectedInputItems)
      const body = JSON.parse(text) as { items: Array<{ projectId: string; updatedAt: string }>; nextCursor?: string }
      expect(body.items.length).toBeGreaterThan(0)
      seen.push(...body.items.map((item) => item.projectId))
      if (body.nextCursor) {
        const last = body.items.at(-1)!
        expect(decodePortalCursor(body.nextCursor, 'projects')).toBe(`${last.updatedAt}\u001f${last.projectId}`)
      }
      cursor = body.nextCursor
      pages += 1
    } while (cursor)

    expect(pages).toBeGreaterThan(1)
    expect(seen).toEqual(projects.map((item) => item.projectId))
    expect(new Set(seen).size).toBe(projects.length)
  })

  it('adaptively packs a legal maximum Worker page and preserves keyset continuity', async () => {
    const pack = createPackSerializationProbe()
    const runtime = await openPortal({ packSerializationProbe: pack.probe })
    const runtimeIds = Array.from({ length: 100 }, (_, index) =>
      `Runtime.${String(index).padStart(3, '0')}`.padEnd(128, 'r'))
    const capabilityIds = Array.from({ length: 256 }, (_, index) =>
      `cap.${String(index).padStart(3, '0')}`.padEnd(128, 'a'))
    const gpu = Array.from({ length: 32 }, (_, index) => ({
      vendor: `Vendor ${index}`.padEnd(100, 'v'),
      model: `Model ${index}`.padEnd(200, 'm'),
      memoryGB: 24
    }))
    const workers = Array.from({ length: 50 }, (_, index) => ({
      ownerUserId: actor.userId,
      agentId: `agt_PackedWorker${String(index).padStart(3, '0')}`,
      displayName: `Packed Worker ${index}`.padEnd(200, 'w'),
      nodeType: 'desktop' as const,
      os: { family: 'linux' as const, architecture: 'x64' as const },
      runtimeIds,
      capabilityIds,
      gpu,
      status: 'online' as const,
      lastSeenAt: '2026-08-22T12:00:00.000Z',
      profileExpiresAt: '2026-08-22T13:00:00.000Z',
      revision: 1
    }))
    runtime.dispatch.mockImplementation(async (command) => {
      const typed = command as { requestId: string; type: string; cursor?: string }
      if (typed.type !== 'worker.directory.page') throw new Error('Unexpected Portal command')
      const after = typed.cursor ? decodePortalCursor(typed.cursor, 'workers') : undefined
      return {
        protocolVersion: '1.0' as const,
        requestId: typed.requestId,
        type: 'rest.entity' as const,
        entity: {
          schemaVersion: 1 as const,
          type: 'worker_directory_page' as const,
          stats: { total: 50, online: 50, busy: 0, offline: 0, desktop: 50, server: 0 },
          items: workers.filter((item) => !after || item.agentId > after),
          readAt: '2026-08-22T12:00:00.000Z'
        }
      }
    })

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      pack.reset()
      const expectedInputItems = workers.slice(seen.length).map((item) => item.agentId)
      const query = new URLSearchParams({ limit: '50' })
      if (cursor) query.set('cursor', cursor)
      const response = await fetch(`${runtime.baseUrl}/portal/api/workers?${query}`, {
        headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: 'session=test' }
      })
      const text = await response.text()
      expect(response.status, text.slice(0, 500)).toBe(200)
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024)
      expect(pack.events.filter((event) => event.phase === 'header')).toHaveLength(1)
      expect(pack.events.filter((event) => event.phase === 'final')).toHaveLength(1)
      expect(pack.events.filter((event) => event.phase === 'item').map((event) => (
        (event.value as { agentId: string }).agentId
      ))).toEqual(expectedInputItems)
      const body = JSON.parse(text) as { items: Array<{ agentId: string }>; nextCursor?: string }
      expect(body.items.length).toBeGreaterThan(0)
      seen.push(...body.items.map((item) => item.agentId))
      if (body.nextCursor) {
        expect(decodePortalCursor(body.nextCursor, 'workers')).toBe(body.items.at(-1)!.agentId)
      }
      cursor = body.nextCursor
      pages += 1
    } while (cursor)

    expect(pages).toBeGreaterThan(1)
    expect(seen).toEqual(workers.map((item) => item.agentId))
    expect(new Set(seen).size).toBe(workers.length)
  })

  it('packs a maximum coordination page in one linear item pass with fair exact cursors', async () => {
    const pack = createPackSerializationProbe()
    const runtime = await openPortal({ packSerializationProbe: pack.probe })
    const projectId = 'prj_LinearPacked0001'
    const largeText = '\u0001'.repeat(18_000)
    const tasks = Array.from({ length: 100 }, (_, index) => ({
      schemaVersion: 1,
      type: 'task',
      taskId: `tsk_LinearPacked${String(index).padStart(4, '0')}`,
      projectId,
      executionId: `exe_LinearPacked${String(index).padStart(4, '0')}`,
      createdByCoordinatorAgentId: 'agt_LinearCoordinator1',
      assigneeAgentId: 'agt_LinearWorker0001',
      assigneeUserId: actor.userId,
      title: `Linear task ${index}`,
      objective: largeText,
      completionCriteria: [],
      dependencyTaskIds: [],
      requiredCapabilities: { capabilityIds: [], vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: [] },
      resourceRefIds: [],
      authorizationRequirements: [],
      status: 'running',
      attempt: 1,
      maxRetries: 2,
      revision: 1,
      createdAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:00:00.000Z'
    }))
    const records = Array.from({ length: 100 }, (_, index) => ({
      schemaVersion: 1,
      type: 'project_record',
      projectRecordId: `rec_LinearPacked${String(index).padStart(4, '0')}`,
      projectId,
      kind: 'task_progress',
      status: 'committed',
      body: largeText,
      authorUserId: actor.userId,
      authorAgentId: 'agt_LinearWorker0001',
      sourceTaskId: tasks[index]!.taskId,
      sourceExecutionId: tasks[index]!.executionId,
      sourceRevision: 1,
      criterionEvidence: [],
      resourceRefIds: [],
      logSummary: null,
      acceptedByUserId: null,
      acceptedByAgentId: null,
      acceptedAt: null,
      revision: 1,
      createdAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:00:00.000Z'
    }))
    const humanRequests = Array.from({ length: 50 }, (_, index) => ({
      schemaVersion: 1,
      type: 'human_needed',
      humanRequestId: `hrq_LinearPacked${String(index).padStart(4, '0')}`,
      projectId,
      sourceKind: 'coordinator',
      taskId: null,
      executionId: null,
      sourceInboxMessageId: `ibx_LinearPacked${String(index).padStart(4, '0')}`,
      targetUserId: actor.userId,
      requestedByAgentId: 'agt_LinearCoordinator1',
      requiredAssurance: 'verified',
      prompt: `Prompt ${index}`,
      confirmableAction: null,
      status: 'pending',
      expiresAt: '2026-08-22T12:10:00.000Z',
      revision: 1,
      createdAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:00:00.000Z'
    }))
    runtime.readCoordination.mockResolvedValueOnce({
      schemaVersion: 1,
      type: 'project_coordination_view',
      projectId,
      projectRevision: 1,
      project: { projectId },
      members: [],
      tasks,
      records,
      humanRequests,
      pagination: {
        tasks: { limit: 100, version: 'tasks:100:100' },
        records: { limit: 100, version: 'records:100:100' },
        humanRequests: { limit: 50, version: 'human:50:50' }
      },
      readAt: '2026-08-22T12:00:00.000Z'
    })

    const response = await fetch(`${runtime.baseUrl}/portal/api/projects/${projectId}/coordination?` +
      'tasksLimit=100&recordsLimit=100&humanLimit=50', {
      headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: 'session=test' }
    })
    const text = await response.text()
    expect(response.status, text.slice(0, 500)).toBe(200)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(pack.events.filter((event) => event.phase === 'header')).toHaveLength(1)
    expect(pack.events.filter((event) => event.phase === 'final')).toHaveLength(1)
    const itemIds = pack.events.filter((event) => event.phase === 'item').map((event) => {
      const value = event.value as { taskId?: string; projectRecordId?: string; humanRequestId?: string }
      return value.taskId ?? value.projectRecordId ?? value.humanRequestId
    })
    expect(itemIds).toEqual([
      ...tasks.map((task) => task.taskId),
      ...records.map((record) => record.projectRecordId),
      ...humanRequests.map((request) => request.humanRequestId)
    ])
    const body = JSON.parse(text) as {
      tasks: Array<{ taskId: string }>
      records: Array<{ projectRecordId: string }>
      humanRequests: Array<{ humanRequestId: string }>
      pagination: {
        tasks: { nextCursor?: string }
        records: { nextCursor?: string }
        humanRequests: { nextCursor?: string }
      }
    }
    expect(body.tasks.length).toBeGreaterThan(0)
    expect(body.records.length).toBeGreaterThan(0)
    expect(body.humanRequests.length).toBeGreaterThan(0)
    expect(body.tasks.length).toBeLessThan(tasks.length)
    expect(body.records.length).toBeLessThan(records.length)
    expect(decodePortalCursor(body.pagination.tasks.nextCursor!, 'coordination.tasks')).toBe(
      `${projectId}\u001f${body.tasks.at(-1)!.taskId}`
    )
    expect(decodePortalCursor(body.pagination.records.nextCursor!, 'coordination.records')).toBe(
      `${projectId}\u001f${body.records.at(-1)!.projectRecordId}`
    )
    if (body.pagination.humanRequests.nextCursor) {
      expect(decodePortalCursor(body.pagination.humanRequests.nextCursor, 'coordination.human')).toBe(
        `${projectId}\u001f${body.humanRequests.at(-1)!.humanRequestId}`
      )
    } else {
      expect(body.humanRequests).toHaveLength(humanRequests.length)
    }
  })

  it('uses the OIDC BFF redirects and clears both cookies on logout', async () => {
    const runtime = await openPortal()
    const login = await fetch(`${runtime.baseUrl}/portal/auth/login`, { redirect: 'manual' })
    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toBe('https://login-test.sciforge.cn/authorize')
    expect(login.headers.get('set-cookie')).toContain('__Host-sciforge-portal-login=')

    const callback = await fetch(`${runtime.baseUrl}/portal/auth/callback?code=value&state=value`, {
      redirect: 'manual',
      headers: { cookie: 'login=value' }
    })
    expect(callback.status).toBe(303)
    expect(callback.headers.get('location')).toBe('/portal/')
    expect(callback.headers.getSetCookie().join('\n')).not.toMatch(/access|refresh|subject/u)

    const logout = await fetch(`${runtime.baseUrl}/portal/auth/logout`, {
      method: 'POST',
      headers: portalHeaders()
    })
    expect(logout.status).toBe(204)
    expect(logout.headers.getSetCookie().join('\n')).toContain('__Host-sciforge-portal=;')
  })
})

async function openPortal(options: {
  dispatch?: (command: RestRequest, actor: UserActor) => Promise<RestResponse>
  packSerializationProbe?: PortalPackSerializationProbe
} = {}) {
  const defaultDispatch = async (command: RestRequest): Promise<RestResponse> => ({
      protocolVersion: '1.0' as const,
      requestId: command.requestId,
      type: 'rest.entity' as const,
      entity: { schemaVersion: 1 as const, type: 'project_list_page' as const, items: [] }
    })
  const dispatch = vi.fn(options.dispatch ?? defaultDispatch)
  const sessions = {
    beginLogin: vi.fn(async () => ({
      location: 'https://login-test.sciforge.cn/authorize',
      setCookie: '__Host-sciforge-portal-login=value; Path=/; Secure; HttpOnly; SameSite=Lax'
    })),
    completeLogin: vi.fn(async () => ({
      actor,
      csrfToken: 'C'.repeat(43),
      setCookies: [
        '__Host-sciforge-portal-login=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
        '__Host-sciforge-portal=session; Path=/; Secure; HttpOnly; SameSite=Strict'
      ]
    })),
    authenticate: vi.fn(async () => ({
      actor,
      csrfToken: 'C'.repeat(43),
      idleExpiresAt: '2026-08-22T12:30:00.000Z',
      absoluteExpiresAt: '2026-08-22T20:00:00.000Z'
    })),
    authenticatePassive: vi.fn(async () => ({
      actor,
      csrfToken: 'C'.repeat(43),
      idleExpiresAt: '2026-08-22T12:30:00.000Z',
      absoluteExpiresAt: '2026-08-22T20:00:00.000Z'
    })),
    authenticateWrite: vi.fn(async () => ({
      actor,
      idleExpiresAt: '2026-08-22T12:30:00.000Z',
      absoluteExpiresAt: '2026-08-22T20:00:00.000Z'
    })),
    logout: vi.fn(async () => [
      '__Host-sciforge-portal=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict',
      '__Host-sciforge-portal-login=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax'
    ])
  } as unknown as PortalSessionManager
  const readCoordination = vi.fn(async () => ({
    schemaVersion: 1,
    type: 'project_coordination_view',
    projectId: 'prj_PortalProject01',
    projectRevision: 1,
    project: {},
    members: [],
    tasks: [],
    records: [],
    humanRequests: [],
    humanAnswers: [],
    readAt: '2026-08-22T12:00:00.000Z'
  }))
  const assets = {
    get(path: string) {
      if (path === '/portal/') return {
        body: Buffer.from('<main id="sciforge-portal-root"></main>'),
        contentType: 'text/html; charset=utf-8',
        cacheControl: 'no-store',
        etag: '"index"'
      }
      if (path === '/portal/assets/app-abcd1234.js') return {
        body: Buffer.from('globalThis.portal=true'),
        contentType: 'text/javascript; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
        etag: '"a"'
      }
      return undefined
    }
  } as unknown as PortalAssetStore
  const portal = new CollaborationPortal({
    assets,
    sessions,
    dispatch: dispatch as never,
    readCoordination,
    userSnapshot: async () => ({ userId: actor.userId, displayName: 'Portal Owner' }),
    packSerializationProbe: options.packSerializationProbe
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    void portal.handle(request, response, url)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test address')
  return { baseUrl: `http://127.0.0.1:${address.port}`, dispatch, readCoordination, sessions }
}

function createPackSerializationProbe() {
  const events: Array<Parameters<PortalPackSerializationProbe>[0]> = []
  const probe: PortalPackSerializationProbe = (event) => events.push(event)
  return {
    events,
    probe,
    reset: () => { events.length = 0 }
  }
}

function portalHeaders(idempotencyKey?: string, includeCsrf = true): Record<string, string> {
  return {
    'content-type': 'application/json',
    cookie: 'session=test',
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    ...(includeCsrf ? { 'x-sciforge-csrf': 'C'.repeat(43) } : {}),
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
  }
}

function portalMutation(baseUrl: string, path: string, body: unknown, idempotencyKey: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: portalHeaders(idempotencyKey),
    body: JSON.stringify(body)
  })
}

function decodePortalCursor(cursor: string, scope: string): string {
  const decoded = Buffer.from(cursor.slice('p1.'.length), 'base64url').toString('utf8')
  const prefix = `${scope}\u0000`
  if (!decoded.startsWith(prefix)) throw new Error(`Unexpected ${scope} cursor`)
  return decoded.slice(prefix.length)
}
