import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import { WebSocket } from 'ws'

import { createCollaborationHttpServer } from '../packages/collaboration-server/src/api.ts'
import { AuthenticationService } from '../packages/collaboration-server/src/auth.ts'
import { IdentityService } from '../packages/collaboration-server/src/identity-service.ts'
import { CollaborationService } from '../packages/collaboration-server/src/service.ts'
import { CollaborationWebSocketHub } from '../packages/collaboration-server/src/websocket.ts'
import { FakeCollaborationRepository } from '../test-fixtures/collaboration/fake-adapters.mjs'

import {
  parseStrictWebSocketMessage,
  parseMultiWorkerAcceptanceConfiguration,
  runMultiWorkerAcceptance
} from './collaboration-a-multi-worker-acceptance.mjs'

const execFileAsync = promisify(execFile)

const COMMIT = '2'.repeat(40)
const NOW = new Date('2026-08-21T03:00:00.000Z')
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000)
const CLOUD_URL = 'https://cloud-test.sciforge.cn'
const ISSUER = 'https://login-test.sciforge.cn/realms/SciForge'
const MULTI_WORKER_HARNESS_SHA256 = createHash('sha256')
  .update(await readFile(new URL('./collaboration-a-multi-worker-acceptance.mjs', import.meta.url)))
  .digest('hex')
const IDENTITY_HARNESS_SHA256 = createHash('sha256')
  .update(await readFile(new URL('./collaboration-a-identity-acceptance.mjs', import.meta.url)))
  .digest('hex')

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function oidcToken(subject, discriminator) {
  return [
    encodedJson({ alg: 'RS256', kid: `multi-worker-test-${discriminator}`, typ: 'JWT' }),
    encodedJson({
      iss: ISSUER,
      sub: subject,
      aud: ['sciforge-cloud-api'],
      azp: 'sciforge-desktop',
      exp: NOW_SECONDS + 900,
      nbf: NOW_SECONDS - 10,
      iat: NOW_SECONDS - 5,
      auth_time: NOW_SECONDS - 5
    }),
    randomBytes(256).toString('base64url')
  ].join('.')
}

