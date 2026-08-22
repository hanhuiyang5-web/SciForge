import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'

import {
  createCollaborationError,
  idempotencyKeySchema,
  requestIdSchema,
  restRequestSchema,
  restResponseSchema,
  type RestRequest,
  type RestResponse
} from '@sciforge/collaboration-contracts'
import { z, ZodError } from 'zod'

import type { UserActor } from './auth.js'
import { CollaborationServiceError } from './errors.js'
import type { PortalAssetStore } from './portal-assets.js'
import { PortalSessionError, type PortalSessionManager } from './portal-session.js'

const PORTAL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; manifest-src 'none'"
const MAX_BODY_BYTES = 64 * 1024
const MAX_PORTAL_ENTITY_BYTES = 2 * 1024 * 1024
const MAX_PORTAL_COLLECTION_ITEM_BYTES = 128 * 1024
const MAX_PORTAL_CURSOR_CHARACTERS = 2_051
const PORTAL_PACK_CURSOR_RESERVE = '\u0001'.repeat(MAX_PORTAL_CURSOR_CHARACTERS)
const MAX_PORTAL_PACK_FINAL_RECHECKS = 3

const projectCreateBodySchema = z.object({
  displayName: z.unknown(),
  goal: z.unknown(),
  memberUserIds: z.array(z.unknown()),
  coordinatorAgentId: z.unknown(),
  budget: z.unknown()
}).strict()
const projectMembersBodySchema = z.object({
  expectedRevision: z.unknown(),
  addMemberUserIds: z.array(z.unknown()),
  removeMemberUserIds: z.array(z.unknown())
}).strict()
const taskCreateBodySchema = z.object({
  expectedRevision: z.unknown(),
  assigneeAgentId: z.unknown(),
  title: z.unknown(),
  objective: z.unknown(),
  completionCriteria: z.array(z.unknown()),
  dependencyTaskIds: z.array(z.unknown()),
  capabilityIds: z.array(z.unknown())
}).strict()
const taskCancelBodySchema = z.object({ executionId: z.unknown(), expectedRevision: z.unknown() }).strict()
const taskRetryBodySchema = z.object({
  executionId: z.unknown(),
  assigneeAgentId: z.unknown(),
  expectedRevision: z.unknown()
}).strict()
const recordReviewBodySchema = z.object({ expectedRevision: z.unknown(), decision: z.unknown() }).strict()

export type PortalHttpHandler = Readonly<{
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>
}>

export type PortalPackSerializationProbe = (event: Readonly<{
  phase: 'header' | 'item' | 'final'
  value: unknown
}>) => void

export type CollaborationPortalOptions = Readonly<{
  assets: PortalAssetStore
  sessions: PortalSessionManager
  dispatch: (command: RestRequest, actor: UserActor) => Promise<RestResponse>
  readCoordination: (actor: UserActor, projectId: string, input: Readonly<{
    tasksCursor?: string
    recordsCursor?: string
    humanCursor?: string
    tasksLimit: number
    recordsLimit: number
    humanLimit: number
  }>) => Promise<unknown>
  userSnapshot: (actor: UserActor) => Promise<Readonly<{ userId: string; displayName: string }>>
  packSerializationProbe?: PortalPackSerializationProbe
}>

