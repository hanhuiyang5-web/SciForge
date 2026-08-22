import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { performance } from 'node:perf_hooks'
import type { Duplex } from 'node:stream'

import { projectIdSchema } from '@sciforge/collaboration-contracts'
import { WebSocket, WebSocketServer } from 'ws'

import type { UserActor } from './auth.js'
import type { PortalSessionManager } from './portal-session.js'
import type { InboxAvailabilityNotifier } from './service.js'

const PORTAL_PROTOCOL = 'sciforge.portal.v1'
const MAX_SUBSCRIPTIONS = 20
const POLL_INTERVAL_MS = 30_000
const MAX_CONNECTIONS = 512
const MAX_CONNECTIONS_PER_IDENTITY = 4
const SUBSCRIPTION_TIMEOUT_MS = 10_000
const HEARTBEAT_INTERVAL_MS = 25_000
const NOTIFICATION_DEBOUNCE_MS = 25
const MAX_POLL_CLIENT_CONCURRENCY = 8
const MAX_BUFFERED_BYTES = 64 * 1024
const MAX_QUEUED_MESSAGES = 32
const INBOUND_MESSAGE_BURST = 20
const INBOUND_MESSAGES_PER_SECOND = 5

export type PortalProjectWakeSnapshot = Readonly<{
  projectId: string
  projectRevision: number
  projectVersion: string
  taskVersion: string
  recordVersion: string
  humanVersion: string
}>

export type PortalWebSocketUpgradeHandler = Readonly<{
  readonly path: string
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): Promise<void>
}>

export type PortalWebSocketHubOptions = Readonly<{
  sessions: PortalSessionManager
  publicOrigin: string
  readProject: (actor: UserActor, projectId: string) => Promise<PortalProjectWakeSnapshot>
  now?: () => Date
  pollIntervalMs?: number
  maxConnections?: number
  maxConnectionsPerIdentity?: number
  subscriptionTimeoutMs?: number
  heartbeatIntervalMs?: number
  notificationDebounceMs?: number
}>

type Subscription = {
  snapshot: PortalProjectWakeSnapshot
}

type PortalClient = {
  socket: WebSocket
  cookieHeader: string
  actor: UserActor
  subscriptions: Map<string, Subscription>
  polling: boolean
  alive: boolean
  messageQueue: Promise<void>
  queuedMessages: number
  inboundTokens: number
  inboundRefillAt: number
  subscriptionTimer?: ReturnType<typeof setTimeout>
}

export class PortalWebSocketHub implements PortalWebSocketUpgradeHandler, InboxAvailabilityNotifier {
  readonly path = '/portal/events'

  private readonly server: WebSocketServer
  private readonly clients = new Set<PortalClient>()
  private readonly now: () => Date
  private readonly pollTimer: ReturnType<typeof setInterval>
  private readonly heartbeatTimer: ReturnType<typeof setInterval>
  private readonly maxConnections: number
  private readonly maxConnectionsPerIdentity: number
  private readonly subscriptionTimeoutMs: number
  private readonly notificationDebounceMs: number
  private pendingUpgrades = 0
  private pollRunning = false
  private pollAllRequested = false
  private readonly pollUserIds = new Set<string>()
  private scheduledPoll?: ReturnType<typeof setTimeout>