async function secureTokenFiles(t, { samePrincipal = false, workerCount = 2 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-a-multi-worker-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const subjects = {
    owner: 'multi-worker-owner-subject',
    workers: Array.from({ length: workerCount }, (_, index) => (
      samePrincipal && index === 0
        ? 'multi-worker-owner-subject'
        : `multi-worker-${index + 1}-subject`
    ))
  }
  const tokens = {
    ownerInitial: oidcToken(subjects.owner, 'owner-initial'),
    ownerRevoke: oidcToken(subjects.owner, 'owner-revoke')
  }
  for (let index = 0; index < workerCount; index += 1) {
    tokens[`worker${index + 1}Initial`] = oidcToken(subjects.workers[index], `worker-${index + 1}-initial`)
    tokens[`worker${index + 1}Revoke`] = oidcToken(subjects.workers[index], `worker-${index + 1}-revoke`)
  }
  const files = {}
  for (const [name, token] of Object.entries(tokens)) {
    const filename = join(directory, `${name}.token`)
    await writeFile(filename, `${token}\n`, { mode: 0o600 })
    await chmod(filename, 0o600)
    files[name] = filename
  }
  const workers = Array.from({ length: workerCount }, (_, index) => ({
    subject: subjects.workers[index],
    initialToken: tokens[`worker${index + 1}Initial`],
    revokeToken: tokens[`worker${index + 1}Revoke`],
    tokenFile: files[`worker${index + 1}Initial`],
    revokeTokenFile: files[`worker${index + 1}Revoke`]
  }))
  return { files, subjects, tokens, workers }
}

async function secureWorkerDescriptorFiles(t, tokenSet) {
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-a-worker-descriptors-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const files = []
  for (let index = 0; index < tokenSet.workers.length; index += 1) {
    const worker = tokenSet.workers[index]
    const filename = join(directory, `worker-${index + 1}.json`)
    await writeFile(filename, JSON.stringify({
      accessTokenFile: worker.tokenFile,
      revokeTokenFile: worker.revokeTokenFile
    }), { mode: 0o600 })
    await chmod(filename, 0o600)
    files.push(filename)
  }
  return files
}

class EdgeWebSocket extends EventEmitter {
  constructor(realSocket, commit, mode) {
    super()
    this.realSocket = realSocket
    this.readyState = realSocket.readyState
    let injectedMalformed = false
    realSocket.on('upgrade', (response) => {
      const edgeResponse = Object.create(response)
      edgeResponse.headers = { ...response.headers, 'x-sciforge-edge-revision': commit }
      this.emit('upgrade', edgeResponse)
    })
    realSocket.on('open', () => {
      this.readyState = realSocket.readyState
      this.emit('open')
    })
    realSocket.on('message', (data, binary) => {
      let outputData = data
      let type
      let parsed
      try {
        parsed = JSON.parse(data.toString())
        type = parsed.type
      } catch {
        type = undefined
      }
      if (mode === 'timeout-ready' && type === 'connection.ready') return
      if (mode === 'stale-inbox-sequence' && type === 'inbox.available') {
        outputData = Buffer.from(JSON.stringify({ ...parsed, highestSequence: 1 }), 'utf8')
      }
      this.emit('message', outputData, binary)
      if (mode === 'malformed-after-ready' && type === 'connection.ready' && !injectedMalformed) {
        injectedMalformed = true
        queueMicrotask(() => this.emit('message', Buffer.from('{"unexpected":true}', 'utf8'), false))
      }
    })
    realSocket.on('error', () => this.emit('error', new Error('redacted websocket test error')))
    realSocket.on('unexpected-response', () => this.emit('unexpected-response'))
    realSocket.on('close', (code, reason) => {
      this.readyState = realSocket.readyState
      this.emit('close', code, reason)
    })
  }

  send(data) {
    return this.realSocket.send(data)
  }

  terminate() {
    return this.realSocket.terminate()
  }

  close(code, reason) {
    return this.realSocket.close(code, reason)
  }
}

async function startRuntime(t, tokenSet, {
  injectUnrelatedWorkerMessage = false,
  injectSupersededWorkerMessage = false,
  mutateInboxMessage,
  webSocketMode = 'normal'
} = {}) {
  const repository = new FakeCollaborationRepository()
  const now = () => new Date(NOW)
  const identities = new IdentityService({ repository, now })
  const tokenSubjects = new Map([
    [tokenSet.tokens.ownerInitial, tokenSet.subjects.owner],
    [tokenSet.tokens.ownerRevoke, tokenSet.subjects.owner],
    ...tokenSet.workers.flatMap((worker) => ([
      [worker.initialToken, worker.subject],
      [worker.revokeToken, worker.subject]
    ]))
  ])
  const resolver = {
    isCandidate: (token) => tokenSubjects.has(token),
    resolve: async (token) => {
      const subject = tokenSubjects.get(token)
      if (!subject) throw new Error('Unknown injected OIDC token')
      return identities.resolveOidcUser({
        issuer: ISSUER,
        subject,
        audience: ['sciforge-cloud-api'],
        authorizedParty: 'sciforge-desktop',
        issuedAt: NOW_SECONDS - 5,
        notBefore: NOW_SECONDS - 10,
        expiresAt: NOW_SECONDS + 900,
        authTime: NOW_SECONDS - 5,
        displayName: subject === tokenSet.subjects.owner ? 'Multi-worker Owner' : 'Multi-worker Worker'
      })
    }
  }
  const authentication = new AuthenticationService(repository, now, resolver)
  const webSocketHub = new CollaborationWebSocketHub()
  const service = new CollaborationService({ repository, notifier: webSocketHub, now })
  const server = createCollaborationHttpServer({
    service,
    identities,
    authentication,
    readiness: async () => true,
    now
  })
  webSocketHub.attach(server, { authentication, now })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected local test server address')
  const localBaseUrl = `http://127.0.0.1:${address.port}`
  const operationLog = []
  const issuedAgentCredentials = []
  let unrelatedInjected = false

  t.after(async () => {
    await webSocketHub.close().catch(() => undefined)
    if (server.listening) {
      server.close()
      await once(server, 'close')
    }
  })

  const edgeFetch = async (requestedUrl, init = {}) => {
    const requested = new URL(requestedUrl)
    let body
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = undefined
      }
    }
    if (requested.pathname.startsWith('/v1/me/devices/') && init.method === 'DELETE') {
      operationLog.push('device-revoke')
    } else if (body?.type === 'task.transition' && body.status === 'cancelled') {
      operationLog.push('task-cancel')
    } else if (body?.type === 'project.transition' && body.status === 'cancelled') {
      operationLog.push('project-cancel')
    } else if (body?.type === 'task.transition') {
      operationLog.push(`task-transition-${body.status}`)
    } else if (typeof body?.type === 'string') {
      operationLog.push(body.type)
    }

    if ((injectUnrelatedWorkerMessage || injectSupersededWorkerMessage) &&
        !unrelatedInjected && body?.type === 'task.create') {
      unrelatedInjected = true
      const workerAgent = [...repository.state.agents.values()].find((agent) => (
        agent.displayName.startsWith('A multi-worker worker1 agent')
      ))
      if (!workerAgent) throw new Error('Expected registered worker Agent before Task create')
      const message = await repository.appendInbox({
        messageId: 'ibx_unrelated_active_0001',
        recipient: { kind: 'agent', id: workerAgent.agentId },
        messageType: 'task.offered',
        payload: {
          protocolVersion: '1.0',
          type: 'task.offered',
          projectId: 'prj_unrelated_000001',
          taskId: 'tsk_unrelated_000001',
          executionId: 'exe_unrelated_000001',
          revision: 1
        },
        createdAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString()
      })
      if (injectSupersededWorkerMessage) {
        const stored = repository.state.inboxes
          .get(`agent:${workerAgent.agentId}`)
          ?.find((candidate) => candidate.messageId === message.messageId)
        if (!stored) throw new Error('Expected injected historical Inbox message')
        stored.disposition = 'superseded'
        stored.supersededAt = NOW.toISOString()
      }
    }

    const localUrl = new URL(`${requested.pathname}${requested.search}`, localBaseUrl)
    let response = await fetch(localUrl, init)
    if (body?.type === 'agent.register' && response.status === 200) {
      const registered = await response.clone().json()
      issuedAgentCredentials.push(registered.deviceCredential)
    }
    if (body?.type === 'inbox.pull' && response.status === 200 && mutateInboxMessage) {
      const responseBody = await response.clone().json()
      for (const message of responseBody.messages ?? []) mutateInboxMessage(message)
      response = new Response(JSON.stringify(responseBody), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    }
    const headers = new Headers(response.headers)
    headers.set('x-sciforge-edge-revision', COMMIT)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  }

  const webSocketFactory = (_requestedUrl, init) => {
    const localWebSocketUrl = new URL('/v1/events', localBaseUrl)
    localWebSocketUrl.protocol = 'ws:'
    return new EdgeWebSocket(new WebSocket(localWebSocketUrl, init), COMMIT, webSocketMode)
  }

  return { repository, edgeFetch, webSocketFactory, operationLog, issuedAgentCredentials }
}