export class CollaborationPortal implements PortalHttpHandler {
  constructor(private readonly options: CollaborationPortalOptions) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/portal' && !url.pathname.startsWith('/portal/')) return false
    try {
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/portal') {
        redirect(response, '/portal/', 308)
        return true
      }
      if (request.method === 'GET' && url.pathname === '/portal/auth/login') {
        const login = await this.options.sessions.beginLogin(portalClientSource(request))
        response.writeHead(302, secureHeaders({ location: login.location, 'set-cookie': login.setCookie }))
        response.end()
        return true
      }
      if (request.method === 'GET' && url.pathname === '/portal/auth/callback') {
        const completed = await this.options.sessions.completeLogin(url.searchParams, firstHeader(request.headers.cookie))
        response.writeHead(303, secureHeaders({ location: '/portal/', 'set-cookie': [...completed.setCookies] }))
        response.end()
        return true
      }
      if (request.method === 'POST' && url.pathname === '/portal/auth/logout') {
        const cookies = await this.options.sessions.logout(request.headers)
        response.writeHead(204, secureHeaders({ 'set-cookie': [...cookies] }))
        response.end()
        return true
      }
      if (request.method === 'GET' && url.pathname === '/portal/api/session') {
        requireSameOriginFetch(request)
        const session = await this.options.sessions.authenticate(firstHeader(request.headers.cookie))
        const user = await this.options.userSnapshot(session.actor)
        sendJson(response, 200, {
          schemaVersion: 1,
          type: 'portal.session',
          authenticated: true,
          user,
          csrfToken: session.csrfToken,
          idleExpiresAt: session.idleExpiresAt,
          absoluteExpiresAt: session.absoluteExpiresAt
        })
        return true
      }
      if (url.pathname === '/portal/api/commands') {
        // The Portal is deliberately not a generic command relay. Keeping this tombstone
        // explicit prevents an old frontend from silently regaining the broad A surface.
        sendJson(response, 404, { schemaVersion: 1, type: 'portal.not_found' })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/portal/api/projects') {
        requireSameOriginFetch(request)
        exactQuery(url, ['cursor', 'limit', 'statuses'])
        const session = await this.options.sessions.authenticatePassive(firstHeader(request.headers.cookie))
        const statuses = url.searchParams.getAll('statuses')
        const command = portalReadRequest('project.list', {
          limit: queryInteger(url, 'limit', 50, 1, 50),
          ...(singleQuery(url, 'cursor') ? { cursor: singleQuery(url, 'cursor') } : {}),
          ...(statuses.length > 0 ? { statuses } : {})
        })
        await this.dispatchEntity(response, command, session.actor)
        return true
      }
      if (request.method === 'GET' && url.pathname === '/portal/api/workers') {
        requireSameOriginFetch(request)
        exactQuery(url, ['cursor', 'limit'])
        const session = await this.options.sessions.authenticatePassive(firstHeader(request.headers.cookie))
        const command = portalReadRequest('worker.directory.page', {
          limit: queryInteger(url, 'limit', 50, 1, 50),
          ...(singleQuery(url, 'cursor') ? { cursor: singleQuery(url, 'cursor') } : {})
        })
        await this.dispatchEntity(response, command, session.actor)
        return true
      }
      if (request.method === 'GET' && url.pathname === '/portal/api/agents') {
        requireSameOriginFetch(request)
        exactQuery(url, [])
        const session = await this.options.sessions.authenticatePassive(firstHeader(request.headers.cookie))
        await this.dispatchEntity(response, portalReadRequest('agent.owned.list', {}), session.actor)
        return true
      }
      const coordination = exactPath(url.pathname, /^\/portal\/api\/projects\/([A-Za-z0-9_-]+)\/coordination$/u)
      if (request.method === 'GET' && coordination) {
        requireSameOriginFetch(request)
        exactQuery(url, [
          'tasksCursor', 'recordsCursor', 'humanCursor',
          'tasksLimit', 'recordsLimit', 'humanLimit'
        ])
        const session = await this.options.sessions.authenticatePassive(firstHeader(request.headers.cookie))
        const entity = await this.options.readCoordination(session.actor, coordination[1]!, {
          ...(singleQuery(url, 'tasksCursor') ? { tasksCursor: singleQuery(url, 'tasksCursor') } : {}),
          ...(singleQuery(url, 'recordsCursor') ? { recordsCursor: singleQuery(url, 'recordsCursor') } : {}),
          ...(singleQuery(url, 'humanCursor') ? { humanCursor: singleQuery(url, 'humanCursor') } : {}),
          tasksLimit: queryInteger(url, 'tasksLimit', 50, 1, 100),
          recordsLimit: queryInteger(url, 'recordsLimit', 50, 1, 100),
          humanLimit: queryInteger(url, 'humanLimit', 25, 1, 50)
        })
        this.sendEntity(response, portalSafeCoordinationEntity(entity, session.actor, this.options.packSerializationProbe))
        return true
      }
      if (request.method === 'POST' && url.pathname === '/portal/api/projects') {
        const session = await this.authenticateMutation(request)
        const body = projectCreateBodySchema.parse(await readJson(request, MAX_BODY_BYTES))
        const members = [...new Set([session.actor.userId, ...(body.memberUserIds as string[])])]
        await this.dispatchEntity(response, portalWriteRequest(request, 'project.create', {
          ownerUserId: session.actor.userId,
          displayName: body.displayName,
          goal: body.goal,
          memberUserIds: members.sort(),
          coordinatorAgentId: body.coordinatorAgentId,
          budget: body.budget
        }, session.actor.actorKey), session.actor)
        return true
      }
      const members = exactPath(url.pathname, /^\/portal\/api\/projects\/([A-Za-z0-9_-]+)\/members$/u)
      if (request.method === 'PATCH' && members) {
        const session = await this.authenticateMutation(request)
        const body = projectMembersBodySchema.parse(await readJson(request, MAX_BODY_BYTES))
        await this.dispatchEntity(response, portalWriteRequest(request, 'project.members.update', {
          projectId: members[1],
          ...body
        }), session.actor)
        return true
      }
      const projectTasks = exactPath(url.pathname, /^\/portal\/api\/projects\/([A-Za-z0-9_-]+)\/tasks$/u)
      if (request.method === 'POST' && projectTasks) {
        const session = await this.authenticateMutation(request)
        const body = taskCreateBodySchema.parse(await readJson(request, MAX_BODY_BYTES))
        await this.dispatchEntity(response, portalWriteRequest(request, 'task.create', {
          projectId: projectTasks[1],
          assigneeAgentId: body.assigneeAgentId,
          title: body.title,
          objective: body.objective,
          completionCriteria: body.completionCriteria,
          dependencyTaskIds: body.dependencyTaskIds,
          requiredCapabilities: {
            capabilityIds: body.capabilityIds,
            vpnAccessIds: [],
            slurmClusterIds: [],
            requiredResourceRefIds: []
          },
          resourceRefIds: [],
          authorizationRequirements: [],
          expectedRevision: body.expectedRevision
        }), session.actor)
        return true
      }
      const cancelTask = exactPath(url.pathname, /^\/portal\/api\/tasks\/([A-Za-z0-9_-]+)\/cancel$/u)
      if (request.method === 'POST' && cancelTask) {
        const session = await this.authenticateMutation(request)
        const body = taskCancelBodySchema.parse(await readJson(request, MAX_BODY_BYTES))
        await this.dispatchEntity(response, portalWriteRequest(request, 'task.transition', {
          taskId: cancelTask[1], executionId: body.executionId, expectedRevision: body.expectedRevision,
          status: 'cancelled'
        }), session.actor)
        return true
      }
      const retryTask = exactPath(url.pathname, /^\/portal\/api\/tasks\/([A-Za-z0-9_-]+)\/retry$/u)
      if (request.method === 'POST' && retryTask) {
        const session = await this.authenticateMutation(request)
        const body = taskRetryBodySchema.parse(await readJson(request, MAX_BODY_BYTES))
        await this.dispatchEntity(response, portalWriteRequest(request, 'task.retry', {
          taskId: retryTask[1], ...body
        }), session.actor)
        return true
      }
      const reviewRecord = exactPath(url.pathname, /^\/portal\/api\/records\/([A-Za-z0-9_-]+)\/review$/u)
      if (request.method === 'POST' && reviewRecord) {
        const session = await this.authenticateMutation(request)
        const body = recordReviewBodySchema.parse(await readJson(request, MAX_BODY_BYTES))
        await this.dispatchEntity(response, portalWriteRequest(request, 'project_record.accept', {
          projectRecordId: reviewRecord[1], ...body
        }), session.actor)
        return true
      }
      if (url.pathname === '/portal/events') {
        sendJson(response, 426, { schemaVersion: 1, type: 'portal.websocket_required' }, {
          upgrade: 'websocket'
        })
        return true
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const asset = this.options.assets.get(url.pathname)
        if (asset) {
          if (firstHeader(request.headers['if-none-match']) === asset.etag) {
            response.writeHead(304, portalAssetHeaders(asset.cacheControl, asset.etag))
            response.end()
            return true
          }
          response.writeHead(200, portalAssetHeaders(asset.cacheControl, asset.etag, {
            'content-type': asset.contentType,
            'content-length': String(asset.body.byteLength)
          }))
          response.end(request.method === 'HEAD' ? undefined : asset.body)
          return true
        }
      }
      sendJson(response, 404, { schemaVersion: 1, type: 'portal.not_found' })
      return true
    } catch (error) {
      sendPortalFailure(response, error)
      return true
    }
  }

  private async authenticateMutation(request: IncomingMessage) {
    requireJson(request)
    return this.options.sessions.authenticateWrite(request.headers)
  }

  private async dispatchEntity(response: ServerResponse, command: RestRequest, actor: UserActor): Promise<void> {
    const dispatched = restResponseSchema.parse(await this.options.dispatch(command, actor))
    if (dispatched.type !== 'rest.entity') {
      throw new CollaborationServiceError('internal_error', 'The Portal received an unexpected canonical response.')
    }
    const safeEntity = portalSafeEntity(command, dispatched.entity, actor, this.options.packSerializationProbe)
    this.sendEntity(response, safeEntity)
  }

  private sendEntity(response: ServerResponse, entity: unknown): void {
    if (Buffer.byteLength(JSON.stringify(entity), 'utf8') > MAX_PORTAL_ENTITY_BYTES) {
      throw new CollaborationServiceError('payload_too_large', 'The Portal view exceeds its bounded response limit.')
    }
    sendJson(response, 200, entity)
  }
}

