import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import type { UserActor } from './auth.js'
import type { PortalSessionManager } from './portal-session.js'
import { PortalWebSocketHub, type PortalProjectWakeSnapshot } from './portal-websocket.js'

const ORIGIN = 'https://cloud-test.sciforge.cn'
const PROJECT_ID = 'prj_PortalProject001'
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
const cleanup: Array<() => Promise<void>> = []
const messageBuffers = new WeakMap<WebSocket, {
  values: Record<string, unknown>[]
  waiters: Array<{
    resolve: (value: Record<string, unknown>) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>
}>()

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
})

describe('Portal cookie-authenticated WebSocket', () => {
  it('authorizes project subscriptions and emits only bounded wake metadata', async () => {
    let snapshot = wakeSnapshot()
    const runtime = await openHub(async (_actor, projectId) => {
      if (projectId !== PROJECT_ID) throw new Error('forbidden')
      return snapshot
    })
    const socket = await connect(runtime.url)
    const ready = await nextMessage(socket)
    expect(ready).toMatchObject({ schemaVersion: 1, type: 'connection.ready' })
    socket.send(JSON.stringify({ schemaVersion: 1, type: 'project.subscribe', projectId: PROJECT_ID }))
    await expect(nextMessage(socket)).resolves.toEqual({
      schemaVersion: 1,
      type: 'project.subscribed',
      projectId: PROJECT_ID,
      revision: 3
    })

    snapshot = { ...snapshot, taskVersion: 'task-version-2' }
    runtime.hub.notifyInboxAvailable({ kind: 'user', id: actor.userId }, 4)
    const changed = await nextMessage(socket)
    expect(changed).toEqual({
      schemaVersion: 1,
      type: 'project.changed',
      projectId: PROJECT_ID,
      changeKind: 'task',
      revision: 3
    })
    expect(JSON.stringify(changed)).not.toMatch(/objective|resultSummary|prompt|token/iu)

    socket.send(JSON.stringify({ schemaVersion: 1, type: 'connection.ping', nonce: 'portal-ping' }))
    await expect(nextMessage(socket)).resolves.toMatchObject({
      schemaVersion: 1,
      type: 'connection.pong',
      nonce: 'portal-ping'
    })
    socket.close()
  })

  it('rejects cross-project subscriptions without leaking project existence', async () => {
    const runtime = await openHub(async () => { throw new Error('not found or forbidden') }, undefined, {
      subscriptionTimeoutMs: 50
    })
    const socket = await connect(runtime.url)
    await nextMessage(socket)
    const close = once(socket, 'close')
    socket.send(JSON.stringify({ schemaVersion: 1, type: 'project.subscribe', projectId: PROJECT_ID }))
    await expect(nextMessage(socket)).resolves.toEqual({
      schemaVersion: 1,
      type: 'subscription.error',
      code: 'permission_denied'
    })
    const [code, reason] = await close
    expect(code).toBe(1008)
    expect(String(reason)).toMatch(/subscription/iu)
  })

  it('bounds a zero-subscription socket after Project membership is revoked', async () => {
    let authorized = true
    const runtime = await openHub(async () => {
      if (!authorized) throw new Error('membership revoked')
      return wakeSnapshot()
    }, undefined, {
      pollIntervalMs: 20,
      subscriptionTimeoutMs: 50
    })
    const socket = await connect(runtime.url)
    await nextMessage(socket)
    socket.send(JSON.stringify({ schemaVersion: 1, type: 'project.subscribe', projectId: PROJECT_ID }))
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: 'project.subscribed' })

    const close = once(socket, 'close')
    authorized = false
    await expect(nextMessage(socket)).resolves.toEqual({
      schemaVersion: 1,
      type: 'subscription.error',
      code: 'permission_denied'
    })
    const [code, reason] = await close
    expect(code).toBe(1008)
    expect(String(reason)).toMatch(/subscription/iu)
  })

  it('requires exact Origin, cookie session, protocol, and a token-free URL', async () => {
    const runtime = await openHub(async () => wakeSnapshot())
    await expectConnectFailure(runtime.url, { origin: 'https://attacker.invalid' })
    await expectConnectFailure(runtime.url, { cookie: '' })
    await expectConnectFailure(`${runtime.url}?access_token=forbidden`)
    await expectConnectFailure(runtime.url, { protocol: 'other.protocol' })
  })

  it('does not let a malformed Host crash the unauthenticated Upgrade boundary', async () => {
    const runtime = await openHub(async () => wakeSnapshot())
    const response = await rawUpgrade(runtime.url, '[', 'https://attacker.invalid')
    expect(response).toMatch(/^HTTP\/1\.1 403 Forbidden/mu)
    const healthy = await connect(runtime.url)
    await expect(nextMessage(healthy)).resolves.toMatchObject({ type: 'connection.ready' })
    healthy.close()
  })

  it('closes existing sockets after the in-memory session stops being current', async () => {
    let valid = true
    const authenticate = vi.fn(async () => {
      if (!valid) throw new Error('expired')
      return {
        actor,
        csrfToken: 'C'.repeat(43),
        idleExpiresAt: '2026-08-22T12:30:00.000Z',
        absoluteExpiresAt: '2026-08-22T20:00:00.000Z'
      }
    })
    const runtime = await openHub(async () => wakeSnapshot(), authenticate)
    const socket = await connect(runtime.url)
    await nextMessage(socket)
    socket.send(JSON.stringify({ schemaVersion: 1, type: 'project.subscribe', projectId: PROJECT_ID }))
    await nextMessage(socket)
    valid = false
    const close = once(socket, 'close')
    await close
    expect(authenticate).toHaveBeenCalled()
  })

  it('does not let periodic Project reconciliation keep an idle cookie or socket alive', async () => {
    let elapsed = 0
    const validateCookie = vi.fn(async (cookie: string | undefined) => {
      if (cookie !== '__Host-sciforge-portal=session' || elapsed >= 30 * 60_000) {
        throw new Error('idle session expired')
      }
      return {
        actor,
        csrfToken: 'C'.repeat(43),
        idleExpiresAt: new Date(30 * 60_000).toISOString(),
        absoluteExpiresAt: new Date(8 * 60 * 60_000).toISOString()
      }
    })
    const runtime = await openHub(async () => wakeSnapshot(), validateCookie, {
      pollIntervalMs: 20,
      heartbeatIntervalMs: 1_000
    })
    const socket = await connect(runtime.url)
    await nextMessage(socket)
    socket.send(JSON.stringify({ schemaVersion: 1, type: 'project.subscribe', projectId: PROJECT_ID }))
    await nextMessage(socket)

    const closed = once(socket, 'close')
    elapsed = 30 * 60_000
    const [code, reason] = await closed
    expect(code).toBe(1008)
    expect(String(reason)).toMatch(/session/iu)
    await expect(validateCookie('__Host-sciforge-portal=session')).rejects.toThrow('idle session expired')
  })

  it('bounds global and per-identity connections and closes idle unsubscribed sockets', async () => {
    const identityBound = await openHub(async () => wakeSnapshot(), undefined, {
      maxConnections: 4,
      maxConnectionsPerIdentity: 1,
      subscriptionTimeoutMs: 50
    })
    const first = await connect(identityBound.url)
    await nextMessage(first)
    await expectConnectFailure(identityBound.url)
    const idleClose = once(first, 'close')
    await idleClose

    const globalBound = await openHub(async () => wakeSnapshot(), undefined, {
      maxConnections: 1,
      maxConnectionsPerIdentity: 4,
      subscriptionTimeoutMs: 1_000
    })
    const only = await connect(globalBound.url)
    await nextMessage(only)
    await expectConnectFailure(globalBound.url)
    only.close()
  })

  it('coalesces inbox wake storms and targets direct User notifications', async () => {
    const readProject = vi.fn(async () => wakeSnapshot())
    const runtime = await openHub(readProject, undefined, {
      pollIntervalMs: 30_000,
      notificationDebounceMs: 20
    })
    const socket = await connect(runtime.url)
    await nextMessage(socket)
    socket.send(JSON.stringify({ schemaVersion: 1, type: 'project.subscribe', projectId: PROJECT_ID }))
    await nextMessage(socket)
    expect(readProject).toHaveBeenCalledTimes(1)

    for (let index = 0; index < 50; index += 1) {
      runtime.hub.notifyInboxAvailable({ kind: 'user', id: 'usr_unrelated0001' }, index + 1)
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(readProject).toHaveBeenCalledTimes(1)

    for (let index = 0; index < 50; index += 1) {
      runtime.hub.notifyInboxAvailable({ kind: 'user', id: actor.userId }, index + 1)
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(readProject).toHaveBeenCalledTimes(2)
    socket.close()
  })

  it('bounds inbound command queues and does not reread an existing subscription', async () => {
    const readProject = vi.fn(async () => wakeSnapshot())
    const authenticate = vi.fn(async () => ({
      actor,
      csrfToken: 'C'.repeat(43),
      idleExpiresAt: '2026-08-22T12:30:00.000Z',
      absoluteExpiresAt: '2026-08-22T20:00:00.000Z'
    }))
    const runtime = await openHub(readProject, authenticate, { pollIntervalMs: 30_000 })
    const socket = await connect(runtime.url)
    await nextMessage(socket)
    const subscribe = JSON.stringify({ schemaVersion: 1, type: 'project.subscribe', projectId: PROJECT_ID })
    socket.send(subscribe)
    await nextMessage(socket)
    expect(readProject).toHaveBeenCalledTimes(1)

    const close = once(socket, 'close')
    for (let index = 0; index < 1_000; index += 1) socket.send(subscribe)
    await close
    expect(readProject).toHaveBeenCalledTimes(1)
    expect(authenticate.mock.calls.length).toBeLessThanOrEqual(22)
  })
})

