import { describe, expect, it, vi } from 'vitest'
import { createPortalClient } from './client'
import type { PortalWriteContext, ProjectBudget } from './types'

const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
const writeContext: PortalWriteContext = { csrfToken: 'csrf-not-an-identity-token', idempotencyKey: 'idem_aaaaaaaaaaaaaaaa' }
const budget: ProjectBudget = { maxTasks: 200, maxTasksPerRound: 16, maxCoordinationRounds: 50, maxTaskRetries: 3 }

describe('Portal typed BFF client', () => {
  it('uses only the frozen typed read routes and repeated status query parameters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json({ schemaVersion: 1, type: 'empty', items: [] }))
    const client = createPortalClient({ fetch, origin: 'https://cloud-test.sciforge.cn' })

    await client.listProjects({ limit: 50, cursor: 'next/project', statuses: ['active', 'paused'] })
    await client.listWorkers({ limit: 50, cursor: 'next/worker' })
    await client.listOwnedAgents()
    await client.getCoordination('prj_aaaaaaaaaaaaaaaa', {
      tasksCursor: 'task/next', recordsCursor: 'record/next', humanCursor: 'human/next',
      tasksLimit: 100, recordsLimit: 100, humanLimit: 50
    })

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://cloud-test.sciforge.cn/portal/api/projects?limit=50&cursor=next%2Fproject&statuses=active&statuses=paused',
      'https://cloud-test.sciforge.cn/portal/api/workers?limit=50&cursor=next%2Fworker',
      'https://cloud-test.sciforge.cn/portal/api/agents',
      'https://cloud-test.sciforge.cn/portal/api/projects/prj_aaaaaaaaaaaaaaaa/coordination?tasksCursor=task%2Fnext&recordsCursor=record%2Fnext&humanCursor=human%2Fnext&tasksLimit=100&recordsLimit=100&humanLimit=50'
    ])
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).not.toContain('/portal/api/commands')
      expect(init?.credentials).toBe('same-origin')
      expect(init?.method).toBeUndefined()
      expect((init?.headers as Record<string, string>).authorization).toBeUndefined()
      expect((init?.headers as Record<string, string>)['x-sciforge-csrf']).toBeUndefined()
    }
    expect(() => client.listWorkers({ limit: 51 })).toThrow(/between 1 and 50/u)
  })

  it('maps every mutation to its exact resource route and strict DTO body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json({ schemaVersion: 1, type: 'entity' }))
    const client = createPortalClient({ fetch, origin: 'https://cloud-test.sciforge.cn' })

    await client.createProject({ displayName: 'Atlas', goal: 'Compare structures.', memberUserIds: ['usr_aaaaaaaaaaaaaaaa'], coordinatorAgentId: 'agt_aaaaaaaaaaaaaaaa', budget }, writeContext)
    await client.updateProjectMembers('prj_aaaaaaaaaaaaaaaa', { expectedRevision: 2, addMemberUserIds: ['usr_bbbbbbbbbbbbbbbb'], removeMemberUserIds: [] }, writeContext)
    await client.createTask('prj_aaaaaaaaaaaaaaaa', { expectedRevision: 3, assigneeAgentId: 'agt_bbbbbbbbbbbbbbbb', title: 'Fold', objective: 'Predict a structure.', completionCriteria: ['Return ranking.'], dependencyTaskIds: [], capabilityIds: ['protein.structure'] }, writeContext)
    await client.cancelTask('tsk_aaaaaaaaaaaaaaaa', { executionId: 'exe_aaaaaaaaaaaaaaaa', expectedRevision: 4 }, writeContext)
    await client.retryTask('tsk_aaaaaaaaaaaaaaaa', { executionId: 'exe_aaaaaaaaaaaaaaaa', assigneeAgentId: 'agt_bbbbbbbbbbbbbbbb', expectedRevision: 5 }, writeContext)
    await client.reviewProjectRecord('rec_aaaaaaaaaaaaaaaa', { expectedRevision: 6, decision: 'accepted' }, writeContext)

    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ['https://cloud-test.sciforge.cn/portal/api/projects', 'POST'],
      ['https://cloud-test.sciforge.cn/portal/api/projects/prj_aaaaaaaaaaaaaaaa/members', 'PATCH'],
      ['https://cloud-test.sciforge.cn/portal/api/projects/prj_aaaaaaaaaaaaaaaa/tasks', 'POST'],
      ['https://cloud-test.sciforge.cn/portal/api/tasks/tsk_aaaaaaaaaaaaaaaa/cancel', 'POST'],
      ['https://cloud-test.sciforge.cn/portal/api/tasks/tsk_aaaaaaaaaaaaaaaa/retry', 'POST'],
      ['https://cloud-test.sciforge.cn/portal/api/records/rec_aaaaaaaaaaaaaaaa/review', 'POST']
    ])
    expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toEqual({
      expectedRevision: 3,
      assigneeAgentId: 'agt_bbbbbbbbbbbbbbbb',
      title: 'Fold',
      objective: 'Predict a structure.',
      completionCriteria: ['Return ranking.'],
      dependencyTaskIds: [],
      capabilityIds: ['protein.structure']
    })
    for (const [url, init] of fetch.mock.calls) {
      const headers = init?.headers as Record<string, string>
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(init?.credentials).toBe('same-origin')
      expect(headers).toMatchObject({ 'x-sciforge-csrf': writeContext.csrfToken, 'idempotency-key': writeContext.idempotencyKey })
      expect(headers.authorization).toBeUndefined()
      expect(String(url)).not.toContain('/portal/api/commands')
      expect(body).not.toHaveProperty('protocolVersion')
      expect(body).not.toHaveProperty('requestId')
      expect(body).not.toHaveProperty('type')
      expect(body).not.toHaveProperty('idempotencyKey')
      expect(body).not.toHaveProperty('ownerUserId')
    }
  })

  it('maps an unauthenticated session without exposing a token-shaped value', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code: 'unauthenticated' } }, { status: 401 }))
    const session = await createPortalClient({ fetch, origin: 'https://cloud-test.sciforge.cn' }).getSession()
    expect(session).toEqual({ authenticated: false })
    expect(JSON.stringify(session)).not.toMatch(/token|secret|credential/iu)
  })

  it('opens the wake socket at an exact path with the required subprotocol and no query credential', () => {
    const opened: string[] = []
    const protocols: Array<string | string[] | undefined> = []
    const sent: string[] = []
    let activeSocket: FakeSocket | undefined
    class FakeSocket extends EventTarget {
      readonly url: string
      constructor(url: string | URL, protocol?: string | string[]) { super(); this.url = String(url); opened.push(this.url); protocols.push(protocol); activeSocket = this }
      send(value: string): void { sent.push(value) }
      close(): void {}
    }
    const client = createPortalClient({ fetch: vi.fn(), WebSocket: FakeSocket as unknown as typeof WebSocket, origin: 'https://cloud-test.sciforge.cn' })
    const authenticationRequired = vi.fn()
    const unsubscribe = client.subscribe('prj_aaaaaaaaaaaaaaaa', () => undefined, undefined, authenticationRequired)
    expect(opened).toEqual(['wss://cloud-test.sciforge.cn/portal/events'])
    expect(protocols).toEqual(['sciforge.portal.v1'])
    expect(opened[0]).not.toContain('?')
    activeSocket?.dispatchEvent(new Event('open'))
    expect(JSON.parse(sent[0]!)).toEqual({ schemaVersion: 1, type: 'project.subscribe', projectId: 'prj_aaaaaaaaaaaaaaaa' })
    const authenticationClose = new Event('close')
    Object.defineProperties(authenticationClose, { code: { value: 1008 }, reason: { value: 'Portal session is no longer current' } })
    activeSocket?.dispatchEvent(authenticationClose)
    expect(authenticationRequired).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('stops a revoked Project subscription on subscription.error without reconnecting', () => {
    vi.useFakeTimers()
    try {
      const opened: FakeSocket[] = []
      class FakeSocket extends EventTarget {
        constructor(_url: string | URL, _protocol?: string | string[]) { super(); opened.push(this) }
        send(): void {}
        close(): void {}
      }
      const onSubscriptionError = vi.fn()
      const client = createPortalClient({ fetch: vi.fn(), WebSocket: FakeSocket as unknown as typeof WebSocket, origin: 'https://cloud-test.sciforge.cn' })
      client.subscribe('prj_aaaaaaaaaaaaaaaa', () => undefined, undefined, undefined, onSubscriptionError)
      opened[0]?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ schemaVersion: 1, type: 'subscription.error', code: 'permission_denied' }) }))
      expect(onSubscriptionError).toHaveBeenCalledWith({ code: 'permission_denied' })
      vi.advanceTimersByTime(60_000)
      expect(opened).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats every non-authentication 1008 close as terminal policy rejection', () => {
    vi.useFakeTimers()
    try {
      const opened: FakeSocket[] = []
      class FakeSocket extends EventTarget {
        constructor(_url: string | URL, _protocol?: string | string[]) { super(); opened.push(this) }
        send(): void {}
        close(): void {}
      }
      const onSubscriptionError = vi.fn()
      const client = createPortalClient({ fetch: vi.fn(), WebSocket: FakeSocket as unknown as typeof WebSocket, origin: 'https://cloud-test.sciforge.cn' })
      client.subscribe('prj_aaaaaaaaaaaaaaaa', () => undefined, undefined, undefined, onSubscriptionError)
      const policyClose = new Event('close')
      Object.defineProperties(policyClose, { code: { value: 1008 }, reason: { value: 'Project subscription required' } })
      opened[0]?.dispatchEvent(policyClose)
      expect(onSubscriptionError).toHaveBeenCalledWith({ code: 'websocket_policy_rejected', message: 'Project subscription required' })
      vi.advanceTimersByTime(60_000)
      expect(opened).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the fixed login path without an attacker-controlled return URL', () => {
    const client = createPortalClient({ fetch: vi.fn(), origin: 'https://cloud-test.sciforge.cn' })
    expect(client.loginUrl('https://evil.example/')).toBe('https://cloud-test.sciforge.cn/portal/auth/login')
  })
})
