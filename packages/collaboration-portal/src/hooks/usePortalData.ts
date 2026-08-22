import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PortalApiError } from '../client'
import { createPortalMutationRunner } from '../mutations'
import type {
  CoordinationPagination,
  CoordinationQuery,
  CoordinationView,
  HumanNeeded,
  OwnedAgent,
  OwnedAgentList,
  PortalClient,
  PortalCommand,
  PortalRoute,
  PortalSelection,
  PortalSession,
  PortalSubscriptionError,
  PortalWorker,
  Project,
  ProjectPage,
  ProjectRecord,
  ProjectSummary,
  Task,
  WorkerDirectoryPage,
  WorkerDirectoryStats
} from '../types'
import { canOpenCoordinationView } from '../permissions'

const emptyStats: WorkerDirectoryStats = { total: 0, online: 0, busy: 0, offline: 0, desktop: 0, server: 0 }
const INITIAL_COORDINATION_LIMITS = { tasksLimit: 100, recordsLimit: 100, humanLimit: 50 } as const
const MAX_COORDINATION_BYTES = 2 * 1024 * 1024
const SESSION_ACTIVITY_TOUCH_INTERVAL_MS = 5 * 60_000

export type CoordinationCollection = 'tasks' | 'records' | 'humanRequests'

export interface CoordinationCollectionState {
  nextCursor: string | null
  limit: number
  version: string
  pagesLoaded: number
  loading: boolean
  error: string | null
}

export interface CoordinationPaginationState {
  tasks: CoordinationCollectionState
  records: CoordinationCollectionState
  humanRequests: CoordinationCollectionState
  bytes: number
}

export interface DirectoryPaginationState {
  nextCursor: string | null
  pagesLoaded: number
  loading: boolean
  stale: boolean
  error: string | null
}

export interface SingleFlightLoader<T> {
  run(operation: () => Promise<T>): Promise<T>
}

export interface SerialLoader {
  run(operation: () => Promise<void>): Promise<void>
}

export interface PortalDataController {
  phase: 'loading' | 'unauthenticated' | 'ready' | 'error'
  fatalError: string | null
  actionError: string | null
  actionPending: boolean
  session: PortalSession | null
  projects: ProjectSummary[]
  projectPagination: DirectoryPaginationState
  workers: PortalWorker[]
  workerPagination: DirectoryPaginationState
  workerStats: WorkerDirectoryStats
  workersReadAt: string | null
  ownedAgents: OwnedAgent[]
  selectedProjectId: string | null
  view: CoordinationView | null
  coordinationPagination: CoordinationPaginationState
  route: PortalRoute
  selection: PortalSelection
  websocketConnected: boolean
  setRoute(route: PortalRoute): void
  setSelection(selection: PortalSelection): void
  selectProject(projectId: string): void
  retryInitial(): void
  refresh(): Promise<void>
  loadMore(collection: CoordinationCollection): Promise<void>
  loadMoreProjects(): Promise<void>
  loadMoreWorkers(): Promise<void>
  run(command: PortalCommand): Promise<unknown>
  logout(): Promise<void>
  clearActionError(): void
}

export function createSingleFlightLoader<T>(): SingleFlightLoader<T> {
  let inFlight: Promise<T> | null = null
  let dirty = false
  let latestOperation: (() => Promise<T>) | null = null

  return {
    run(operation) {
      latestOperation = operation
      if (inFlight) {
        dirty = true
        return inFlight
      }
      const drain = async (): Promise<T> => {
        let value: T | undefined
        let failure: unknown
        do {
          dirty = false
          const next = latestOperation
          if (!next) throw new Error('Single-flight loader lost its pending operation.')
          try {
            value = await next()
            failure = undefined
          } catch (error) {
            failure = error
          }
        } while (dirty)
        if (failure !== undefined) throw failure
        return value as T
      }
      inFlight = drain().finally(() => {
        inFlight = null
        dirty = false
      })
      return inFlight
    }
  }
}

export function createSerialLoader(): SerialLoader {
  let tail: Promise<void> = Promise.resolve()
  return {
    run(operation) {
      const result = tail.then(operation, operation)
      tail = result.catch(() => undefined)
      return result
    }
  }
}