function runOptions(tokenSet, runtime, overrides = {}) {
  return {
    baseUrl: CLOUD_URL,
    ownerTokenFile: tokenSet.files.ownerInitial,
    ownerRevokeTokenFile: tokenSet.files.ownerRevoke,
    workers: tokenSet.workers.map((worker) => ({
      tokenFile: worker.tokenFile,
      revokeTokenFile: worker.revokeTokenFile
    })),
    commit: COMMIT,
    expectedMultiWorkerHarnessSha256: MULTI_WORKER_HARNESS_SHA256,
    expectedIdentityHarnessSha256: IDENTITY_HARNESS_SHA256,
    runId: 'a1'.repeat(12),
    fetch: runtime.edgeFetch,
    webSocketFactory: runtime.webSocketFactory,
    requestTimeoutMs: 2_000,
    webSocketTimeoutMs: 500,
    deadlineMs: 10_000,
    now: () => new Date(NOW),
    ...overrides
  }
}

test('multi-worker harness proves JIT, isolated Devices/Agents, WSS replay, results, and revocation fences', async (t) => {
  const tokenSet = await secureTokenFiles(t)
  const runtime = await startRuntime(t, tokenSet)
  const receipt = await runMultiWorkerAcceptance(runOptions(tokenSet, runtime))

  assert.equal(receipt.status, 'succeeded')
  assert.equal(receipt.type, 'sciforge.a.multi_worker_acceptance.receipt')
  assert.equal(receipt.workerCount, 2)
  assert.equal(receipt.workers.length, 2)
  assert.equal(receipt.oidcPrincipalsDistinct, true)
  for (const worker of receipt.workers) {
    assert.notEqual(receipt.owner.userId, worker.userId)
    assert.notEqual(receipt.owner.deviceId, worker.deviceId)
    assert.notEqual(receipt.owner.agentId, worker.agentId)
    assert.deepEqual(worker.websocket, {
      ready: true,
      pong: true,
      inboxAvailable: true,
      reconnected: true,
      replayPulled: true,
      revocationClosed: true,
      highestSequence: 1
    })
    assert.equal(worker.deviceStatus, 'revoked')
    assert.equal(worker.agentCredentialStatus, 'credential_revoked')
    assert.equal(worker.taskStatus, 'succeeded')
    assert.equal(worker.resultStatus, 'accepted')
    assert.equal(worker.inbox.baselineAckedSequence, 0)
    assert.equal(worker.inbox.ackedThroughSequence, 1)
  }
  assert.equal(receipt.owner.deviceStatus, 'revoked')
  assert.equal(receipt.owner.agentCredentialStatus, 'credential_revoked')
  assert.equal(receipt.projectStatus, 'completed')
  const serialized = JSON.stringify(receipt)
  for (const secret of Object.values(tokenSet.tokens)) assert.equal(serialized.includes(secret), false)
  for (const subject of [tokenSet.subjects.owner, ...tokenSet.subjects.workers]) {
    assert.equal(serialized.includes(subject), false)
  }
  assert.doesNotMatch(serialized, /"(?:iss|sub|aud|azp|exp|nbf|iat|auth_time)"\s*:/u)
  assert.equal(runtime.issuedAgentCredentials.length, 3)
  for (const credential of runtime.issuedAgentCredentials) assert.equal(serialized.includes(credential), false)
  assert.ok(runtime.operationLog.indexOf('inbox.ack') < runtime.operationLog.indexOf('task-transition-accepted'))
  const revokeIndexes = runtime.operationLog
    .map((operation, index) => operation === 'device-revoke' ? index : -1)
    .filter((index) => index >= 0)
  assert.equal(revokeIndexes.length, 3)
})

