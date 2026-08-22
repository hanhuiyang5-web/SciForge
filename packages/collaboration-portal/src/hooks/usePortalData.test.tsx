// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PortalApiError } from '../client'
import { buildCreateProject } from '../commands'
import { createDemoClient } from '../demo'
import type { CoordinationQuery, CoordinationView, PortalClient, PortalSubscriptionError, ProjectPage } from '../types'
import {
  createSingleFlightLoader,
  portalPollingIntervals,
  shouldTouchPortalSession,
  type PortalDataController,
  usePortalData
} from './usePortalData'

let root: Root | undefined
let container: HTMLDivElement | undefined
let current: PortalDataController | undefined

function Probe({ client }: { client: PortalClient }): ReactNode {
  current = usePortalData(client)
  return null
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  current = undefined
})

async function renderReady(client: PortalClient): Promise<void> {
  await act(async () => {
    root?.render(<Probe client={client} />)
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  expect(current?.phase).toBe('ready')
  expect(current?.projects.length).toBeGreaterThan(0)
  expect(current?.workers.length).toBeGreaterThan(0)
  expect(current?.session?.csrfToken).toBeTruthy()
}

function expectSensitiveProjectionCleared(): void {
  expect(current).toMatchObject({
    phase: 'unauthenticated',
    projects: [],
    workers: [],
    ownedAgents: [],
    view: null,
    selectedProjectId: null,
    workersReadAt: null,
    websocketConnected: false
  })
  expect(current?.session).toEqual({ authenticated: false })
  expect(current?.session?.csrfToken).toBeUndefined()
}

describe('Portal authentication expiry handling', () => {
  it('purges all projections on a typed HTTP 401 and ignores late pre-expiry responses', async () => {
    const base = createDemoClient()
    const initialProjects = await base.listProjects()
    const initialWorkers = await base.listWorkers()
    let resolveLateProjects: ((page: ProjectPage) => void) | undefined
    const listProjects = vi.fn<PortalClient['listProjects']>()
      .mockResolvedValueOnce(initialProjects)
      .mockImplementationOnce(() => new Promise<ProjectPage>((resolve) => { resolveLateProjects = resolve }))
    const listWorkers = vi.fn<PortalClient['listWorkers']>()
      .mockResolvedValueOnce(initialWorkers)
      .mockRejectedValueOnce(new PortalApiError('Portal authentication is required.', { code: 'portal_authentication_required', status: 401 }))
    const client: PortalClient = { ...base, listProjects, listWorkers }

    await renderReady(client)
    await act(async () => { await current?.refresh() })
    expectSensitiveProjectionCleared()

    await act(async () => {
      resolveLateProjects?.(initialProjects)
      await Promise.resolve()
    })
    expectSensitiveProjectionCleared()
  })

  it('stops the live subscription and purges state when the server closes it for stale authentication', async () => {
    const base = createDemoClient()
    let authenticationRequired: (() => void) | undefined
    const cleanup = vi.fn()
    const client: PortalClient = {
      ...base,
      subscribe(_projectId, _onWake, onState, onAuthenticationRequired) {
        onState?.(true)
        authenticationRequired = onAuthenticationRequired
        return cleanup
      }
    }

    await renderReady(client)
    expect(current?.websocketConnected).toBe(true)
    await act(async () => { authenticationRequired?.() })
    expectSensitiveProjectionCleared()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('purges a revoked Project projection and performs one bounded list reconcile', async () => {
    const base = createDemoClient()
    let subscriptionError: ((error: PortalSubscriptionError) => void) | undefined
    const cleanup = vi.fn()
    const listProjects = vi.fn(base.listProjects)
    const client: PortalClient = {
      ...base,
      listProjects,
      subscribe(_projectId, _onWake, onState, _onAuthenticationRequired, onSubscriptionError) {
        onState?.(true)
        subscriptionError = onSubscriptionError
        return cleanup
      }
    }

    await renderReady(client)
    expect(current?.view).not.toBeNull()
    await act(async () => {
      subscriptionError?.({ code: 'permission_denied' })
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(current?.view).toBeNull()
    expect(current?.selectedProjectId).toBeNull()
    expect(current?.selection).toBeNull()
    expect(current?.websocketConnected).toBe(false)
    expect(current?.actionError).toMatch(/access changed/iu)
    expect(listProjects).toHaveBeenCalledTimes(2)
    expect(listProjects.mock.calls.every(([query]) => query?.limit === 50 && query.cursor === undefined)).toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('purges local state even when a server-restart drops the logout response', async () => {
    const base = createDemoClient()
    const client: PortalClient = {
      ...base,
      async logout() { throw new PortalApiError('Connection dropped.', { code: 'portal_transport_failed', status: 0, retryable: true }) }
    }
    await renderReady(client)
    await act(async () => { await current?.logout() })
    expectSensitiveProjectionCleared()
  })

  it('treats mutation success as committed when the independent reconcile loses its response', async () => {
    const base = createDemoClient()
    const initialProjects = await base.listProjects()
    const listProjects = vi.fn<PortalClient['listProjects']>()
      .mockResolvedValueOnce(initialProjects)
      .mockRejectedValueOnce(new PortalApiError('Connection dropped during reconcile.', { code: 'portal_transport_failed', status: 0, retryable: true }))
    const createProject = vi.fn(base.createProject)
    const client: PortalClient = { ...base, listProjects, createProject }
    await renderReady(client)

    let result: unknown
    await act(async () => {
      result = await current?.run(buildCreateProject({
        ownerUserId: 'usr_orchestrator01',
        displayName: 'Protein Structure Atlas',
        goal: 'Build a verified atlas.',
        memberUserIds: ['usr_workeromics001'],
        coordinatorAgentId: 'agt_structuremac01'
      }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(result).toMatchObject({ type: 'project' })
    expect(createProject).toHaveBeenCalledOnce()
    expect(current?.phase).toBe('ready')
    expect(current?.actionPending).toBe(false)
    expect(current?.actionError).toMatch(/^Change committed\. Live data refresh failed:/u)
  })
})

describe('bounded Portal pagination and single-flight reconciliation', () => {
  it('loads Project and Worker continuation pages only after an explicit request', async () => {
    const base = createDemoClient()
    const projectFirst = await base.listProjects()
    const workerFirst = await base.listWorkers()
    const secondProject = { ...projectFirst.items[0]!, projectId: 'prj_secondproject01', displayName: 'Second project' }
    const secondWorker = { ...workerFirst.items[0]!, agentId: 'agt_secondworker001', displayName: 'Second worker' }
    const listProjects = vi.fn<PortalClient['listProjects']>(async (query) => query?.cursor
      ? { ...projectFirst, items: [secondProject], nextCursor: undefined }
      : { ...projectFirst, items: projectFirst.items.slice(0, 1), nextCursor: 'projects-next' })
    const listWorkers = vi.fn<PortalClient['listWorkers']>(async (query) => query?.cursor
      ? { ...workerFirst, items: [secondWorker], nextCursor: undefined }
      : { ...workerFirst, items: workerFirst.items.slice(0, 1), nextCursor: 'workers-next' })
    await renderReady({ ...base, listProjects, listWorkers })
    expect(listProjects).toHaveBeenCalledTimes(1)
    expect(listWorkers).toHaveBeenCalledTimes(1)

    await act(async () => {
      await current?.loadMoreProjects()
      await current?.loadMoreWorkers()
    })
    expect(current?.projects.map((project) => project.projectId)).toContain(secondProject.projectId)
    expect(current?.workers.map((worker) => worker.agentId)).toContain(secondWorker.agentId)
    expect(listProjects.mock.calls[1]?.[0]).toEqual({ cursor: 'projects-next', limit: 50 })
    expect(listWorkers.mock.calls[1]?.[0]).toEqual({ cursor: 'workers-next', limit: 50 })

    await act(async () => { await current?.refresh() })
    expect(current?.projectPagination.stale).toBe(true)
    expect(current?.workerPagination.stale).toBe(true)
    expect(current?.projects.map((project) => project.projectId)).toContain(secondProject.projectId)
    expect(current?.workers.map((worker) => worker.agentId)).toContain(secondWorker.agentId)
    expect(listProjects.mock.calls[2]?.[0]).toEqual({ limit: 50 })
    expect(listWorkers.mock.calls[2]?.[0]).toEqual({ limit: 50 })
  })

  it('fails closed on a repeated Worker cursor instead of scanning a pagination loop', async () => {
    const base = createDemoClient()
    const workerFirst = await base.listWorkers()
    const listWorkers = vi.fn<PortalClient['listWorkers']>(async (query) => ({
      ...workerFirst,
      items: workerFirst.items.slice(0, 1),
      nextCursor: query?.cursor ?? 'workers-loop'
    }))
    await renderReady({ ...base, listWorkers })
    await act(async () => { await current?.loadMoreWorkers() })
    expect(current?.workerPagination.nextCursor).toBeNull()
    expect(current?.workerPagination.error).toMatch(/repeated Worker cursor/iu)
    expect(listWorkers).toHaveBeenCalledTimes(2)
  })

  it('merges an independent record continuation and deduplicates canonical IDs', async () => {
    const base = createDemoClient()
    const first = await base.getCoordination('prj_proteinatlas01')
    const secondRecord = { ...first.records[0]!, projectRecordId: 'rec_secondrecord001', updatedAt: '2026-08-23T12:00:00Z' }
    const firstPage: CoordinationView = {
      ...first,
      pagination: { ...first.pagination, records: { limit: 100, version: 'records:v1', nextCursor: 'records-next' } }
    }
    const getCoordination = vi.fn<PortalClient['getCoordination']>(async (_projectId, query?: CoordinationQuery) => {
      if (!query?.recordsCursor) return firstPage
      return {
        ...firstPage,
        tasks: [],
        records: [first.records[0]!, secondRecord],
        humanRequests: [],
        pagination: {
          tasks: { limit: 1, version: firstPage.pagination.tasks.version },
          records: { limit: 100, version: 'records:v1' },
          humanRequests: { limit: 1, version: firstPage.pagination.humanRequests.version }
        }
      }
    })
    await renderReady({ ...base, getCoordination })
    await act(async () => { await current?.loadMore('records') })
    expect(current?.view?.records.map((record) => record.projectRecordId).sort()).toEqual([
      first.records[0]!.projectRecordId,
      secondRecord.projectRecordId
    ].sort())
    expect(current?.coordinationPagination.records.pagesLoaded).toBe(2)
    expect(getCoordination.mock.calls[1]?.[1]).toEqual({ recordsCursor: 'records-next', tasksLimit: 1, recordsLimit: 100, humanLimit: 1 })
  })

  it('discards retained continuation state on a collection version change, then exposes an inserted item through the new cursor', async () => {
    const base = createDemoClient()
    const baseView = await base.getCoordination('prj_proteinatlas01')
    const inserted = { ...baseView.records[0]!, projectRecordId: 'rec_insertedrecord01', updatedAt: '2026-08-23T13:00:00Z' }
    let firstReads = 0
    const first = (version: string, cursor: string): CoordinationView => ({
      ...baseView,
      records: [baseView.records[0]!],
      pagination: { ...baseView.pagination, records: { limit: 100, version, nextCursor: cursor } }
    })
    const continuation = (version: string, records: CoordinationView['records']): CoordinationView => ({
      ...baseView,
      tasks: [], records, humanRequests: [],
      pagination: {
        tasks: { limit: 1, version: baseView.pagination.tasks.version },
        records: { limit: 100, version },
        humanRequests: { limit: 1, version: baseView.pagination.humanRequests.version }
      }
    })
    const getCoordination = vi.fn<PortalClient['getCoordination']>(async (_projectId, query) => {
      if (!query?.recordsCursor) {
        firstReads += 1
        return firstReads === 1 ? first('records:v1', 'records-old') : first('records:v2', 'records-new')
      }
      if (query.recordsCursor === 'records-old') return continuation('records:v2', [inserted])
      return continuation('records:v2', [inserted])
    })
    await renderReady({ ...base, getCoordination })

    await act(async () => {
      await current?.loadMore('records')
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(current?.coordinationPagination.records).toMatchObject({ pagesLoaded: 1, version: 'records:v2', nextCursor: 'records-new' })
    expect(current?.view?.records.some((record) => record.projectRecordId === inserted.projectRecordId)).toBe(false)

    await act(async () => { await current?.loadMore('records') })
    expect(current?.view?.records.some((record) => record.projectRecordId === inserted.projectRecordId)).toBe(true)
  })

  it('fails closed when a coordination continuation repeats its requested cursor', async () => {
    const base = createDemoClient()
    const baseView = await base.getCoordination('prj_proteinatlas01')
    const first: CoordinationView = {
      ...baseView,
      pagination: { ...baseView.pagination, tasks: { limit: 100, version: 'tasks:loop', nextCursor: 'tasks-loop' } }
    }
    const getCoordination = vi.fn<PortalClient['getCoordination']>(async (_projectId, query) => query?.tasksCursor ? {
      ...first,
      tasks: [], records: [], humanRequests: [],
      pagination: {
        tasks: { limit: 100, version: 'tasks:loop', nextCursor: 'tasks-loop' },
        records: { limit: 1, version: first.pagination.records.version },
        humanRequests: { limit: 1, version: first.pagination.humanRequests.version }
      }
    } : first)
    await renderReady({ ...base, getCoordination })
    await act(async () => { await current?.loadMore('tasks') })
    expect(current?.coordinationPagination.tasks.nextCursor).toBeNull()
    expect(current?.coordinationPagination.tasks.error).toMatch(/repeated pagination cursor/iu)
  })

  it('coalesces timer and wake bursts while a slow authoritative read is in flight', async () => {
    const flight = createSingleFlightLoader<number>()
    const resolvers: Array<(value: number) => void> = []
    let concurrent = 0
    let maximumConcurrent = 0
    let calls = 0
    const operation = async (): Promise<number> => {
      calls += 1
      concurrent += 1
      maximumConcurrent = Math.max(maximumConcurrent, concurrent)
      const value = await new Promise<number>((resolve) => resolvers.push(resolve))
      concurrent -= 1
      return value
    }
    const timer15s = flight.run(operation)
    const timer30s = flight.run(operation)
    const websocketWake = flight.run(operation)
    expect(calls).toBe(1)
    resolvers.shift()?.(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(2)
    resolvers.shift()?.(2)
    await expect(Promise.all([timer15s, timer30s, websocketWake])).resolves.toEqual([2, 2, 2])
    expect(maximumConcurrent).toBe(1)
    expect(calls).toBe(2)
  })

  it('backs hidden polling off to 60 seconds and refreshes immediately when visible again', async () => {
    expect(portalPollingIntervals(true)).toEqual({ worker: 60_000, project: 60_000 })
    expect(portalPollingIntervals(false)).toEqual({ worker: 15_000, project: 30_000 })
    const base = createDemoClient()
    const listWorkers = vi.fn(base.listWorkers)
    await renderReady({ ...base, listWorkers })
    const initialCalls = listWorkers.mock.calls.length
    vi.useFakeTimers()
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })
      expect(listWorkers).toHaveBeenCalledTimes(initialCalls)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(listWorkers).toHaveBeenCalledTimes(initialCalls + 1)

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await Promise.resolve()
      })
      expect(listWorkers).toHaveBeenCalledTimes(initialCalls + 2)
      await act(async () => root?.unmount())
      root = undefined
    } finally {
      if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
      vi.useRealTimers()
    }
  })

  it('extends the idle session only for throttled trusted browser activity', () => {
    const startedAt = Date.parse('2026-08-23T06:00:00.000Z')
    expect(shouldTouchPortalSession(false, false, startedAt, startedAt + 10 * 60_000)).toBe(false)
    expect(shouldTouchPortalSession(true, true, startedAt, startedAt + 10 * 60_000)).toBe(false)
    expect(shouldTouchPortalSession(true, false, startedAt, startedAt + 5 * 60_000 - 1)).toBe(false)
    expect(shouldTouchPortalSession(true, false, startedAt, startedAt + 5 * 60_000)).toBe(true)
  })
})