export function usePortalData(client: PortalClient): PortalDataController {
  const [phase, setPhase] = useState<PortalDataController['phase']>('loading')
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState(false)
  const [session, setSession] = useState<PortalSession | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectPagination, setProjectPagination] = useState<DirectoryPaginationState>(emptyDirectoryPagination)
  const [workers, setWorkers] = useState<PortalWorker[]>([])
  const [workerPagination, setWorkerPagination] = useState<DirectoryPaginationState>(emptyDirectoryPagination)
  const [workerStats, setWorkerStats] = useState<WorkerDirectoryStats>(emptyStats)
  const [workersReadAt, setWorkersReadAt] = useState<string | null>(null)
  const [ownedAgents, setOwnedAgents] = useState<OwnedAgent[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [view, setView] = useState<CoordinationView | null>(null)
  const [coordinationPagination, setCoordinationPagination] = useState<CoordinationPaginationState>(emptyCoordinationPagination)
  const [route, setRoute] = useState<PortalRoute>('dashboard')
  const [selection, setSelection] = useState<PortalSelection>(null)
  const [websocketConnected, setWebsocketConnected] = useState(false)
  const mutationRunner = useMemo(() => createPortalMutationRunner(client), [client])
  const projectListFlight = useMemo(() => createSingleFlightLoader<ProjectSummary[]>(), [client])
  const workerDirectoryFlight = useMemo(() => createSingleFlightLoader<void>(), [client])
  const ownedAgentFlight = useMemo(() => createSingleFlightLoader<void>(), [client])
  const coordinationFlight = useMemo(() => createSingleFlightLoader<void>(), [client])
  const coordinationQueue = useMemo(createSerialLoader, [client])
  const selectedRef = useRef<string | null>(null)
  const generationRef = useRef(0)
  const viewRef = useRef<CoordinationView | null>(null)
  const coordinationPaginationRef = useRef<CoordinationPaginationState>(coordinationPagination)
  const seenCoordinationCursorsRef = useRef<Record<CoordinationCollection, Set<string>>>(emptySeenCursors())
  const projectPaginationRef = useRef(projectPagination)
  const workerPaginationRef = useRef(workerPagination)
  const seenProjectCursorsRef = useRef(new Set<string>())
  const seenWorkerCursorsRef = useRef(new Set<string>())
  const freshProjectIdsRef = useRef(new Set<string>())
  const freshWorkerIdsRef = useRef(new Set<string>())
  selectedRef.current = selectedProjectId
  viewRef.current = view
  coordinationPaginationRef.current = coordinationPagination
  projectPaginationRef.current = projectPagination
  workerPaginationRef.current = workerPagination

  const commitProjectPagination = useCallback((next: DirectoryPaginationState): void => {
    projectPaginationRef.current = next
    setProjectPagination(next)
  }, [])

  const commitWorkerPagination = useCallback((next: DirectoryPaginationState): void => {
    workerPaginationRef.current = next
    setWorkerPagination(next)
  }, [])

  const commitCoordinationPagination = useCallback((next: CoordinationPaginationState): void => {
    coordinationPaginationRef.current = next
    setCoordinationPagination(next)
  }, [])

  const clearSensitiveProjection = useCallback((): void => {
    generationRef.current += 1
    mutationRunner.clear()
    selectedRef.current = null
    setSession({ authenticated: false })
    setProjects([])
    seenProjectCursorsRef.current = new Set()
    freshProjectIdsRef.current = new Set()
    commitProjectPagination(emptyDirectoryPagination())
    setWorkers([])
    seenWorkerCursorsRef.current = new Set()
    freshWorkerIdsRef.current = new Set()
    commitWorkerPagination(emptyDirectoryPagination())
    setWorkerStats(emptyStats)
    setWorkersReadAt(null)
    setOwnedAgents([])
    setSelectedProjectId(null)
    viewRef.current = null
    setView(null)
    seenCoordinationCursorsRef.current = emptySeenCursors()
    commitCoordinationPagination(emptyCoordinationPagination())
    setSelection(null)
    setRoute('dashboard')
    setWebsocketConnected(false)
    setActionPending(false)
    setActionError(null)
    setFatalError(null)
    setPhase('unauthenticated')
  }, [commitCoordinationPagination, commitProjectPagination, commitWorkerPagination, mutationRunner])

  const handleAuthenticationRequired = useCallback((error?: unknown): boolean => {
    if (error !== undefined && !isPortalAuthenticationRequired(error)) return false
    clearSensitiveProjection()
    return true
  }, [clearSensitiveProjection])

  const fetchProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    const generation = generationRef.current
    const page: ProjectPage = await client.listProjects({ limit: 50 })
    assertDirectoryPage(page.items.length, page.nextCursor, 50, 'Project')
    if (generation === generationRef.current) {
      const preserveTail = projectPaginationRef.current.pagesLoaded > 1
      freshProjectIdsRef.current = new Set(page.items.map((project) => project.projectId))
      seenProjectCursorsRef.current = new Set()
      setProjects((current) => sortProjects(preserveTail
        ? mergeEntityPages(current, page.items, (project) => project.projectId)
        : page.items))
      commitProjectPagination({
        nextCursor: page.nextCursor ?? null,
        pagesLoaded: 1,
        loading: false,
        stale: preserveTail,
        error: null
      })
    }
    return page.items
  }, [client, commitProjectPagination])

  const loadProjects = useCallback((): Promise<ProjectSummary[]> => projectListFlight.run(fetchProjects), [fetchProjects, projectListFlight])

  const fetchWorkers = useCallback(async (): Promise<void> => {
    const generation = generationRef.current
    const page: WorkerDirectoryPage = await client.listWorkers({ limit: 50 })
    assertDirectoryPage(page.items.length, page.nextCursor, 50, 'Worker')
    if (generation === generationRef.current) {
      const preserveTail = workerPaginationRef.current.pagesLoaded > 1
      freshWorkerIdsRef.current = new Set(page.items.map((worker) => worker.agentId))
      seenWorkerCursorsRef.current = new Set()
      setWorkers((current) => preserveTail
        ? mergeEntityPages(current, page.items, (worker) => worker.agentId)
        : page.items)
      setWorkerStats(page.stats)
      setWorkersReadAt(page.readAt)
      commitWorkerPagination({
        nextCursor: page.nextCursor ?? null,
        pagesLoaded: 1,
        loading: false,
        stale: preserveTail,
        error: null
      })
    }
  }, [client, commitWorkerPagination])

  const loadWorkers = useCallback((): Promise<void> => workerDirectoryFlight.run(fetchWorkers), [fetchWorkers, workerDirectoryFlight])

  const loadMoreProjects = useCallback(async (): Promise<void> => {
    const current = projectPaginationRef.current
    const cursor = current.nextCursor
    if (!cursor || current.loading) return
    if (seenProjectCursorsRef.current.has(cursor)) {
      commitProjectPagination({ ...current, nextCursor: null, error: 'Cloud returned a repeated Project cursor. Loading stopped safely.' })
      return
    }
    const generation = generationRef.current
    commitProjectPagination({ ...current, loading: true, error: null })
    try {
      const page = await client.listProjects({ cursor, limit: 50 })
      if (generation !== generationRef.current) return
      assertDirectoryContinuation(cursor, page.items.length, page.nextCursor, 50, seenProjectCursorsRef.current, 'Project')
      seenProjectCursorsRef.current.add(cursor)
      for (const project of page.items) freshProjectIdsRef.current.add(project.projectId)
      const finished = !page.nextCursor
      setProjects((items) => {
        const merged = mergeEntityPages(items, page.items, (project) => project.projectId)
        return sortProjects(finished && current.stale
          ? merged.filter((project) => freshProjectIdsRef.current.has(project.projectId))
          : merged)
      })
      commitProjectPagination({
        nextCursor: page.nextCursor ?? null,
        pagesLoaded: current.pagesLoaded + 1,
        loading: false,
        stale: current.stale && !finished,
        error: null
      })
    } catch (error) {
      if (generation !== generationRef.current || handleAuthenticationRequired(error)) return
      const state = projectPaginationRef.current
      commitProjectPagination({
        ...state,
        loading: false,
        nextCursor: error instanceof DirectoryInvariantError ? null : state.nextCursor,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }, [client, commitProjectPagination, handleAuthenticationRequired])

  const loadMoreWorkers = useCallback(async (): Promise<void> => {
    const current = workerPaginationRef.current
    const cursor = current.nextCursor
    if (!cursor || current.loading) return
    if (seenWorkerCursorsRef.current.has(cursor)) {
      commitWorkerPagination({ ...current, nextCursor: null, error: 'Cloud returned a repeated Worker cursor. Loading stopped safely.' })
      return
    }
    const generation = generationRef.current
    commitWorkerPagination({ ...current, loading: true, error: null })
    try {
      const page = await client.listWorkers({ cursor, limit: 50 })
      if (generation !== generationRef.current) return
      assertDirectoryContinuation(cursor, page.items.length, page.nextCursor, 50, seenWorkerCursorsRef.current, 'Worker')
      seenWorkerCursorsRef.current.add(cursor)
      for (const worker of page.items) freshWorkerIdsRef.current.add(worker.agentId)
      const finished = !page.nextCursor
      setWorkers((items) => {
        const merged = mergeEntityPages(items, page.items, (worker) => worker.agentId)
        return finished && current.stale
          ? merged.filter((worker) => freshWorkerIdsRef.current.has(worker.agentId))
          : merged
      })
      commitWorkerPagination({
        nextCursor: page.nextCursor ?? null,
        pagesLoaded: current.pagesLoaded + 1,
        loading: false,
        stale: current.stale && !finished,
        error: null
      })
    } catch (error) {
      if (generation !== generationRef.current || handleAuthenticationRequired(error)) return
      const state = workerPaginationRef.current
      commitWorkerPagination({
        ...state,
        loading: false,
        nextCursor: error instanceof DirectoryInvariantError ? null : state.nextCursor,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }, [client, commitWorkerPagination, handleAuthenticationRequired])

  const fetchOwnedAgents = useCallback(async (): Promise<void> => {
    const generation = generationRef.current
    const list: OwnedAgentList = await client.listOwnedAgents()
    if (generation === generationRef.current) setOwnedAgents(list.items)
  }, [client])

  const loadOwnedAgents = useCallback((): Promise<void> => ownedAgentFlight.run(fetchOwnedAgents), [fetchOwnedAgents, ownedAgentFlight])

  const fetchView = useCallback(async (projectId: string): Promise<void> => {
    const generation = generationRef.current
    const firstPage = await client.getCoordination(projectId, INITIAL_COORDINATION_LIMITS)
    assertCoordinationPage(firstPage, projectId)
    if (generation !== generationRef.current || selectedRef.current !== projectId) return

    // A revision may insert an item anywhere in a cursor-ordered collection. Keeping
    // old continuation pages would make the client silently miss such an insertion,
    // so every authoritative reconcile restarts all three bounded collections.
    const bytes = coordinationBytes(firstPage)
    if (bytes > MAX_COORDINATION_BYTES) throw new CoordinationInvariantError('The Project view exceeds the 2 MiB Portal display budget.')
    viewRef.current = firstPage
    setView(firstPage)
    seenCoordinationCursorsRef.current = emptySeenCursors()
    commitCoordinationPagination(paginationFromFirstPage(firstPage, bytes))
  }, [client, commitCoordinationPagination])

  const loadView = useCallback((projectId: string, _preserveLoadedPages = false): Promise<void> => (
    coordinationFlight.run(() => coordinationQueue.run(() => fetchView(projectId)))
  ), [coordinationFlight, coordinationQueue, fetchView])

  const loadMore = useCallback(async (collection: CoordinationCollection): Promise<void> => {
    const projectId = selectedRef.current
    const baseView = viewRef.current
    const currentState = coordinationPaginationRef.current[collection]
    if (!projectId || !baseView || baseView.projectId !== projectId || currentState.loading || !currentState.nextCursor) return
    const maximumPages = coordinationMaximumPages(collection)
    if (currentState.pagesLoaded >= maximumPages) {
      commitCoordinationPagination(updateCollectionState(coordinationPaginationRef.current, collection, {
        ...currentState, nextCursor: null, error: `Portal ${collection} reached its ${maximumPages}-page display limit.`
      }))
      return
    }

    const cursor = currentState.nextCursor
    if (seenCoordinationCursorsRef.current[collection].has(cursor)) {
      commitCoordinationPagination(updateCollectionState(coordinationPaginationRef.current, collection, {
        ...currentState, nextCursor: null, error: 'Cloud returned a repeated pagination cursor. Loading stopped safely.'
      }))
      return
    }

    const generation = generationRef.current
    commitCoordinationPagination(updateCollectionState(coordinationPaginationRef.current, collection, {
      ...currentState, loading: true, error: null
    }))
    try {
      await coordinationQueue.run(async () => {
        if (generation !== generationRef.current || selectedRef.current !== projectId) return
        if (coordinationPaginationRef.current[collection].nextCursor !== cursor) return
        const page = await client.getCoordination(projectId, coordinationQueryFor(collection, cursor))
        if (generation !== generationRef.current || selectedRef.current !== projectId) return
        const mergeBase = viewRef.current
        if (!mergeBase || mergeBase.projectId !== projectId) return
        assertCoordinationContinuation(mergeBase, page, projectId)
        if (coordinationPage(page.pagination, collection).version !== coordinationPage(mergeBase.pagination, collection).version) {
          throw new CoordinationInvariantError(`Cloud ${collection} changed while loading a continuation page. Refresh before continuing.`, true)
        }
        const nextCursor = coordinationPage(page.pagination, collection).nextCursor
        if (nextCursor && (nextCursor === cursor || seenCoordinationCursorsRef.current[collection].has(nextCursor))) {
          throw new CoordinationInvariantError('Cloud returned a repeated pagination cursor. Loading stopped safely.')
        }
        const merged = mergeCoordinationCollection(mergeBase, page, collection)
        const bytes = coordinationBytes(merged)
        if (bytes > MAX_COORDINATION_BYTES) throw new CoordinationInvariantError('The Project view reached the 2 MiB Portal display budget.')
        seenCoordinationCursorsRef.current[collection].add(cursor)
        viewRef.current = merged
        setView(merged)
        const pagesLoaded = currentState.pagesLoaded + 1
        const reachedPageLimit = pagesLoaded >= maximumPages && Boolean(nextCursor)
        commitCoordinationPagination(updateCollectionState(coordinationPaginationRef.current, collection, {
          nextCursor: reachedPageLimit ? null : nextCursor ?? null,
          limit: coordinationPage(page.pagination, collection).limit,
          version: coordinationPage(page.pagination, collection).version,
          pagesLoaded,
          loading: false,
          error: reachedPageLimit ? `Portal ${collection} reached its ${maximumPages}-page display limit.` : null
        }, bytes))
      })
    } catch (error) {
      if (generation !== generationRef.current || selectedRef.current !== projectId) return
      if (handleAuthenticationRequired(error)) return
      const state = coordinationPaginationRef.current[collection]
      if (error instanceof CoordinationInvariantError && error.resetRequired) {
        viewRef.current = null
        setView(null)
        seenCoordinationCursorsRef.current = emptySeenCursors()
        commitCoordinationPagination(emptyCoordinationPagination())
        setSelection(null)
        setActionError(error.message)
        void loadView(projectId).catch((reloadError) => {
          if (!handleAuthenticationRequired(reloadError)) setActionError(reloadError instanceof Error ? reloadError.message : String(reloadError))
        })
        return
      }
      commitCoordinationPagination(updateCollectionState(coordinationPaginationRef.current, collection, {
        ...state,
        loading: false,
        nextCursor: error instanceof CoordinationInvariantError ? null : state.nextCursor,
        error: error instanceof Error ? error.message : String(error)
      }))
    }
  }, [client, commitCoordinationPagination, coordinationQueue, handleAuthenticationRequired, loadView])

  const initialize = useCallback(async (): Promise<void> => {
    setPhase('loading')
    setFatalError(null)
    try {
      const nextSession = await client.getSession()
      setSession(nextSession)
      if (!nextSession.authenticated) {
        clearSensitiveProjection()
        return
      }
      const [nextProjects] = await Promise.all([loadProjects(), loadWorkers(), loadOwnedAgents()])
      const requestedProject = new URLSearchParams(globalThis.location?.search ?? '').get('project')
      const initialProject = nextProjects.find((project) => project.projectId === requestedProject && canOpenCoordinationView(project))?.projectId ??
        nextProjects.find(canOpenCoordinationView)?.projectId ?? null
      setSelectedProjectId(initialProject)
      selectedRef.current = initialProject
      if (initialProject) await loadView(initialProject)
      setPhase('ready')
    } catch (error) {
      if (handleAuthenticationRequired(error)) return
      setFatalError(error instanceof Error ? error.message : String(error))
      setPhase('error')
    }
  }, [clearSensitiveProjection, client, handleAuthenticationRequired, loadOwnedAgents, loadProjects, loadView, loadWorkers])

  useEffect(() => { void initialize() }, [initialize])

  useEffect(() => {
    if (phase !== 'ready') return undefined
    let stopped = false
    let timerGeneration = 0
    let workerTimer: ReturnType<typeof setTimeout> | undefined
    let projectTimer: ReturnType<typeof setTimeout> | undefined
    const intervals = (): { worker: number; project: number } => portalPollingIntervals(globalThis.document?.visibilityState === 'hidden')
    const report = (error: unknown): void => {
      if (!handleAuthenticationRequired(error)) setActionError(error instanceof Error ? error.message : String(error))
    }
    const scheduleWorker = (generation: number): void => {
      if (stopped || generation !== timerGeneration) return
      workerTimer = setTimeout(() => {
        void loadWorkers().catch(report).finally(() => scheduleWorker(generation))
      }, intervals().worker)
    }
    const scheduleProject = (generation: number): void => {
      if (stopped || generation !== timerGeneration) return
      projectTimer = setTimeout(() => {
        const projectId = selectedRef.current
        const operation = projectId ? loadView(projectId, true) : Promise.resolve()
        void operation.catch(report).finally(() => scheduleProject(generation))
      }, intervals().project)
    }
    const restart = (refreshVisible: boolean): void => {
      timerGeneration += 1
      const generation = timerGeneration
      if (workerTimer) clearTimeout(workerTimer)
      if (projectTimer) clearTimeout(projectTimer)
      if (refreshVisible && globalThis.document?.visibilityState !== 'hidden') {
        const projectId = selectedRef.current
        void Promise.all([
          loadProjects(),
          loadWorkers(),
          projectId ? loadView(projectId, true) : Promise.resolve()
        ]).catch(report)
      }
      scheduleWorker(generation)
      scheduleProject(generation)
    }
    const onVisibility = (): void => restart(true)
    globalThis.document?.addEventListener('visibilitychange', onVisibility)
    restart(false)
    return () => {
      stopped = true
      if (workerTimer) clearTimeout(workerTimer)
      if (projectTimer) clearTimeout(projectTimer)
      globalThis.document?.removeEventListener('visibilitychange', onVisibility)
    }
  }, [handleAuthenticationRequired, loadProjects, loadView, loadWorkers, phase])

  useEffect(() => {
    if (phase !== 'ready') return undefined
    let stopped = false
    let inFlight = false
    let lastTouchAt = Date.now()
    const touch = (event: Event): void => {
      const current = Date.now()
      // Polling and WebSocket reconciliation remain passive. Only a trusted
      // browser input event may extend the 30-minute local idle deadline, and
      // even then at most once per five minutes.
      if (!shouldTouchPortalSession(event.isTrusted, inFlight, lastTouchAt, current)) return
      lastTouchAt = current
      inFlight = true
      void client.getSession().then((nextSession) => {
        if (stopped) return
        if (!nextSession.authenticated) {
          clearSensitiveProjection()
          return
        }
        setSession(nextSession)
      }).catch((error) => {
        if (!stopped && !handleAuthenticationRequired(error)) {
          setActionError(error instanceof Error ? error.message : String(error))
        }
      }).finally(() => { inFlight = false })
    }
    globalThis.document?.addEventListener('pointerdown', touch, { capture: true, passive: true })
    globalThis.document?.addEventListener('keydown', touch, { capture: true })
    return () => {
      stopped = true
      globalThis.document?.removeEventListener('pointerdown', touch, { capture: true })
      globalThis.document?.removeEventListener('keydown', touch, { capture: true })
    }
  }, [clearSensitiveProjection, client, handleAuthenticationRequired, phase])

  useEffect(() => {
    if (phase !== 'ready' || !selectedProjectId) {
      setWebsocketConnected(false)
      return undefined
    }
    return client.subscribe(selectedProjectId, () => {
      void loadView(selectedProjectId, true).catch((error) => { handleAuthenticationRequired(error) })
      void loadProjects().catch((error) => { handleAuthenticationRequired(error) })
    }, setWebsocketConnected, () => { handleAuthenticationRequired() }, (error) => {
      setWebsocketConnected(false)
      if (error.code === 'permission_denied') {
        // Membership can be revoked while an already-authorized projection is on
        // screen. Purge it immediately, then perform one bounded list reconcile.
        generationRef.current += 1
        selectedRef.current = null
        setSelectedProjectId(null)
        viewRef.current = null
        setView(null)
        seenCoordinationCursorsRef.current = emptySeenCursors()
        commitCoordinationPagination(emptyCoordinationPagination())
        setSelection(null)
        setRoute('dashboard')
        setActionError(subscriptionErrorMessage(error))
        void loadProjects().catch((loadError) => {
          if (!handleAuthenticationRequired(loadError)) setActionError(subscriptionErrorMessage(error))
        })
        return
      }
      setActionError(subscriptionErrorMessage(error))
    })
  }, [client, commitCoordinationPagination, handleAuthenticationRequired, loadProjects, loadView, phase, selectedProjectId])

  const selectProject = useCallback((projectId: string): void => {
    const selectedProject = projects.find((project) => project.projectId === projectId)
    if (!selectedProject || !canOpenCoordinationView(selectedProject)) {
      setActionError('This Project is listed for membership visibility, but its coordination view is Owner-only.')
      return
    }
    generationRef.current += 1
    setSelectedProjectId(projectId)
    selectedRef.current = projectId
    viewRef.current = null
    setView(null)
    seenCoordinationCursorsRef.current = emptySeenCursors()
    commitCoordinationPagination(emptyCoordinationPagination())
    setSelection(null)
    setRoute('project')
    const url = new URL(globalThis.location.href)
    url.searchParams.set('project', projectId)
    globalThis.history.replaceState(null, '', url)
    void loadView(projectId).catch((error) => {
      if (!handleAuthenticationRequired(error)) setActionError(error instanceof Error ? error.message : String(error))
    })
  }, [commitCoordinationPagination, handleAuthenticationRequired, loadView, projects])

  const refresh = useCallback(async (): Promise<void> => {
    setActionError(null)
    const projectId = selectedRef.current
    try {
      await Promise.all([loadProjects(), loadWorkers(), loadOwnedAgents(), projectId ? loadView(projectId, true) : Promise.resolve()])
    } catch (error) {
      if (!handleAuthenticationRequired(error)) setActionError(error instanceof Error ? error.message : String(error))
    }
  }, [handleAuthenticationRequired, loadOwnedAgents, loadProjects, loadView, loadWorkers])

  const run = useCallback(async (command: PortalCommand): Promise<unknown> => {
    if (!session?.authenticated || !session.csrfToken) throw new Error('Portal session is not ready for a write operation.')
    setActionPending(true)
    setActionError(null)
    let result: unknown
    try {
      result = await mutationRunner.run(command, session.csrfToken)
    } catch (error) {
      if (!handleAuthenticationRequired(error)) setActionError(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      setActionPending(false)
    }

    let projectId = selectedRef.current
    if (command.type === 'project.create' && isProject(result)) {
      projectId = result.projectId
      generationRef.current += 1
      selectedRef.current = projectId
      setSelectedProjectId(projectId)
      setRoute('project')
      setSelection(null)
      viewRef.current = null
      setView(null)
      seenCoordinationCursorsRef.current = emptySeenCursors()
      commitCoordinationPagination(emptyCoordinationPagination())
      setProjects((current) => upsertProjectSummary(current, result))
    } else {
      const merged = mergeMutationResult(viewRef.current, command, result)
      viewRef.current = merged
      setView(merged)
      if (isProject(result)) setProjects((current) => upsertProjectSummary(current, result))
    }

    const reconcileProjectId = projectId
    void Promise.all([
      loadProjects(),
      loadWorkers(),
      reconcileProjectId ? loadView(reconcileProjectId, true) : Promise.resolve()
    ]).catch((error) => {
      if (!handleAuthenticationRequired(error)) {
        setActionError(`Change committed. Live data refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return result
  }, [commitCoordinationPagination, handleAuthenticationRequired, loadProjects, loadView, loadWorkers, mutationRunner, session])

  const logout = useCallback(async (): Promise<void> => {
    try {
      if (session?.csrfToken) await client.logout(session.csrfToken)
    } catch {
      // A dropped logout response may still mean the server invalidated the
      // session. Local projections must be purged either way.
    } finally {
      clearSensitiveProjection()
    }
  }, [clearSensitiveProjection, client, session])

  return {
    phase, fatalError, actionError, actionPending, session, projects, projectPagination, workers, workerPagination, workerStats, workersReadAt,
    ownedAgents, selectedProjectId, view, coordinationPagination, route, selection, websocketConnected,
    setRoute, setSelection, selectProject, retryInitial: () => { void initialize() }, refresh, loadMore, loadMoreProjects, loadMoreWorkers, run, logout,
    clearActionError: () => setActionError(null)
  }
}

export function isPortalAuthenticationRequired(error: unknown): boolean {
  return error instanceof PortalApiError && (error.status === 401 || error.code === 'portal_authentication_required')
}

export function portalPollingIntervals(hidden: boolean): { worker: number; project: number } {
  return hidden ? { worker: 60_000, project: 60_000 } : { worker: 15_000, project: 30_000 }
}

export function shouldTouchPortalSession(
  trustedInput: boolean,
  inFlight: boolean,
  lastTouchAt: number,
  current: number
): boolean {
  return trustedInput && !inFlight && Number.isFinite(lastTouchAt) && Number.isFinite(current) &&
    current - lastTouchAt >= SESSION_ACTIVITY_TOUCH_INTERVAL_MS
}

class CoordinationInvariantError extends Error {
  constructor(message: string, readonly resetRequired = false) {
    super(message)
    this.name = 'CoordinationInvariantError'
  }
}

class DirectoryInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectoryInvariantError'
  }
}

function emptyDirectoryPagination(): DirectoryPaginationState {
  return { nextCursor: null, pagesLoaded: 0, loading: false, stale: false, error: null }
}

function assertDirectoryPage(itemCount: number, nextCursor: string | undefined, limit: number, label: string): void {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0 || itemCount > limit) {
    throw new DirectoryInvariantError(`Cloud returned an invalid ${label} page bound.`)
  }
  if (nextCursor !== undefined && (nextCursor.length < 1 || nextCursor.length > 2_048)) {
    throw new DirectoryInvariantError(`Cloud returned an invalid ${label} cursor.`)
  }
}

function assertDirectoryContinuation(
  requestedCursor: string,
  itemCount: number,
  nextCursor: string | undefined,
  limit: number,
  seen: ReadonlySet<string>,
  label: string
): void {
  assertDirectoryPage(itemCount, nextCursor, limit, label)
  if (nextCursor && (nextCursor === requestedCursor || seen.has(nextCursor))) {
    throw new DirectoryInvariantError(`Cloud returned a repeated ${label} cursor. Loading stopped safely.`)
  }
}

function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function subscriptionErrorMessage(error: PortalSubscriptionError): string {
  if (error.code === 'permission_denied') return 'Project access changed. The prior coordination projection was cleared and the Project list was reconciled.'
  if (error.code === 'subscription_limit') return 'Cloud rejected the live subscription limit. Timed reconciliation remains available.'
  return `Cloud stopped this live subscription${error.message ? `: ${error.message}` : '.'}`
}

function emptyCoordinationPagination(): CoordinationPaginationState {
  return {
    tasks: { nextCursor: null, limit: 100, version: '', pagesLoaded: 0, loading: false, error: null },
    records: { nextCursor: null, limit: 100, version: '', pagesLoaded: 0, loading: false, error: null },
    humanRequests: { nextCursor: null, limit: 50, version: '', pagesLoaded: 0, loading: false, error: null },
    bytes: 0
  }
}

function emptySeenCursors(): Record<CoordinationCollection, Set<string>> {
  return { tasks: new Set(), records: new Set(), humanRequests: new Set() }
}

function pageState(page: { limit: number; version: string; nextCursor?: string }): CoordinationCollectionState {
  return { nextCursor: page.nextCursor ?? null, limit: page.limit, version: page.version, pagesLoaded: 1, loading: false, error: null }
}

function paginationFromFirstPage(view: CoordinationView, bytes: number): CoordinationPaginationState {
  return {
    tasks: pageState(view.pagination.tasks),
    records: pageState(view.pagination.records),
    humanRequests: pageState(view.pagination.humanRequests),
    bytes
  }
}

function coordinationMaximumPages(collection: CoordinationCollection): number {
  if (collection === 'tasks') return 100
  if (collection === 'records') return 500
  return 200
}

function coordinationQueryFor(collection: CoordinationCollection, cursor: string): CoordinationQuery {
  if (collection === 'tasks') return { tasksCursor: cursor, tasksLimit: 100, recordsLimit: 1, humanLimit: 1 }
  if (collection === 'records') return { recordsCursor: cursor, tasksLimit: 1, recordsLimit: 100, humanLimit: 1 }
  return { humanCursor: cursor, tasksLimit: 1, recordsLimit: 1, humanLimit: 50 }
}

function coordinationPage(pagination: CoordinationPagination, collection: CoordinationCollection): { limit: number; version: string; nextCursor?: string } {
  return pagination[collection]
}

function updateCollectionState(
  current: CoordinationPaginationState,
  collection: CoordinationCollection,
  next: CoordinationCollectionState,
  bytes = current.bytes
): CoordinationPaginationState {
  return { ...current, [collection]: next, bytes }
}

function assertCoordinationPage(view: CoordinationView, projectId: string): void {
  if (view.projectId !== projectId || view.project.projectId !== projectId || view.projectRevision !== view.project.revision) {
    throw new CoordinationInvariantError('Cloud returned a mismatched Project coordination page.')
  }
  if ('humanAnswers' in view) throw new CoordinationInvariantError('Cloud returned a forbidden HumanAnswer projection.')
  const collections: Array<[CoordinationCollection, unknown[], number]> = [
    ['tasks', view.tasks, 100],
    ['records', view.records, 100],
    ['humanRequests', view.humanRequests, 50]
  ]
  for (const [collection, items, maximum] of collections) {
    const page = coordinationPage(view.pagination, collection)
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > maximum || items.length > page.limit ||
        typeof page.version !== 'string' || page.version.length < 1 || page.version.length > 256) {
      throw new CoordinationInvariantError(`Cloud returned an invalid ${collection} page bound.`)
    }
    if (page.nextCursor !== undefined && (page.nextCursor.length < 1 || page.nextCursor.length > 2_048)) {
      throw new CoordinationInvariantError(`Cloud returned an invalid ${collection} cursor.`)
    }
  }
}

function assertCoordinationContinuation(base: CoordinationView, page: CoordinationView, projectId: string): void {
  assertCoordinationPage(page, projectId)
  if (page.projectRevision !== base.projectRevision || page.project.revision !== base.project.revision ||
      memberSignature(page) !== memberSignature(base)) {
    throw new CoordinationInvariantError('Project revision changed while loading a continuation page. Refresh before continuing.', true)
  }
}

function memberSignature(view: CoordinationView): string {
  return view.members.map((member) => `${member.userId}:${member.role}:${member.active ? '1' : '0'}`).sort().join('|')
}

function mergeCoordinationCollection(base: CoordinationView, page: CoordinationView, collection: CoordinationCollection): CoordinationView {
  if (collection === 'tasks') {
    return { ...base, tasks: mergeEntityPages(base.tasks, page.tasks, (task) => task.taskId), readAt: page.readAt }
  }
  if (collection === 'records') {
    return { ...base, records: mergeEntityPages(base.records, page.records, (record) => record.projectRecordId), readAt: page.readAt }
  }
  return {
    ...base,
    humanRequests: mergeEntityPages<HumanNeeded>(base.humanRequests, page.humanRequests, (request) => request.humanRequestId),
    readAt: page.readAt
  }
}

function mergeEntityPages<T>(current: T[], incoming: T[], key: (item: T) => string): T[] {
  const byId = new Map(current.map((item) => [key(item), item]))
  for (const item of incoming) byId.set(key(item), item)
  return [...byId.values()].sort((left, right) => key(left).localeCompare(key(right)))
}

function coordinationBytes(view: CoordinationView): number {
  return new TextEncoder().encode(JSON.stringify(view)).byteLength
}

function mergeMutationResult(current: CoordinationView | null, command: PortalCommand, result: unknown): CoordinationView | null {
  if (!current) return current
  if (command.type === 'project.members.update' && isProject(result) && result.projectId === current.projectId) {
    const byUser = new Map(current.members.map((member) => [member.userId, member]))
    return {
      ...current,
      project: result,
      projectRevision: result.revision,
      members: result.memberUserIds.map((userId) => byUser.get(userId) ?? {
        userId,
        displayName: userId,
        role: userId === result.ownerUserId ? 'owner' : 'member',
        active: true
      })
    }
  }
  if (['task.create', 'task.transition', 'task.retry'].includes(command.type) && isTask(result) && result.projectId === current.projectId) {
    return { ...current, tasks: upsertBy(current.tasks, result, (task) => task.taskId) }
  }
  if (command.type === 'project_record.accept' && isProjectRecord(result) && result.projectId === current.projectId) {
    return { ...current, records: upsertBy(current.records, result, (record) => record.projectRecordId) }
  }
  return current
}

function upsertProjectSummary(current: ProjectSummary[], project: Project): ProjectSummary[] {
  const prior = current.find((item) => item.projectId === project.projectId)
  const summary: ProjectSummary = {
    projectId: project.projectId,
    displayName: project.displayName,
    goal: project.goal,
    status: project.status,
    role: 'owner',
    memberCount: project.memberUserIds.length,
    taskCounts: prior?.taskCounts ?? { offered: 0, accepted: 0, rejected: 0, running: 0, needsHuman: 0, succeeded: 0, failed: 0, cancelled: 0 },
    pendingResultCount: prior?.pendingResultCount ?? 0,
    revision: project.revision,
    updatedAt: project.updatedAt
  }
  return upsertBy(current, summary, (item) => item.projectId).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function upsertBy<T>(current: T[], next: T, key: (item: T) => string): T[] {
  const index = current.findIndex((item) => key(item) === key(next))
  if (index < 0) return [...current, next]
  return current.map((item, itemIndex) => itemIndex === index ? next : item)
}

function isProject(value: unknown): value is Project {
  return Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'project' && typeof (value as { projectId?: unknown }).projectId === 'string')
}

function isTask(value: unknown): value is Task {
  return Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'task' && typeof (value as { taskId?: unknown }).taskId === 'string')
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  return Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'project_record' && typeof (value as { projectRecordId?: unknown }).projectRecordId === 'string')
}