async function openHub(
  readProject: (actor: UserActor, projectId: string) => Promise<PortalProjectWakeSnapshot>,
  authenticate: ((cookie: string | undefined) => Promise<{
    actor: UserActor
    csrfToken: string
    idleExpiresAt: string
    absoluteExpiresAt: string
  }>) | undefined = undefined,
  options: Partial<{
    pollIntervalMs: number
    maxConnections: number
    maxConnectionsPerIdentity: number
    subscriptionTimeoutMs: number
    heartbeatIntervalMs: number
    notificationDebounceMs: number
  }> = {}
) {
  const authenticateSession = authenticate ?? vi.fn(async (cookie: string | undefined) => {
    if (cookie !== '__Host-sciforge-portal=session') throw new Error('missing session')
    return {
      actor,
      csrfToken: 'C'.repeat(43),
      idleExpiresAt: '2026-08-22T12:30:00.000Z',
      absoluteExpiresAt: '2026-08-22T20:00:00.000Z'
    }
  })
  const sessions = { authenticatePassive: authenticateSession } as unknown as PortalSessionManager
  const hub = new PortalWebSocketHub({
    sessions,
    publicOrigin: ORIGIN,
    readProject,
    pollIntervalMs: options.pollIntervalMs ?? 20,
    maxConnections: options.maxConnections,
    maxConnectionsPerIdentity: options.maxConnectionsPerIdentity,
    subscriptionTimeoutMs: options.subscriptionTimeoutMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    notificationDebounceMs: options.notificationDebounceMs
  })
  const server = createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  server.on('upgrade', (request, socket, head) => {
    if (!hub.handleUpgrade(request, socket, head)) socket.destroy()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test address')
  cleanup.push(async () => {
    await hub.close()
    server.close()
    await once(server, 'close')
  })
  return { url: `ws://127.0.0.1:${address.port}/portal/events`, hub, authenticate: authenticateSession }
}

function connect(
  url: string,
  options: { origin?: string; cookie?: string; protocol?: string } = {}
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options.protocol ?? 'sciforge.portal.v1', {
      origin: options.origin ?? ORIGIN,
      headers: { cookie: options.cookie ?? '__Host-sciforge-portal=session' }
    })
    const buffer = { values: [], waiters: [] } satisfies NonNullable<ReturnType<typeof messageBuffers.get>>
    messageBuffers.set(socket, buffer)
    socket.on('message', (data) => {
      let value: Record<string, unknown>
      try { value = JSON.parse(data.toString()) as Record<string, unknown> }
      catch (error) {
        const waiter = buffer.waiters.shift()
        if (waiter) {
          clearTimeout(waiter.timer)
          waiter.reject(error instanceof Error ? error : new Error('Portal WebSocket JSON was invalid.'))
        }
        return
      }
      const waiter = buffer.waiters.shift()
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve(value)
      } else {
        buffer.values.push(value)
      }
    })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function rawUpgrade(url: string, host: string, origin: string): Promise<string> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = createConnection(Number(target.port), target.hostname)
    let response = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk) => { response += chunk })
    socket.once('close', () => resolve(response))
    socket.once('connect', () => {
      socket.write([
        `GET ${target.pathname} HTTP/1.1`,
        `Host: ${host}`,
        `Origin: ${origin}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Protocol: sciforge.portal.v1',
        '', ''
      ].join('\r\n'))
    })
  })
}

async function expectConnectFailure(
  url: string,
  options: { origin?: string; cookie?: string; protocol?: string } = {}
): Promise<void> {
  await expect(connect(url, options)).rejects.toBeInstanceOf(Error)
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  const buffer = messageBuffers.get(socket)
  if (!buffer) return Promise.reject(new Error('Portal WebSocket test buffer is missing.'))
  const buffered = buffer.values.shift()
  if (buffered) return Promise.resolve(buffered)
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = buffer.waiters.indexOf(waiter)
        if (index >= 0) buffer.waiters.splice(index, 1)
        reject(new Error('Portal WebSocket message timed out.'))
      }, 2_000)
    }
    buffer.waiters.push(waiter)
  })
}

function wakeSnapshot(): PortalProjectWakeSnapshot {
  return {
    projectId: PROJECT_ID,
    projectRevision: 3,
    projectVersion: 'project-version-1',
    taskVersion: 'task-version-1',
    recordVersion: 'record-version-1',
    humanVersion: 'human-version-1'
  }
}