function portalSafeEntity(
  command: RestRequest,
  entity: unknown,
  actor: UserActor,
  probe?: PortalPackSerializationProbe
): unknown {
  if (command.type === 'project.list') return portalPackProjectListPage(entity, probe)
  if (command.type === 'worker.directory.page') return portalPackWorkerDirectoryPage(entity, probe)
  if (command.type === 'project.coordination_view.get') return portalSafeCoordinationEntity(entity, actor, probe)
  return entity
}

function portalPackProjectListPage(entity: unknown, probe?: PortalPackSerializationProbe): Record<string, unknown> {
  return portalPackListPage(entity, 'project_list_page', (last) => {
    const projectId = typeof last.projectId === 'string' ? last.projectId : undefined
    const updatedAt = typeof last.updatedAt === 'string' ? last.updatedAt : undefined
    if (!projectId || !updatedAt) {
      throw new CollaborationServiceError('internal_error', 'The Portal Project page cursor source was malformed.')
    }
    return portalPageCursor('projects', `${updatedAt}\u001f${projectId}`)
  }, probe)
}

function portalPackWorkerDirectoryPage(
  entity: unknown,
  probe?: PortalPackSerializationProbe
): Record<string, unknown> {
  return portalPackListPage(entity, 'worker_directory_page', (last) => {
    const agentId = typeof last.agentId === 'string' ? last.agentId : undefined
    if (!agentId) {
      throw new CollaborationServiceError('internal_error', 'The Portal Worker page cursor source was malformed.')
    }
    return portalPageCursor('workers', agentId)
  }, probe)
}