test('release gate proves one Orchestrator dispatches independent Tasks through Cloud to two Workers', async (t) => {
  const tokenSet = await secureTokenFiles(t, { workerCount: 2 })
  const workerDescriptorFiles = await secureWorkerDescriptorFiles(t, tokenSet)
  const runtime = await startRuntime(t, tokenSet)
  const receipt = await runMultiWorkerAcceptance(runOptions(tokenSet, runtime, {
    workers: undefined,
    workerDescriptorFiles
  }))

  assert.equal(receipt.status, 'succeeded')
  assert.equal(receipt.type, 'sciforge.a.multi_worker_acceptance.receipt')
  assert.equal(receipt.workerCount, 2)
  assert.equal(receipt.workers.length, 2)
  for (const singleWorkerAlias of [
    'worker',
    'websocket',
    'inbox',
    'taskId',
    'executionId',
    'taskStatus',
    'resultProjectRecordId',
    'resultStatus'
  ]) assert.equal(Object.hasOwn(receipt, singleWorkerAlias), false)
  assert.equal(new Set([receipt.owner.userId, ...receipt.workers.map((worker) => worker.userId)]).size, 3)
  assert.equal(new Set([receipt.owner.deviceId, ...receipt.workers.map((worker) => worker.deviceId)]).size, 3)
  assert.equal(new Set([receipt.owner.agentId, ...receipt.workers.map((worker) => worker.agentId)]).size, 3)
  assert.equal(new Set(receipt.workers.map((worker) => worker.taskId)).size, 2)
  assert.equal(new Set(receipt.workers.map((worker) => worker.executionId)).size, 2)
  assert.equal(new Set(receipt.workers.map((worker) => worker.resultProjectRecordId)).size, 2)
  for (const worker of receipt.workers) {
    assert.equal(worker.deviceStatus, 'revoked')
    assert.equal(worker.agentCredentialStatus, 'credential_revoked')
    assert.equal(worker.taskStatus, 'succeeded')
    assert.equal(worker.resultStatus, 'accepted')
    assert.deepEqual(worker.websocket, {
      ready: true,
      pong: true,
      inboxAvailable: true,
      reconnected: true,
      replayPulled: true,
      revocationClosed: true,
      highestSequence: 1
    })
    assert.deepEqual(worker.inbox, {
      baselineAckedSequence: 0,
      ackedThroughSequence: 1,
      supersededSequences: []
    })
  }
  assert.equal(receipt.owner.deviceStatus, 'revoked')
  assert.equal(receipt.owner.agentCredentialStatus, 'credential_revoked')
  assert.equal(receipt.projectStatus, 'completed')
  assert.equal(runtime.issuedAgentCredentials.length, 3)
  assert.equal(runtime.operationLog.filter((operation) => operation === 'device-revoke').length, 3)
  const serialized = JSON.stringify(receipt)
  for (const secret of Object.values(tokenSet.tokens)) assert.equal(serialized.includes(secret), false)
  for (const subject of [tokenSet.subjects.owner, ...tokenSet.subjects.workers]) {
    assert.equal(serialized.includes(subject), false)
  }
  for (const worker of tokenSet.workers) {
    assert.equal(serialized.includes(worker.tokenFile), false)
    assert.equal(serialized.includes(worker.revokeTokenFile), false)
  }
  for (const credential of runtime.issuedAgentCredentials) assert.equal(serialized.includes(credential), false)
  assert.doesNotMatch(serialized, /"(?:iss|sub|aud|azp|exp|nbf|iat|auth_time|label|tokenFile|revokeTokenFile)"\s*:/u)
})

