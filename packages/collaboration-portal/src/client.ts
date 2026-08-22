import type {
  CancelTaskBody,
  CoordinationQuery,
  CoordinationView,
  CreateProjectBody,
  CreateTaskBody,
  OwnedAgentList,
  PortalClient,
  PortalWriteContext,
  Project,
  ProjectListQuery,
  ProjectPage,
  ProjectRecord,
  PortalSession,
  PortalSubscriptionError,
  PortalWakeEvent,
  RetryTaskBody,
  ReviewProjectRecordBody,
  Task,
  UpdateProjectMembersBody,
  WorkerDirectoryPage,
  WorkerDirectoryQuery
} from './types'

export class PortalApiError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean

  constructor(message: string, options: { code?: string; status?: number; retryable?: boolean } = {}) {
    super(message)
    this.name = 'PortalApiError'
    this.code = options.code ?? 'portal_request_failed'
    this.status = options.status ?? 500
    this.retryable = options.retryable ?? false
  }
}

interface PortalClientOptions {
  fetch?: typeof globalThis.fetch
  WebSocket?: typeof globalThis.WebSocket
  origin?: string
  random?: () => number
}

export function createPortalClient(options: PortalClientOptions = {}): PortalClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket
  const origin = (options.origin ?? globalThis.location?.origin ?? '').replace(/\/$/u, '')
  const random = options.random ?? Math.random

  const read = async <T>(path: string): Promise<T> => parseJson<T>(await fetchImpl(`${origin}${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' }
  }))

  const mutate = async <T>(method: 'POST' | 'PATCH', path: string, body: unknown, context: PortalWriteContext): Promise<T> => {
    if (!context.csrfToken || !context.idempotencyKey) throw new TypeError('Portal writes require CSRF and idempotency context.')
    let response: Response
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-sciforge-csrf': context.csrfToken,
          'idempotency-key': context.idempotencyKey
        },
        body: JSON.stringify(body)
      })
    } catch {
      throw new PortalApiError('Cloud connection was interrupted before the mutation response arrived.', {
        code: 'portal_transport_failed', status: 0, retryable: true
      })
    }
    return parseJson<T>(response)
  }

  return {
    async getSession(): Promise<PortalSession> {
      const response = await fetchImpl(`${origin}/portal/api/session`, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
      if (response.status === 401) return { authenticated: false }
      return parseJson<PortalSession>(response)
    },

    loginUrl(_returnTo = '/portal/'): string {
      return `${origin}/portal/auth/login`
    },

    async logout(csrfToken: string): Promise<void> {
      const response = await fetchImpl(`${origin}/portal/auth/logout`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-sciforge-csrf': csrfToken
        },
        body: '{}'
      })
      if (!response.ok && response.status !== 401) await parseJson(response)
    },

    listProjects(query: ProjectListQuery = {}): Promise<ProjectPage> {
      const params = pageParams(query, 50)
      for (const status of query.statuses ?? []) params.append('statuses', status)
      return read<ProjectPage>(withQuery('/portal/api/projects', params))
    },

    listWorkers(query: WorkerDirectoryQuery = {}): Promise<WorkerDirectoryPage> {
      return read<WorkerDirectoryPage>(withQuery('/portal/api/workers', pageParams(query, 50)))
    },

    listOwnedAgents(): Promise<OwnedAgentList> {
      return read<OwnedAgentList>('/portal/api/agents')
    },

    getCoordination(projectId: string, query: CoordinationQuery = {}): Promise<CoordinationView> {
      return read<CoordinationView>(withQuery(
        `/portal/api/projects/${pathId(projectId)}/coordination`,
        coordinationParams(query)
      ))
    },

    createProject(body: CreateProjectBody, context: PortalWriteContext): Promise<Project> {
      return mutate<Project>('POST', '/portal/api/projects', body, context)
    },

    updateProjectMembers(projectId: string, body: UpdateProjectMembersBody, context: PortalWriteContext): Promise<Project> {
      return mutate<Project>('PATCH', `/portal/api/projects/${pathId(projectId)}/members`, body, context)
    },

    createTask(projectId: string, body: CreateTaskBody, context: PortalWriteContext): Promise<Task> {
      return mutate<Task>('POST', `/portal/api/projects/${pathId(projectId)}/tasks`, body, context)
    },

    cancelTask(taskId: string, body: CancelTaskBody, context: PortalWriteContext): Promise<Task> {
      return mutate<Task>('POST', `/portal/api/tasks/${pathId(taskId)}/cancel`, body, context)
    },

    retryTask(taskId: string, body: RetryTaskBody, context: PortalWriteContext): Promise<Task> {
      return mutate<Task>('POST', `/portal/api/tasks/${pathId(taskId)}/retry`, body, context)
    },

    reviewProjectRecord(projectRecordId: string, body: ReviewProjectRecordBody, context: PortalWriteContext): Promise<ProjectRecord> {
      return mutate<ProjectRecord>('POST', `/portal/api/records/${pathId(projectRecordId)}/review`, body, context)
    },

    subscribe(projectId, onWake, onState, onAuthenticationRequired, onSubscriptionError): () => void {
      if (!WebSocketImpl) return () => undefined
      let stopped = false
      let socket: WebSocket | undefined
      let attempt = 0
      let timer: ReturnType<typeof setTimeout> | undefined

      const connect = (): void => {
        if (stopped) return
        const websocketOrigin = origin.replace(/^http/u, 'ws')
        socket = new WebSocketImpl(`${websocketOrigin}/portal/events`, 'sciforge.portal.v1')
        socket.addEventListener('open', () => {
          attempt = 0
          onState?.(true)
          socket?.send(JSON.stringify({ schemaVersion: 1, type: 'project.subscribe', projectId }))
        })
        socket.addEventListener('message', (event) => {
          try {
            const wake = JSON.parse(String(event.data)) as Partial<PortalWakeEvent> & { type?: unknown; code?: unknown }
            if (wake.type === 'subscription.error' &&
                (wake.code === 'permission_denied' || wake.code === 'subscription_limit')) {
              stopped = true
              onState?.(false)
              onSubscriptionError?.({ code: wake.code } as PortalSubscriptionError)
              socket?.close(1000, 'subscription rejected')
              return
            }
            if (wake.projectId === projectId && typeof wake.changeKind === 'string' && Number.isSafeInteger(wake.revision)) {
              onWake(wake as PortalWakeEvent)
            }
          } catch {
            // Wake frames never carry authoritative data; malformed metadata is safe to ignore.
          }
        })
        socket.addEventListener('close', (event) => {
          onState?.(false)
          if (stopped) return
          const close = event as CloseEvent
          if (close.code === 4401 || (close.code === 1008 && /(?:auth|session)/iu.test(close.reason))) {
            stopped = true
            onAuthenticationRequired?.()
            return
          }
          if (close.code === 1008) {
            stopped = true
            onSubscriptionError?.({ code: 'websocket_policy_rejected', message: close.reason || undefined })
            return
          }
          const delay = Math.min(30_000, 500 * 2 ** attempt) * (0.8 + random() * 0.4)
          attempt += 1
          timer = setTimeout(connect, delay)
        })
        socket.addEventListener('error', () => socket?.close())
      }

      connect()
      return () => {
        stopped = true
        if (timer) clearTimeout(timer)
        socket?.close(1000, 'project changed')
      }
    }
  }
}

function pageParams(query: { cursor?: string; limit?: number }, maximum: number): URLSearchParams {
  const params = new URLSearchParams()
  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > maximum) throw new TypeError(`Portal page limit must be between 1 and ${maximum}.`)
    params.set('limit', String(query.limit))
  }
  if (query.cursor !== undefined) {
    if (query.cursor.length < 1 || query.cursor.length > 2_048) throw new TypeError('Invalid page cursor.')
    params.set('cursor', query.cursor)
  }
  return params
}

function coordinationParams(query: CoordinationQuery): URLSearchParams {
  const params = new URLSearchParams()
  for (const [name, cursor] of [
    ['tasksCursor', query.tasksCursor],
    ['recordsCursor', query.recordsCursor],
    ['humanCursor', query.humanCursor]
  ] as const) {
    if (cursor !== undefined) {
      if (cursor.length < 1 || cursor.length > 2_048) throw new TypeError(`Invalid ${name}.`)
      params.set(name, cursor)
    }
  }
  for (const [name, limit, maximum] of [
    ['tasksLimit', query.tasksLimit, 100],
    ['recordsLimit', query.recordsLimit, 100],
    ['humanLimit', query.humanLimit, 50]
  ] as const) {
    if (limit !== undefined) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new TypeError(`${name} must be between 1 and ${maximum}.`)
      params.set(name, String(limit))
    }
  }
  return params
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

function pathId(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError('Portal resource ID is required.')
  return encodeURIComponent(normalized)
}

async function parseJson<T>(response: Response): Promise<T> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new PortalApiError('Cloud returned an invalid response.', { code: 'portal_invalid_response', status: response.status, retryable: true })
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; retryable?: boolean } }).error
    throw new PortalApiError(error?.message ?? `Cloud request failed (${response.status}).`, {
      code: error?.code,
      status: response.status,
      retryable: error?.retryable ?? response.status >= 500
    })
  }
  return payload as T
}