function portalPackListPage(
  entity: unknown,
  expectedType: 'project_list_page' | 'worker_directory_page',
  cursorFor: (last: Record<string, unknown>) => string,
  probe?: PortalPackSerializationProbe
): Record<string, unknown> {
  if (!isRecord(entity) || entity.type !== expectedType || !Array.isArray(entity.items) ||
      entity.items.some((item) => !isRecord(item))) {
    throw new CollaborationServiceError('internal_error', 'The Portal list page was malformed.')
  }
  const items = entity.items as Record<string, unknown>[]
  const selected: Record<string, unknown>[] = []
  const build = (): Record<string, unknown> => {
    const page: Record<string, unknown> = { ...entity, items: [...selected] }
    const omittedFromFetchedPage = selected.length < items.length
    const nextCursor = omittedFromFetchedPage
      ? (selected.length > 0 ? cursorFor(selected[selected.length - 1]!) : undefined)
      : typeof entity.nextCursor === 'string' ? entity.nextCursor : undefined
    if (nextCursor) page.nextCursor = portalPackCursor(nextCursor)
    else delete page.nextCursor
    return page
  }
  const header = { ...entity, items: [], nextCursor: PORTAL_PACK_CURSOR_RESERVE }
  let estimatedBytes = portalPackJsonBytes(header, 'header', probe)
  if (estimatedBytes > MAX_PORTAL_ENTITY_BYTES) {
    throw new CollaborationServiceError('payload_too_large', 'The Portal list header exceeds its bounded view limit.')
  }
  const itemBytes = items.map((item) => portalPackJsonBytes(item, 'item', probe))
  for (const [index, item] of items.entries()) {
    const additionalBytes = itemBytes[index]! + (selected.length > 0 ? 1 : 0)
    if (estimatedBytes + additionalBytes > MAX_PORTAL_ENTITY_BYTES) break
    selected.push(item)
    estimatedBytes += additionalBytes
  }
  return portalFinalizePackedPage(
    build,
    () => selected.pop(),
    () => items.length > 0 && selected.length === 0,
    'A Portal list item exceeds its safe response limit.',
    probe
  )
}

function portalSafeCoordinationEntity(
  entity: unknown,
  actor: UserActor,
  probe?: PortalPackSerializationProbe
): unknown {
  if (!isRecord(entity) || entity.type !== 'project_coordination_view' || !Array.isArray(entity.humanRequests) ||
      !Array.isArray(entity.tasks) || !Array.isArray(entity.records)) {
    throw new CollaborationServiceError('internal_error', 'The Portal coordination projection was malformed.')
  }
  const humanRequests = entity.humanRequests
    .filter((request): request is Record<string, unknown> => isRecord(request) && request.targetUserId === actor.userId)
    .map((request) => ({
      schemaVersion: request.schemaVersion,
      type: request.type,
      humanRequestId: request.humanRequestId,
      projectId: request.projectId,
      sourceKind: request.sourceKind,
      taskId: request.taskId,
      executionId: request.executionId,
      targetUserId: request.targetUserId,
      requiredAssurance: request.requiredAssurance,
      status: request.status,
      expiresAt: request.expiresAt,
      revision: request.revision,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt
    }))
  const safe = { ...entity }
  delete safe.humanAnswers
  const sanitized = {
    ...safe,
    tasks: entity.tasks.map(portalBoundedTaskProjection),
    records: entity.records.map(portalBoundedRecordProjection),
    humanRequests
  }
  return portalPackCoordinationPage(sanitized, probe)
}