test('both harness hashes are checked before token access and the two OIDC principals must differ before HTTP', async (t) => {
  const tokenSet = await secureTokenFiles(t, { samePrincipal: true })
  let requests = 0
  const runtime = {
    edgeFetch: async () => {
      requests += 1
      throw new Error('HTTP must not be reached')
    },
    webSocketFactory: () => { throw new Error('WebSocket must not be reached') }
  }
  await assert.rejects(
    runMultiWorkerAcceptance(runOptions(tokenSet, runtime)),
    (error) => error.code === 'oidc_principals_not_distinct'
  )
  assert.equal(requests, 0)

  await assert.rejects(
    runMultiWorkerAcceptance(runOptions(tokenSet, runtime, {
      expectedIdentityHarnessSha256: 'f'.repeat(64),
      ownerTokenFile: '/definitely/not/readable'
    })),
    (error) => error.code === 'harness_integrity_rejected'
  )
  assert.equal(requests, 0)
})

test('owner and every Worker must be pairwise distinct before any HTTP or WebSocket', async (t) => {
  const tokenSet = await secureTokenFiles(t, { workerCount: 2 })
  let requests = 0
  let sockets = 0
  const runtime = {
    edgeFetch: async () => {
      requests += 1
      throw new Error('HTTP must not be reached')
    },
    webSocketFactory: () => {
      sockets += 1
      throw new Error('WebSocket must not be reached')
    }
  }
  const repeatedWorker = tokenSet.workers[0]
  await assert.rejects(
    runMultiWorkerAcceptance(runOptions(tokenSet, runtime, {
      workers: [repeatedWorker, repeatedWorker].map((worker) => ({
        tokenFile: worker.tokenFile,
        revokeTokenFile: worker.revokeTokenFile
      }))
    })),
    (error) => error.code === 'oidc_principals_not_distinct'
  )
  assert.equal(requests, 0)
  assert.equal(sockets, 0)
})

test('an unrelated active Worker Inbox message fails closed without crossing the gap and cleanup revokes all Devices first', async (t) => {
  const tokenSet = await secureTokenFiles(t)
  const runtime = await startRuntime(t, tokenSet, { injectUnrelatedWorkerMessage: true })
  await assert.rejects(
    runMultiWorkerAcceptance(runOptions(tokenSet, runtime)),
    (error) => {
      assert.equal(error.code, 'inbox_unrelated_active_gap')
      const affectedWorker = error.safeFacts.workers.find((worker) => worker.inbox.activeGap)
      assert.deepEqual(affectedWorker?.inbox.activeGap, {
        sequence: 1,
        messageType: 'task.offered'
      })
      assert.equal(JSON.stringify(error.safeFacts).includes('prj_unrelated_000001'), false)
      return true
    }
  )
  const revokeIndexes = runtime.operationLog
    .map((operation, index) => operation === 'device-revoke' ? index : -1)
    .filter((index) => index >= 0)
  const taskCancel = runtime.operationLog.indexOf('task-cancel')
  const projectCancel = runtime.operationLog.indexOf('project-cancel')
  assert.equal(revokeIndexes.length, 3)
  assert.ok(taskCancel > revokeIndexes.at(-1))
  assert.ok(projectCancel > revokeIndexes.at(-1))
  const workerCursor = [...runtime.repository.state.inboxCursors.entries()]
    .find(([key]) => key.includes('agent:') && runtime.repository.state.inboxes.get(key)?.some((message) => (
      message.messageId === 'ibx_unrelated_active_0001'
    )))?.[1]
  assert.equal(workerCursor?.ackedSequence, 0)
})

test('a fast Worker enrollment failure waits for a slow Worker before revoke-first cleanup', async (t) => {
  const tokenSet = await secureTokenFiles(t)
  const runtime = await startRuntime(t, tokenSet)
  const liveFetch = runtime.edgeFetch
  runtime.edgeFetch = async (requestedUrl, init = {}) => {
    let body
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = undefined
      }
    }
    if (body?.installationId?.includes('_worker2_') &&
        new URL(requestedUrl).pathname === '/v1/devices') {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    }
    const response = await liveFetch(requestedUrl, init)
    if (body?.type === 'agent.capability_profile.report' &&
        body.profile?.runtimeIds?.includes('sciforge-a-multi-worker-worker1')) {
      return new Response(JSON.stringify({ type: 'malformed_after_commit' }), {
        status: response.status,
        headers: response.headers
      })
    }
    return response
  }

  await assert.rejects(
    runMultiWorkerAcceptance(runOptions(tokenSet, runtime)),
    (error) => error.code === 'response_contract_rejected'
  )
  const snapshot = [...runtime.repository.state.devices.values()]
    .map((device) => [device.deviceId, device.status])
    .sort(([left], [right]) => left.localeCompare(right))
  assert.equal(snapshot.length, 3)
  assert.ok(snapshot.every(([, status]) => status === 'revoked'))
  assert.equal(runtime.operationLog.filter((operation) => operation === 'device-revoke').length, 3)

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
  const afterDelay = [...runtime.repository.state.devices.values()]
    .map((device) => [device.deviceId, device.status])
    .sort(([left], [right]) => left.localeCompare(right))
  assert.deepEqual(afterDelay, snapshot)
})