  constructor(private readonly options: PortalWebSocketHubOptions) {
    this.now = options.now ?? (() => new Date())
    this.server = new WebSocketServer({
      noServer: true,
      maxPayload: 8 * 1024,
      perMessageDeflate: false,
      handleProtocols: (protocols) => protocols.has(PORTAL_PROTOCOL) ? PORTAL_PROTOCOL : false
    })
    const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 30_000) {
      throw new Error('Portal WebSocket poll interval is invalid.')
    }
    this.maxConnections = boundedInteger(options.maxConnections, MAX_CONNECTIONS, 1, 10_000,
      'Portal WebSocket global connection limit is invalid.')
    this.maxConnectionsPerIdentity = boundedInteger(options.maxConnectionsPerIdentity,
      MAX_CONNECTIONS_PER_IDENTITY, 1, 32, 'Portal WebSocket identity connection limit is invalid.')
    this.subscriptionTimeoutMs = boundedInteger(options.subscriptionTimeoutMs, SUBSCRIPTION_TIMEOUT_MS,
      10, 60_000, 'Portal WebSocket subscription timeout is invalid.')
    const heartbeatIntervalMs = boundedInteger(options.heartbeatIntervalMs, HEARTBEAT_INTERVAL_MS,
      10, 60_000, 'Portal WebSocket heartbeat interval is invalid.')
    this.notificationDebounceMs = boundedInteger(options.notificationDebounceMs, NOTIFICATION_DEBOUNCE_MS,
      1, 1_000, 'Portal WebSocket notification debounce is invalid.')
    this.pollTimer = setInterval(() => this.requestPoll(), pollIntervalMs)
    this.pollTimer.unref()
    this.heartbeatTimer = setInterval(() => this.heartbeat(), heartbeatIntervalMs)
    this.heartbeatTimer.unref()
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let url: URL
    try { url = new URL(request.url ?? '/', 'http://localhost') }
    catch {
      rejectUpgrade(socket, 400, 'Bad Request')
      return true
    }
    if (url.pathname !== this.path) return false
    if (url.search || request.headers.origin !== this.options.publicOrigin ||
        request.headers['sec-websocket-protocol'] !== PORTAL_PROTOCOL) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return true
    }
    if (this.clients.size + this.pendingUpgrades >= this.maxConnections) {
      rejectUpgrade(socket, 429, 'Too Many Requests')
      return true
    }
    const cookieHeader = firstHeader(request.headers.cookie)
    this.pendingUpgrades += 1
    this.options.sessions.authenticatePassive(cookieHeader).then((session) => {
      if (this.identityConnectionCount(session.actor.identityId) >= this.maxConnectionsPerIdentity) {
        rejectUpgrade(socket, 429, 'Too Many Requests')
        return
      }
      this.server.handleUpgrade(request, socket, head, (webSocket) => {
        const client: PortalClient = {
          socket: webSocket,
          cookieHeader: cookieHeader ?? '',
          actor: session.actor,
          subscriptions: new Map(),
          polling: false,
          alive: true,
          messageQueue: Promise.resolve(),
          queuedMessages: 0,
          inboundTokens: INBOUND_MESSAGE_BURST,
          inboundRefillAt: performance.now()
        }
        this.clients.add(client)
        client.subscriptionTimer = setTimeout(() => {
          if (client.subscriptions.size === 0) webSocket.close(1008, 'Project subscription required')
        }, this.subscriptionTimeoutMs)
        client.subscriptionTimer.unref()
        webSocket.on('pong', () => { client.alive = true })
        webSocket.on('error', (error) => {
          const code = (error as { code?: string }).code
          webSocket.close(code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 1009 : 1011,
            code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'Message too large' : 'Portal transport error')
        })
        webSocket.once('close', () => this.removeClient(client))
        webSocket.on('message', (data, binary) => {
          if (binary) return webSocket.close(1003, 'Text frames only')
          if (!this.consumeInboundToken(client) || client.queuedMessages >= MAX_QUEUED_MESSAGES) {
            webSocket.close(1013, 'Portal message rate exceeded')
            return
          }
          client.queuedMessages += 1
          const text = data.toString()
          client.messageQueue = client.messageQueue
            .then(() => webSocket.readyState === WebSocket.OPEN ? this.onMessage(client, text) : undefined)
            .catch(() => webSocket.close(1008, 'Portal message rejected'))
            .finally(() => { client.queuedMessages -= 1 })
        })
        setImmediate(() => send(webSocket, {
          schemaVersion: 1,
          type: 'connection.ready',
          connectionId: randomUUID(),
          connectedAt: this.now().toISOString()
        }))
      })
    }).catch(() => rejectUpgrade(socket, 401, 'Unauthorized'))
      .finally(() => { this.pendingUpgrades -= 1 })
    return true
  }

  async close(): Promise<void> {
    clearInterval(this.pollTimer)
    clearInterval(this.heartbeatTimer)
    if (this.scheduledPoll) clearTimeout(this.scheduledPoll)
    for (const client of this.clients) client.socket.close(1001, 'Server shutting down')
    for (const client of this.clients) if (client.subscriptionTimer) clearTimeout(client.subscriptionTimer)
    this.clients.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  notifyInboxAvailable(recipient: { kind: string; id: string }): void {
    // Inbox is the durable collaboration event source. Direct User notifications wake
    // only that User's sessions; Agent events use one coalesced fallback because their
    // owning Project is not encoded in this notifier. Frames contain metadata only and
    // the periodic timer remains the authoritative bounded reconcile fallback.
    if (recipient.kind === 'user') this.requestPoll(recipient.id)
    else this.requestPoll()
  }

  private async onMessage(client: PortalClient, text: string): Promise<void> {
    let raw: unknown
    try { raw = JSON.parse(text) } catch { throw new Error('invalid message') }
    if (!record(raw) || raw.schemaVersion !== 1 || typeof raw.type !== 'string') throw new Error('invalid message')
    if (raw.type === 'connection.ping') {
      if (!exactKeys(raw, ['schemaVersion', 'type', 'nonce']) ||
          typeof raw.nonce !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/u.test(raw.nonce)) throw new Error('invalid ping')
      client.actor = (await this.options.sessions.authenticatePassive(client.cookieHeader)).actor
      send(client.socket, { schemaVersion: 1, type: 'connection.pong', nonce: raw.nonce, sentAt: this.now().toISOString() })
      return
    }
    if (raw.type === 'project.subscribe') {
      if (!exactKeys(raw, ['schemaVersion', 'type', 'projectId'])) throw new Error('invalid subscription')
      const projectId = projectIdSchema.parse(raw.projectId)
      if (!client.subscriptions.has(projectId) && client.subscriptions.size >= MAX_SUBSCRIPTIONS) {
        send(client.socket, { schemaVersion: 1, type: 'subscription.error', code: 'subscription_limit' })
        return
      }
      client.actor = (await this.options.sessions.authenticatePassive(client.cookieHeader)).actor
      const existing = client.subscriptions.get(projectId)
      if (existing) {
        send(client.socket, {
          schemaVersion: 1,
          type: 'project.subscribed',
          projectId,
          revision: existing.snapshot.projectRevision
        })
        return
      }
      try {
        const snapshot = await this.options.readProject(client.actor, projectId)
        client.subscriptions.set(projectId, { snapshot })
        if (client.subscriptionTimer) {
          clearTimeout(client.subscriptionTimer)
          client.subscriptionTimer = undefined
        }
        send(client.socket, {
          schemaVersion: 1,
          type: 'project.subscribed',
          projectId,
          revision: snapshot.projectRevision
        })
      } catch {
        client.subscriptions.delete(projectId)
        if (client.subscriptions.size === 0) this.armSubscriptionTimeout(client)
        send(client.socket, { schemaVersion: 1, type: 'subscription.error', code: 'permission_denied' })
      }
      return
    }
    if (raw.type === 'project.unsubscribe') {
      if (!exactKeys(raw, ['schemaVersion', 'type', 'projectId'])) throw new Error('invalid subscription')
      const projectId = projectIdSchema.parse(raw.projectId)
      client.subscriptions.delete(projectId)
      if (client.subscriptions.size === 0) this.armSubscriptionTimeout(client)
      send(client.socket, { schemaVersion: 1, type: 'project.unsubscribed', projectId })
      return
    }
    throw new Error('unknown message')
  }

  private requestPoll(userId?: string): void {
    if (userId) this.pollUserIds.add(userId)
    else this.pollAllRequested = true
    this.schedulePoll()
  }

  private schedulePoll(): void {
    if (this.pollRunning || this.scheduledPoll) return
    this.scheduledPoll = setTimeout(() => {
      this.scheduledPoll = undefined
      void this.drainPollRequests()
    }, this.notificationDebounceMs)
    this.scheduledPoll.unref()
  }

  private async drainPollRequests(): Promise<void> {
    if (this.pollRunning) return
    this.pollRunning = true
    const pollAll = this.pollAllRequested
    const userIds = new Set(this.pollUserIds)
    this.pollAllRequested = false
    this.pollUserIds.clear()
    try {
      await this.poll(pollAll ? undefined : userIds)
    } catch {
      // A wake is advisory. The next bounded notification or periodic reconcile retries.
    } finally {
      this.pollRunning = false
      if (this.pollAllRequested || this.pollUserIds.size > 0) this.schedulePoll()
    }
  }

  private async poll(userIds?: ReadonlySet<string>): Promise<void> {
    await mapWithConcurrency([...this.clients], MAX_POLL_CLIENT_CONCURRENCY, async (client) => {
      if (userIds && !userIds.has(client.actor.userId)) return
      if (client.polling || client.socket.readyState !== WebSocket.OPEN || client.subscriptions.size === 0) return
      client.polling = true
      try {
        client.actor = (await this.options.sessions.authenticatePassive(client.cookieHeader)).actor
        for (const [projectId, subscription] of client.subscriptions) {
          let current: PortalProjectWakeSnapshot
          try {
            current = await this.options.readProject(client.actor, projectId)
          } catch {
            client.subscriptions.delete(projectId)
            if (client.subscriptions.size === 0) this.armSubscriptionTimeout(client)
            send(client.socket, { schemaVersion: 1, type: 'subscription.error', code: 'permission_denied' })
            return
          }
          const changeKind = changedKind(subscription.snapshot, current)
          subscription.snapshot = current
          if (changeKind) send(client.socket, {
            schemaVersion: 1,
            type: 'project.changed',
            projectId,
            changeKind,
            revision: current.projectRevision
          })
        }
      } catch {
        client.socket.close(1008, 'Portal session is no longer current')
      } finally {
        client.polling = false
      }
    })
  }

  private heartbeat(): void {
    for (const client of this.clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue
      if (!client.alive) {
        client.socket.terminate()
        this.removeClient(client)
        continue
      }
      client.alive = false
      try { client.socket.ping() } catch { client.socket.terminate() }
    }
  }

  private identityConnectionCount(identityId: string): number {
    let count = 0
    for (const client of this.clients) if (client.actor.identityId === identityId) count += 1
    return count
  }

  private armSubscriptionTimeout(client: PortalClient): void {
    if (client.subscriptionTimer) clearTimeout(client.subscriptionTimer)
    client.subscriptionTimer = setTimeout(() => {
      if (client.subscriptions.size === 0) client.socket.close(1008, 'Project subscription required')
    }, this.subscriptionTimeoutMs)
    client.subscriptionTimer.unref()
  }

  private removeClient(client: PortalClient): void {
    if (client.subscriptionTimer) clearTimeout(client.subscriptionTimer)
    this.clients.delete(client)
  }

  private consumeInboundToken(client: PortalClient): boolean {
    const current = performance.now()
    const elapsedSeconds = Math.max(0, current - client.inboundRefillAt) / 1_000
    client.inboundTokens = Math.min(INBOUND_MESSAGE_BURST,
      client.inboundTokens + elapsedSeconds * INBOUND_MESSAGES_PER_SECOND)
    client.inboundRefillAt = current
    if (client.inboundTokens < 1) return false
    client.inboundTokens -= 1
    return true
  }
}

function changedKind(
  previous: PortalProjectWakeSnapshot,
  current: PortalProjectWakeSnapshot
): 'project' | 'task' | 'record' | 'human_needed' | undefined {
  if (previous.projectVersion !== current.projectVersion) return 'project'
  if (previous.taskVersion !== current.taskVersion) return 'task'
  if (previous.recordVersion !== current.recordVersion) return 'record'
  if (previous.humanVersion !== current.humanVersion) return 'human_needed'
  return undefined
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.close(1009, 'Portal client is not consuming messages')
    return
  }
  socket.send(JSON.stringify(value))
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 403 | 429, message: string): void {
  if (socket.destroyed) return
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`)
  socket.destroy()
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  message: string
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) throw new Error(message)
  return resolved
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      await operation(values[index]!)
    }
  }))
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}