function portalPackCoordinationPage(
  entity: Record<string, unknown>,
  probe?: PortalPackSerializationProbe
): Record<string, unknown> {
  if (!isRecord(entity.pagination)) return entity
  const projectId = typeof entity.projectId === 'string' ? entity.projectId : undefined
  const tasks = Array.isArray(entity.tasks) ? entity.tasks : []
  const records = Array.isArray(entity.records) ? entity.records : []
  const humanRequests = Array.isArray(entity.humanRequests) ? entity.humanRequests : []
  if (!projectId || !isRecord(entity.pagination.tasks) || !isRecord(entity.pagination.records) ||
      !isRecord(entity.pagination.humanRequests)) {
    throw new CollaborationServiceError('internal_error', 'The Portal coordination pagination was malformed.')
  }
  const stableProjectId = projectId
  const pagination = entity.pagination as Record<string, unknown>
  const selected = { tasks: [] as unknown[], records: [] as unknown[], humanRequests: [] as unknown[] }
  const offsets = { tasks: 0, records: 0, humanRequests: 0 }
  const blocked = { tasks: false, records: false, humanRequests: false }
  const acceptedOrder: Array<'tasks' | 'records' | 'humanRequests'> = []
  const collections = [
    { key: 'tasks' as const, values: tasks, id: 'taskId', scope: 'coordination.tasks' },
    { key: 'records' as const, values: records, id: 'projectRecordId', scope: 'coordination.records' },
    { key: 'humanRequests' as const, values: humanRequests, id: 'humanRequestId', scope: 'coordination.human' }
  ]
  const originalPagination = Object.fromEntries(collections.map((collection) => {
    const original = pagination[collection.key] as Record<string, unknown>
    if (typeof original.version !== 'string' || original.version.length < 1 || original.version.length > 256) {
      throw new CollaborationServiceError('internal_error', 'The Portal coordination version was malformed.')
    }
    const nextCursor = typeof original.nextCursor === 'string' ? portalPackCursor(original.nextCursor) : undefined
    return [collection.key, { limit: original.limit, version: original.version, nextCursor }]
  })) as Record<'tasks' | 'records' | 'humanRequests', {
    limit: unknown
    version: string
    nextCursor: string | undefined
  }>
  const build = () => ({
    ...entity,
    tasks: selected.tasks,
    records: selected.records,
    humanRequests: selected.humanRequests,
    pagination: Object.fromEntries(collections.map((collection) => {
      const original = originalPagination[collection.key]
      const chosen = selected[collection.key]
      const last = chosen.at(-1)
      const candidateId = isRecord(last) ? last[collection.id] : undefined
      const lastId: string | undefined = typeof candidateId === 'string' ? candidateId : undefined
      const omittedFromFetchedPage = chosen.length < collection.values.length
      const nextCursor = omittedFromFetchedPage
        ? (lastId ? portalCoordinationCursor(collection.scope, stableProjectId, lastId) : undefined)
        : original.nextCursor
      return [collection.key, {
        limit: original.limit,
        version: original.version,
        ...(nextCursor ? { nextCursor: portalPackCursor(nextCursor) } : {})
      }]
    }))
  })
  const header = {
    ...entity,
    tasks: [],
    records: [],
    humanRequests: [],
    pagination: Object.fromEntries(collections.map((collection) => {
      const original = originalPagination[collection.key]
      return [collection.key, {
        limit: original.limit,
        version: original.version,
        nextCursor: PORTAL_PACK_CURSOR_RESERVE
      }]
    }))
  }
  let estimatedBytes = portalPackJsonBytes(header, 'header', probe)
  if (estimatedBytes > MAX_PORTAL_ENTITY_BYTES) {
    throw new CollaborationServiceError('payload_too_large', 'The Portal Project header exceeds its bounded view limit.')
  }
  const itemBytes = {
    tasks: tasks.map((item) => portalPackJsonBytes(item, 'item', probe)),
    records: records.map((item) => portalPackJsonBytes(item, 'item', probe)),
    humanRequests: humanRequests.map((item) => portalPackJsonBytes(item, 'item', probe))
  }
  while (true) {
    let progressed = false
    for (const collection of collections) {
      if (blocked[collection.key] || offsets[collection.key] >= collection.values.length) continue
      const additionalBytes = itemBytes[collection.key][offsets[collection.key]]! +
        (selected[collection.key].length > 0 ? 1 : 0)
      if (estimatedBytes + additionalBytes > MAX_PORTAL_ENTITY_BYTES) {
        blocked[collection.key] = true
        continue
      }
      selected[collection.key].push(collection.values[offsets[collection.key]]!)
      acceptedOrder.push(collection.key)
      estimatedBytes += additionalBytes
      offsets[collection.key] += 1
      progressed = true
    }
    if (!progressed) break
  }
  return portalFinalizePackedPage(
    build,
    () => {
      const lastCollection = acceptedOrder.pop()
      if (lastCollection) selected[lastCollection].pop()
    },
    () => collections.some((collection) => (
      collection.values.length > 0 && selected[collection.key].length === 0
    )),
    'A Portal collection item exceeds its safe projection limit.',
    probe
  )
}