test('a historical superseded Worker Inbox tombstone is replayed and ACKed in sequence before this run offer', async (t) => {
  const tokenSet = await secureTokenFiles(t)
  const runtime = await startRuntime(t, tokenSet, { injectSupersededWorkerMessage: true })
  const receipt = await runMultiWorkerAcceptance(runOptions(tokenSet, runtime))
  assert.equal(receipt.status, 'succeeded')
  assert.equal(receipt.workers[0].inbox.baselineAckedSequence, 0)
  assert.equal(receipt.workers[0].inbox.ackedThroughSequence, 2)
  assert.deepEqual(receipt.workers[0].inbox.supersededSequences, [1])
  assert.equal(receipt.workers[0].websocket.highestSequence, 2)
})

test('a stale WSS sequence cannot be credited as the notification for this run Task', async (t) => {
  const tokenSet = await secureTokenFiles(t)
  const runtime = await startRuntime(t, tokenSet, {
    injectSupersededWorkerMessage: true,
    webSocketMode: 'stale-inbox-sequence'
  })
  await assert.rejects(
    runMultiWorkerAcceptance(runOptions(tokenSet, runtime)),
    (error) => error.code === 'websocket_target_notification_missing'
  )
  assert.equal(runtime.operationLog.filter((operation) => operation === 'device-revoke').length, 3)
})

test('a superseded target offer cannot satisfy the current Worker Task gate', async (t) => {
  const tokenSet = await secureTokenFiles(t)
  const runtime = await startRuntime(t, tokenSet, {
    mutateInboxMessage: (message) => {
      if (message?.payload?.type !== 'task.offered') return
      message.status = 'superseded'
      message.disposition = 'superseded'
      message.supersededAt = NOW.toISOString()
    }
  })
  await assert.rejects(
    runMultiWorkerAcceptance(runOptions(tokenSet, runtime)),
    (error) => error.code === 'inbox_target_not_active'
  )
  assert.equal(runtime.operationLog.filter((operation) => operation === 'device-revoke').length, 3)
})

test('an invalid Inbox status and disposition pairing fails closed', async (t) => {
  const tokenSet = await secureTokenFiles(t)
  const runtime = await startRuntime(t, tokenSet, {
    mutateInboxMessage: (message) => {
      if (message?.payload?.type !== 'task.offered') return
      message.disposition = 'superseded'
      message.supersededAt = NOW.toISOString()
    }
  })
  await assert.rejects(
    runMultiWorkerAcceptance(runOptions(tokenSet, runtime)),
    (error) => error.code === 'response_contract_rejected'
  )
  assert.equal(runtime.operationLog.filter((operation) => operation === 'device-revoke').length, 3)
})

test('a superseded Result submission cannot count toward Coordinator completion', async (t) => {
  const tokenSet = await secureTokenFiles(t)
  let mutated = false
  const runtime = await startRuntime(t, tokenSet, {
    mutateInboxMessage: (message) => {
      if (mutated || message?.payload?.type !== 'project_record.submitted') return
      mutated = true
      message.status = 'superseded'
      message.disposition = 'superseded'
      message.supersededAt = NOW.toISOString()
    }
  })
  await assert.rejects(
    runMultiWorkerAcceptance(runOptions(tokenSet, runtime)),
    (error) => error.code === 'inbox_target_not_active'
  )
  assert.equal(mutated, true)
  assert.equal(runtime.operationLog.filter((operation) => operation === 'device-revoke').length, 3)
})

test('malformed WSS data fails closed and cleanup remains revoke-first', async (t) => {
  const tokenSet = await secureTokenFiles(t)
  const runtime = await startRuntime(t, tokenSet, { webSocketMode: 'malformed-after-ready' })
  await assert.rejects(
    runMultiWorkerAcceptance(runOptions(tokenSet, runtime)),
    (error) => error.code === 'websocket_protocol_rejected'
  )
  const firstDomainCleanup = runtime.operationLog.findIndex((operation) => (
    operation === 'task-cancel' || operation === 'project-cancel'
  ))
  const revokesBeforeDomain = runtime.operationLog
    .slice(0, firstDomainCleanup < 0 ? undefined : firstDomainCleanup)
    .filter((operation) => operation === 'device-revoke')
  assert.equal(revokesBeforeDomain.length, 3)
})