function portalFinalizePackedPage(
  build: () => Record<string, unknown>,
  removeLast: () => void,
  missesRequiredItem: () => boolean,
  itemErrorMessage: string,
  probe?: PortalPackSerializationProbe
): Record<string, unknown> {
  if (missesRequiredItem()) {
    throw new CollaborationServiceError('payload_too_large', itemErrorMessage)
  }
  let page = build()
  for (let rechecks = 0; ; rechecks += 1) {
    if (portalPackJsonBytes(page, 'final', probe) <= MAX_PORTAL_ENTITY_BYTES) return page
    if (rechecks >= MAX_PORTAL_PACK_FINAL_RECHECKS) {
      throw new CollaborationServiceError('payload_too_large', 'The Portal view exceeds its bounded response limit.')
    }
    removeLast()
    if (missesRequiredItem()) {
      throw new CollaborationServiceError('payload_too_large', itemErrorMessage)
    }
    page = build()
  }
}

function portalPackCursor(cursor: string): string {
  if (cursor.length < 1 || cursor.length > MAX_PORTAL_CURSOR_CHARACTERS) {
    throw new CollaborationServiceError('internal_error', 'The Portal page cursor was malformed.')
  }
  return cursor
}

function portalPackJsonBytes(
  value: unknown,
  phase: 'header' | 'item' | 'final',
  probe?: PortalPackSerializationProbe
): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new CollaborationServiceError('internal_error', 'The Portal view was not JSON serializable.')
  }
  probe?.({ phase, value })
  return Buffer.byteLength(serialized, 'utf8')
}

function portalBoundedTaskProjection(value: unknown): unknown {
  if (!isRecord(value) || jsonBytes(value) <= MAX_PORTAL_COLLECTION_ITEM_BYTES) return value
  const completionCriteria = arrayRecords(value.completionCriteria).slice(0, 8).map((criterion) => ({
    criterionId: criterion.criterionId,
    text: clippedText(criterion.text, 500)
  }))
  const requirements = isRecord(value.requiredCapabilities) ? value.requiredCapabilities : {}
  const bounded = {
    ...value,
    objective: clippedText(value.objective, 2_000),
    completionCriteria,
    dependencyTaskIds: arrayStrings(value.dependencyTaskIds).slice(0, 100),
    requiredCapabilities: {
      capabilityIds: arrayStrings(requirements.capabilityIds).slice(0, 64),
      vpnAccessIds: arrayStrings(requirements.vpnAccessIds).slice(0, 20),
      slurmClusterIds: arrayStrings(requirements.slurmClusterIds).slice(0, 20),
      requiredResourceRefIds: arrayStrings(requirements.requiredResourceRefIds).slice(0, 100),
      ...(requirements.minimumEvidenceLevel ? { minimumEvidenceLevel: requirements.minimumEvidenceLevel } : {}),
      ...(requirements.minGpuMemoryGB !== undefined ? { minGpuMemoryGB: requirements.minGpuMemoryGB } : {}),
      ...(requirements.requireLogSummary !== undefined ? { requireLogSummary: requirements.requireLogSummary } : {})
    },
    resourceRefIds: arrayStrings(value.resourceRefIds).slice(0, 100),
    authorizationRequirements: arrayRecords(value.authorizationRequirements).slice(0, 20).map((requirement) => ({
      id: requirement.id,
      kind: requirement.kind,
      ...(requirement.targetRefId ? { targetRefId: requirement.targetRefId } : {}),
      description: clippedText(requirement.description, 200)
    })),
    ...(typeof value.resultSummary === 'string' ? { resultSummary: clippedText(value.resultSummary, 2_000) } : {}),
    ...(typeof value.safeFailureSummary === 'string'
      ? { safeFailureSummary: clippedText(value.safeFailureSummary, 1_000) }
      : {}),
    portalProjection: { truncated: true, reason: 'item_byte_limit' }
  }
  return jsonBytes(bounded) <= MAX_PORTAL_COLLECTION_ITEM_BYTES ? bounded : portalMinimalTaskProjection(value)
}