test('missing WSS ready is bounded and revokes every fresh Device', async (t) => {
  const tokenSet = await secureTokenFiles(t)
  const runtime = await startRuntime(t, tokenSet, { webSocketMode: 'timeout-ready' })
  await assert.rejects(
    runMultiWorkerAcceptance(runOptions(tokenSet, runtime, { webSocketTimeoutMs: 30 })),
    (error) => error.code === 'websocket_timeout'
  )
  assert.equal(runtime.operationLog.filter((operation) => operation === 'device-revoke').length, 3)
})

test('CLI configuration accepts repeated file-backed Worker descriptors and both expected hashes', () => {
  assert.throws(() => parseMultiWorkerAcceptanceConfiguration(['--token', 'inline-secret']), {
    code: 'configuration_rejected'
  })
  const multi = parseMultiWorkerAcceptanceConfiguration([
    '--base-url', CLOUD_URL,
    '--owner-token-file', '/safe/owner-initial',
    '--owner-revoke-token-file', '/safe/owner-revoke',
    '--worker-descriptor-file', '/safe/worker-1.json',
    '--worker-descriptor-file', '/safe/worker-2.json',
    '--commit', COMMIT,
    '--expected-multi-worker-harness-sha256', MULTI_WORKER_HARNESS_SHA256,
    '--expected-identity-harness-sha256', IDENTITY_HARNESS_SHA256
  ], {})
  assert.deepEqual(multi.workerDescriptorFiles, ['/safe/worker-1.json', '/safe/worker-2.json'])
  assert.equal(Object.isFrozen(multi.workerDescriptorFiles), true)
  assert.equal(multi.expectedMultiWorkerHarnessSha256, MULTI_WORKER_HARNESS_SHA256)
  assert.equal(multi.expectedIdentityHarnessSha256, IDENTITY_HARNESS_SHA256)
  assert.throws(() => parseMultiWorkerAcceptanceConfiguration([
    '--base-url', CLOUD_URL,
    '--owner-token-file', '/safe/owner-initial',
    '--owner-revoke-token-file', '/safe/owner-revoke',
    '--worker-descriptor-file', '/safe/only-one.json',
    '--commit', COMMIT,
    '--expected-multi-worker-harness-sha256', MULTI_WORKER_HARNESS_SHA256,
    '--expected-identity-harness-sha256', IDENTITY_HARNESS_SHA256
  ], {}), { code: 'configuration_rejected' })
  assert.throws(() => parseMultiWorkerAcceptanceConfiguration([], {
    SCIFORGE_CLOUD_BASE_URL: CLOUD_URL,
    SCIFORGE_OWNER_OIDC_ACCESS_TOKEN_FILE: '/safe/owner-initial',
    SCIFORGE_OWNER_OIDC_REVOKE_TOKEN_FILE: '/safe/owner-revoke',
    SCIFORGE_WORKER_DESCRIPTOR_FILES_JSON: JSON.stringify(
      Array.from({ length: 9 }, (_, index) => `/safe/worker-${index + 1}.json`)
    ),
    SCIFORGE_COLLAB_CONTRACT_COMMIT: COMMIT,
    SCIFORGE_MULTI_WORKER_ACCEPTANCE_HARNESS_SHA256: MULTI_WORKER_HARNESS_SHA256,
    SCIFORGE_IDENTITY_ACCEPTANCE_HARNESS_SHA256: IDENTITY_HARNESS_SHA256
  }), { code: 'configuration_rejected' })
})

test('Worker descriptors fail closed unless exact, absolute, current-user-owned 0600 regular files', async (t) => {
  const tokenSet = await secureTokenFiles(t, { workerCount: 2 })
  const valid = await secureWorkerDescriptorFiles(t, tokenSet)
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-a-invalid-worker-descriptors-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const invalidMode = join(directory, 'mode.json')
  const unexpectedKey = join(directory, 'extra.json')
  const linked = join(directory, 'linked.json')
  const descriptor = JSON.stringify({
    accessTokenFile: tokenSet.workers[0].tokenFile,
    revokeTokenFile: tokenSet.workers[0].revokeTokenFile
  })
  await writeFile(invalidMode, descriptor, { mode: 0o644 })
  await chmod(invalidMode, 0o644)
  await writeFile(unexpectedKey, JSON.stringify({
    accessTokenFile: tokenSet.workers[0].tokenFile,
    revokeTokenFile: tokenSet.workers[0].revokeTokenFile,
    label: 'must-not-be-accepted'
  }), { mode: 0o600 })
  await chmod(unexpectedKey, 0o600)
  await symlink(valid[0], linked)
  const runtime = {
    edgeFetch: async () => { throw new Error('network must not be reached') },
    webSocketFactory: () => { throw new Error('network must not be reached') }
  }
  for (const rejected of [invalidMode, unexpectedKey, linked, 'relative-worker.json']) {
    await assert.rejects(
      runMultiWorkerAcceptance(runOptions(tokenSet, runtime, {
        workers: undefined,
        workerDescriptorFiles: [rejected, valid[1]]
      })),
      (error) => error.code === 'worker_descriptor_rejected'
    )
  }
})