function portalMinimalTaskProjection(value: Record<string, unknown>): Record<string, unknown> {
  const criterion = arrayRecords(value.completionCriteria)[0]
  return {
    schemaVersion: value.schemaVersion,
    type: value.type,
    taskId: value.taskId,
    projectId: value.projectId,
    executionId: value.executionId,
    createdByCoordinatorAgentId: value.createdByCoordinatorAgentId,
    assigneeAgentId: value.assigneeAgentId,
    assigneeUserId: value.assigneeUserId,
    title: value.title,
    objective: clippedText(value.objective, 1_000),
    completionCriteria: criterion ? [{ criterionId: criterion.criterionId, text: clippedText(criterion.text, 200) }] : [],
    dependencyTaskIds: [],
    requiredCapabilities: { capabilityIds: [], vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: [] },
    resourceRefIds: [],
    authorizationRequirements: [],
    status: value.status,
    attempt: value.attempt,
    maxRetries: value.maxRetries,
    ...(isRecord(value.progress) ? { progress: value.progress } : {}),
    ...(typeof value.resultSummary === 'string' ? { resultSummary: clippedText(value.resultSummary, 1_000) } : {}),
    ...(value.resultProjectRecordId ? { resultProjectRecordId: value.resultProjectRecordId } : {}),
    ...(value.safeFailureCode ? { safeFailureCode: value.safeFailureCode } : {}),
    ...(typeof value.safeFailureSummary === 'string'
      ? { safeFailureSummary: clippedText(value.safeFailureSummary, 500) }
      : {}),
    ...(value.completedAt ? { completedAt: value.completedAt } : {}),
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    portalProjection: { truncated: true, reason: 'item_byte_limit' }
  }
}

function portalBoundedRecordProjection(value: unknown): unknown {
  if (!isRecord(value) || jsonBytes(value) <= MAX_PORTAL_COLLECTION_ITEM_BYTES) return value
  const bounded = {
    ...value,
    body: clippedText(value.body, 4_000),
    criterionEvidence: arrayRecords(value.criterionEvidence).slice(0, 20).map((evidence) => ({
      criterionId: evidence.criterionId,
      summary: clippedText(evidence.summary, 500),
      resourceRefIds: arrayStrings(evidence.resourceRefIds).slice(0, 50)
    })),
    resourceRefIds: arrayStrings(value.resourceRefIds).slice(0, 100),
    ...(typeof value.logSummary === 'string' ? { logSummary: clippedText(value.logSummary, 1_000) } : {}),
    portalProjection: { truncated: true, reason: 'item_byte_limit' }
  }
  return jsonBytes(bounded) <= MAX_PORTAL_COLLECTION_ITEM_BYTES ? bounded : portalMinimalRecordProjection(value)
}

function portalMinimalRecordProjection(value: Record<string, unknown>): Record<string, unknown> {
  const evidence = arrayRecords(value.criterionEvidence)[0]
  return {
    schemaVersion: value.schemaVersion,
    type: value.type,
    projectRecordId: value.projectRecordId,
    projectId: value.projectId,
    kind: value.kind,
    status: value.status,
    body: clippedText(value.body, 1_000),
    authorUserId: value.authorUserId,
    authorAgentId: value.authorAgentId,
    sourceTaskId: value.sourceTaskId,
    sourceExecutionId: value.sourceExecutionId,
    sourceRevision: value.sourceRevision,
    criterionEvidence: evidence ? [{
      criterionId: evidence.criterionId,
      summary: clippedText(evidence.summary, 200),
      resourceRefIds: arrayStrings(evidence.resourceRefIds).slice(0, 10)
    }] : [],
    resourceRefIds: arrayStrings(value.resourceRefIds).slice(0, 10),
    ...(typeof value.logSummary === 'string' ? { logSummary: clippedText(value.logSummary, 500) } : { logSummary: null }),
    acceptedByUserId: value.acceptedByUserId,
    acceptedByAgentId: value.acceptedByAgentId,
    acceptedAt: value.acceptedAt,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    portalProjection: { truncated: true, reason: 'item_byte_limit' }
  }
}

function portalCoordinationCursor(scope: string, projectId: string, entityId: string): string {
  return portalPageCursor(scope, `${projectId}\u001f${entityId}`)
}

function portalPageCursor(scope: string, key: string): string {
  return `p1.${Buffer.from(`${scope}\u0000${key}`, 'utf8').toString('base64url')}`
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function clippedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return ''
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireSameOriginFetch(request: IncomingMessage): void {
  const site = firstHeader(request.headers['sec-fetch-site'])
  const mode = firstHeader(request.headers['sec-fetch-mode'])
  if (site !== 'same-origin' || (mode !== 'cors' && mode !== 'same-origin')) {
    throw new PortalSessionError('portal_csrf_rejected', 'The Portal request origin could not be verified.', 403)
  }
}

function requireJson(request: IncomingMessage): void {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new CollaborationServiceError('validation_failed', 'Content-Type must be application/json.')
  }
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.byteLength
    if (length > maximumBytes) throw new CollaborationServiceError('payload_too_large', 'Portal command body is too large.')
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')) }
  catch { throw new CollaborationServiceError('validation_failed', 'Portal command body must be valid JSON.') }
}

function portalReadRequest(type: RestRequest['type'], fields: Record<string, unknown>): RestRequest {
  return restRequestSchema.parse({
    protocolVersion: '1.0',
    requestId: portalRequestId(),
    type,
    ...fields
  })
}

function portalWriteRequest(
  request: IncomingMessage,
  type: RestRequest['type'],
  fields: Record<string, unknown>,
  deterministicActorKey?: string
): RestRequest {
  const suppliedIdempotencyKey = firstHeader(request.headers['idempotency-key'])
  if (!suppliedIdempotencyKey) {
    throw new CollaborationServiceError('validation_failed', 'A bounded Idempotency-Key header is required.')
  }
  idempotencyKeySchema.parse(suppliedIdempotencyKey)
  // Project creation has no revision fence. Deriving its canonical key from the
  // authenticated actor and exact business payload keeps a lost-response retry
  // idempotent across a browser reload without persisting operation data client-side.
  const idempotencyKey = deterministicActorKey
    ? `idem_portal_${createHash('sha256').update(stableJson({ actorKey: deterministicActorKey, type, fields })).digest('hex')}`
    : suppliedIdempotencyKey
  return restRequestSchema.parse({
    protocolVersion: '1.0',
    requestId: portalRequestId(),
    type,
    idempotencyKey,
    ...fields
  })
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function portalRequestId(): string {
  return requestIdSchema.parse(`req_${randomUUID().replaceAll('-', '').slice(0, 24)}`)
}

function exactPath(pathname: string, expression: RegExp): RegExpExecArray | null {
  return expression.exec(pathname)
}

function exactQuery(url: URL, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed)
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) {
      throw new CollaborationServiceError('validation_failed', 'The Portal query contains an unsupported field.')
    }
  }
}

function singleQuery(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name)
  if (values.length > 1) {
    throw new CollaborationServiceError('validation_failed', 'The Portal query contains a repeated scalar field.')
  }
  return values[0]
}

function queryInteger(url: URL, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = singleQuery(url, name)
  if (value === undefined) return fallback
  if (!/^\d{1,4}$/u.test(value)) {
    throw new CollaborationServiceError('validation_failed', 'The Portal page limit is invalid.')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CollaborationServiceError('validation_failed', 'The Portal page limit is outside the allowed range.')
  }
  return parsed
}

function sendPortalFailure(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  if (error instanceof PortalSessionError) {
    sendJson(response, error.status, {
      schemaVersion: 1,
      type: 'portal.error',
      error: { code: error.code, message: error.message, retryable: error.retryable }
    }, error.status === 401
      ? { 'www-authenticate': 'Portal' }
      : error.status === 429 ? { 'retry-after': '1' } : undefined)
    return
  }
  const serviceError = error instanceof CollaborationServiceError
    ? error
    : error instanceof ZodError
      ? new CollaborationServiceError('validation_failed', 'The strict Portal command schema rejected this request.')
      : new CollaborationServiceError('internal_error', 'The Portal could not complete the request.', { retryable: true })
  const codeMap = {
    validation_failed: 'validation_error',
    budget_exhausted: 'invalid_state_transition',
    resource_offline: 'provider_unavailable',
    request_expired: 'expired'
  } as const
  const code = codeMap[serviceError.code as keyof typeof codeMap] ?? serviceError.code
  const requestId = `req_${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const errorBody = createCollaborationError(code as Parameters<typeof createCollaborationError>[0], serviceError.message, {
    requestId,
    traceId: `trc_${randomUUID().replaceAll('-', '').slice(0, 24)}`
  })
  sendJson(response, errorBody.httpStatus, {
    protocolVersion: '1.0',
    type: 'rest.error',
    requestId: requestIdSchema.parse(requestId),
    error: errorBody
  })
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, secureHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.byteLength),
    ...extraHeaders
  }))
  response.end(bytes)
}

function redirect(response: ServerResponse, location: string, status: 308): void {
  response.writeHead(status, secureHeaders({ location }))
  response.end()
}

function portalAssetHeaders(
  cacheControl: string,
  etag: string,
  extraHeaders: Record<string, string> = {}
): Record<string, string> {
  return secureHeaders({
    'cache-control': cacheControl,
    etag,
    'content-security-policy': PORTAL_CSP,
    ...extraHeaders
  }) as Record<string, string>
}

function secureHeaders(extraHeaders: Record<string, string | string[]> = {}): Record<string, string | string[]> {
  return {
    'cache-control': 'no-store',
    'content-security-policy': PORTAL_CSP,
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extraHeaders
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function portalClientSource(request: IncomingMessage): string {
  const forwarded = firstHeader(request.headers['x-forwarded-for'])
  const address = request.socket.remoteAddress
  if (address && isPrivateProxyAddress(address) && forwarded && isIP(forwarded) !== 0) {
    return `forwarded:${forwarded.toLowerCase()}`
  }
  return address && isIP(address) !== 0 ? `socket:${address.toLowerCase()}` : 'socket:unknown'
}

function isPrivateProxyAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/u, '')
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')) return true
  const parts = normalized.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
}