test('formal gate rejects a single Worker on every invocation path', async (t) => {
  const tokenSet = await secureTokenFiles(t, { workerCount: 1 })
  let requests = 0
  const runtime = {
    edgeFetch: async () => {
      requests += 1
      throw new Error('network must not be reached')
    },
    webSocketFactory: () => { throw new Error('network must not be reached') }
  }
  await assert.rejects(
    runMultiWorkerAcceptance(runOptions(tokenSet, runtime)),
    (error) => error.code === 'configuration_rejected' && error.safeFacts.field === 'worker-count'
  )
  assert.equal(requests, 0)
})

test('strict local WebSocket parser accepts only the five frozen message shapes and their bounds', () => {
  const timestamp = NOW.toISOString()
  const messages = [
    { protocolVersion: '1.0', type: 'connection.ready', connectionId: 'connection-1', connectedAt: timestamp },
    { protocolVersion: '1.0', type: 'inbox.available', recipientType: 'agent', highestSequence: 1 },
    {
      protocolVersion: '1.0',
      type: 'connection.error',
      error: {
        protocolVersion: '1.0',
        type: 'error',
        traceId: `trc_${'a'.repeat(12)}`,
        code: 'validation_error',
        category: 'validation',
        httpStatus: 400,
        retryable: false,
        message: 'Rejected'
      }
    },
    { protocolVersion: '1.0', type: 'connection.ping', nonce: 'ping-1', sentAt: timestamp },
    { protocolVersion: '1.0', type: 'connection.pong', nonce: 'pong-1', sentAt: timestamp }
  ]
  for (const message of messages) assert.equal(parseStrictWebSocketMessage(message), message)
  assert.equal(parseStrictWebSocketMessage({ ...messages[0], unexpected: true }), undefined)
  assert.equal(parseStrictWebSocketMessage({ ...messages[1], highestSequence: 0 }), undefined)
  assert.equal(parseStrictWebSocketMessage({ ...messages[3], nonce: 'n'.repeat(513) }), undefined)
  assert.equal(parseStrictWebSocketMessage({
    ...messages[4],
    sentAt: '2026-02-30T03:00:00.000Z'
  }), undefined)
  assert.equal(parseStrictWebSocketMessage({
    ...messages[2],
    error: { ...messages[2].error, retryable: true }
  }), undefined)
})

test('multi-worker harness help runs from a fresh source copy without contracts dist or workspace package links', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sciforge-a-multi-worker-fresh-source-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const scriptsDirectory = join(root, 'scripts')
  const modulesDirectory = join(root, 'node_modules')
  await mkdir(scriptsDirectory, { recursive: true })
  await mkdir(modulesDirectory, { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  const multiWorkerPath = join(scriptsDirectory, 'collaboration-a-multi-worker-acceptance.mjs')
  await copyFile(new URL('./collaboration-a-multi-worker-acceptance.mjs', import.meta.url), multiWorkerPath)
  await copyFile(
    new URL('./collaboration-a-identity-acceptance.mjs', import.meta.url),
    join(scriptsDirectory, 'collaboration-a-identity-acceptance.mjs')
  )
  const wsRoot = await realpath(dirname(fileURLToPath(import.meta.resolve('ws'))))
  await symlink(wsRoot, join(modulesDirectory, 'ws'), 'dir')
  const environment = { ...process.env }
  for (const key of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_DEBUG',
    'NODE_DEBUG_NATIVE',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_USE_ENV_PROXY'
  ]) delete environment[key]
  const { stdout, stderr } = await execFileAsync(process.execPath, [multiWorkerPath, '--help'], {
    cwd: root,
    env: environment,
    timeout: 5_000
  })
  assert.match(stdout, /Usage: node scripts\/collaboration-a-multi-worker-acceptance\.mjs/u)
  assert.equal(stderr, '')
  const source = await readFile(multiWorkerPath, 'utf8')
  assert.doesNotMatch(source, /@sciforge\/collaboration-contracts/u)
})
