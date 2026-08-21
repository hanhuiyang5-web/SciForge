import assert from 'node:assert/strict'
import { createHash, createPublicKey, randomBytes, verify as verifyBytes } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  canonicalEnrollmentBytes as canonicalContractEnrollmentBytes,
  createCollaborationError,
  deviceCreateRequestSchema,
  deviceEnrollmentCreateRequestSchema,
  deviceEnrollmentCreateResponseSchema,
  deviceListResponseSchema,
  deviceResponseSchema,
  deviceRevokeRequestSchema,
  externalIdentityListResponseSchema,
  meResponseSchema,
  restRequestSchema,
  restResponseSchema,
  zulipBindingBeginRequestSchema,
  zulipBindingBeginResponseSchema,
  zulipBindingConfirmRequestSchema
} from '../packages/collaboration-contracts/src/index.ts'

import {
  parseIdentityAcceptanceConfiguration,
  readSecureOidcTokenFile,
  runIdentityAcceptance
} from './collaboration-a-identity-acceptance.mjs'

const COMMIT = '1'.repeat(40)
const RUN_ID = 'a1'.repeat(12)
const NOW = new Date('2026-08-20T03:00:00.000Z')
const ISSUER = 'https://login-test.sciforge.cn/realms/SciForge'
const BASE_URL = 'https://cloud-test.sciforge.cn'
const HARNESS_SHA256 = createHash('sha256')
  .update(await readFile(new URL('./collaboration-a-identity-acceptance.mjs', import.meta.url)))
  .digest('hex')
const DANGEROUS_NETWORK_ENV_KEYS = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_DEBUG',
  'NODE_DEBUG_NATIVE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_USE_ENV_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE'
]

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function oidcBearer({
  subject = 'a-identity-owner',
  authTimeOffset = -5,
  expiresIn = 600,
  claims: claimOverrides = {}
} = {}) {
  const nowSeconds = Math.floor(NOW.getTime() / 1_000)
  return [
    encodedJson({ alg: 'RS256', kid: 'a-identity-test-key', typ: 'JWT' }),
    encodedJson({
      iss: ISSUER,
      sub: subject,
      aud: ['sciforge-cloud-api'],
      azp: 'sciforge-desktop',
      exp: nowSeconds + expiresIn,
      nbf: nowSeconds - 10,
      iat: nowSeconds - 5,
      auth_time: nowSeconds + authTimeOffset,
      ...claimOverrides
    }),
    randomBytes(256).toString('base64url')
  ].join('.')
}

async function secureTokenFile(directory, name, value) {
  const filename = join(directory, name)
  await writeFile(filename, `${value}\n`, { mode: 0o600 })
  await chmod(filename, 0o600)
  return filename
}

function jsonResponse(body, status = 200, edgeRevision = COMMIT) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-sciforge-edge-revision': edgeRevision
    }
  })
}

function schemaResponse(schema, body, status = 200, edgeRevision = COMMIT) {
  return jsonResponse(schema.parse(body), status, edgeRevision)
}

function restResponse(request, body, status = 200, edgeRevision = COMMIT) {
  return schemaResponse(restResponseSchema, {
    protocolVersion: '1.0',
    requestId: request.requestId,
    ...body
  }, status, edgeRevision)
}

function restErrorResponse(requestId, code) {
  return schemaResponse(restResponseSchema, {
    protocolVersion: '1.0',
    type: 'rest.error',
    requestId,
    error: createCollaborationError(code, `Expected ${code} test boundary.`, {
      requestId,
      traceId: code === 'credential_revoked'
        ? 'trc_identity_acceptance_0002'
        : 'trc_identity_acceptance_0001'
    })
  }, 401)
}

function mockIdentityApi({
  initialBearer,
  revokeBearer,
  agentBearer,
  bindingCode,
  committedRunningFailure,
  hangCleanupTaskGet = false,
  rejectRevokeMe = false
}) {
  const calls = []
  const ids = Object.freeze({
    userId: 'usr_identity_acceptance_0001',
    identityId: 'oid_identity_acceptance_0001',
    enrollmentId: 'enr_identity_acceptance_0001',
    deviceId: 'dev_identity_acceptance_0001',
    agentId: 'agt_identity_acceptance_0001',
    projectId: 'prj_identity_acceptance_0001',
    taskId: 'tsk_identity_acceptance_0001',
    executionId: 'exe_identity_acceptance_0001',
    resultRecordId: 'rec_identity_acceptance_0001',
    bindingRequestId: 'zbr_identity_acceptance_0001'
  })
  const enrollment = Object.freeze({
    nonce: randomBytes(32).toString('base64url'),
    expiresAt: '2026-08-20T03:05:00.000Z'
  })
  let deviceStatus = 'not_created'
  let projectStatus = 'not_created'
  let projectRevision = 0
  let taskStatus = 'not_created'
  let taskRevision = 0
  let inboxAckedSequence = 0
  let storedDeviceRequest
  const timestamp = NOW.toISOString()
  const criterionId = 'cri_identity_acceptance_0001'
  const budget = Object.freeze({ maxTasks: 1, maxTasksPerRound: 1, maxCoordinationRounds: 1, maxTaskRetries: 0 })
  const requiredCapabilities = Object.freeze({
    capabilityIds: [], vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: []
  })

  const deviceEntity = (status = deviceStatus) => ({
    schemaVersion: 1,
    type: 'device',
    deviceId: ids.deviceId,
    userId: ids.userId,
    installationId: storedDeviceRequest.installationId,
    displayName: storedDeviceRequest.displayName,
    platform: storedDeviceRequest.platform,
    publicKeyJwk: storedDeviceRequest.publicKeyJwk,
    capabilitySummary: storedDeviceRequest.capabilitySummary,
    status,
    ...(status === 'revoked' ? { revokedAt: timestamp } : {}),
    revision: status === 'active' ? 1 : 2,
    createdAt: timestamp,
    updatedAt: timestamp
  })
  const agentEntity = (connectionStatus, revision) => ({
    schemaVersion: 1,
    type: 'agent_node',
    agentId: ids.agentId,
    deviceId: ids.deviceId,
    ownerUserId: ids.userId,
    displayName: 'A identity acceptance agent',
    nodeType: 'desktop',
    capabilities: [],
    lifecycleStatus: 'active',
    connectionStatus,
    credentialVersion: 1,
    ...(connectionStatus === 'online' ? { lastSeenAt: timestamp } : {}),
    revision,
    createdAt: timestamp,
    updatedAt: timestamp
  })
  const projectEntity = (status, revision) => ({
    schemaVersion: 1,
    type: 'project',
    projectId: ids.projectId,
    ownerUserId: ids.userId,
    displayName: `A identity acceptance ${RUN_ID}`,
    goal: 'Verify the public identity and basic Task contract.',
    memberUserIds: [ids.userId],
    coordinatorAgentId: ids.agentId,
    status,
    budget,
    revision,
    createdAt: timestamp,
    updatedAt: timestamp
  })
  const taskEntity = (status, revision) => ({
    schemaVersion: 1,
    type: 'task',
    taskId: ids.taskId,
    projectId: ids.projectId,
    executionId: ids.executionId,
    createdByCoordinatorAgentId: ids.agentId,
    assigneeAgentId: ids.agentId,
    assigneeUserId: ids.userId,
    title: 'A identity acceptance Task',
    objective: 'Persist one metadata-only Task through the public API.',
    completionCriteria: [{
      criterionId,
      text: 'The Task is readable through the public API.'
    }],
    dependencyTaskIds: [],
    requiredCapabilities,
    resourceRefIds: [],
    authorizationRequirements: [],
    status,
    attempt: 1,
    maxRetries: 0,
    ...(status === 'succeeded' ? {
      resultSummary: 'A identity acceptance Task completed.',
      resultProjectRecordId: ids.resultRecordId
    } : {}),
    ...(['succeeded', 'cancelled'].includes(status) ? { completedAt: timestamp } : {}),
    revision,
    createdAt: timestamp,
    updatedAt: timestamp
  })
  const projectRecordEntity = (status, revision) => ({
    schemaVersion: 1,
    type: 'project_record',
    projectRecordId: ids.resultRecordId,
    projectId: ids.projectId,
    kind: 'task_result',
    status,
    body: 'A identity acceptance Task completed.',
    authorUserId: ids.userId,
    authorAgentId: ids.agentId,
    sourceTaskId: ids.taskId,
    sourceExecutionId: ids.executionId,
    sourceRevision: 4,
    criterionEvidence: [],
    resourceRefIds: [],
    logSummary: null,
    acceptedByUserId: status === 'accepted' ? ids.userId : null,
    acceptedByAgentId: null,
    acceptedAt: status === 'accepted' ? timestamp : null,
    revision,
    createdAt: timestamp,
    updatedAt: timestamp
  })

  const fetch = async (url, init) => {
    const parsed = new URL(url)
    assert.equal(parsed.origin, BASE_URL)
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    const headers = new Headers(init.headers)
    const bearer = headers.get('authorization')?.replace(/^Bearer /u, '')
    const body = init.body ? JSON.parse(init.body) : undefined
    if (body?.idempotencyKey) assert.equal(headers.get('idempotency-key'), body.idempotencyKey)
    calls.push({ method: init.method, path: parsed.pathname, bearer, body })

    if (parsed.pathname === '/v1/me' && init.method === 'GET') {
      assert.ok([initialBearer, revokeBearer].includes(bearer))
      if (bearer === revokeBearer && rejectRevokeMe) {
        return restErrorResponse('req_identity_acceptance_revoke_preflight', 'authentication_required')
      }
      return schemaResponse(meResponseSchema, {
        schemaVersion: 1,
        type: 'me',
        userId: ids.userId,
        displayName: 'A Identity Owner',
        oidcIdentityId: ids.identityId,
        issuer: ISSUER,
        status: 'active',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp
      })
    }
    if (parsed.pathname === '/v1/me/external-identities' && init.method === 'GET') {
      assert.equal(bearer, initialBearer)
      return schemaResponse(externalIdentityListResponseSchema, { identities: [] })
    }
    if (parsed.pathname === '/v1/integrations/zulip/bindings' && init.method === 'POST') {
      assert.equal(bearer, initialBearer)
      const request = zulipBindingBeginRequestSchema.parse(body)
      assert.equal(request.realmUrl, 'https://chat.sciforge.cn')
      return schemaResponse(zulipBindingBeginResponseSchema, {
        bindingRequestId: ids.bindingRequestId,
        bindingCode,
        expiresAt: enrollment.expiresAt
      })
    }
    if (parsed.pathname === '/v1/integrations/zulip/bindings/confirm' && init.method === 'POST') {
      assert.equal(bearer, undefined)
      const request = zulipBindingConfirmRequestSchema.parse(body)
      assert.equal(request.bindingCode, bindingCode)
      return restErrorResponse(`req_aid_zulip_${RUN_ID}`, 'authentication_required')
    }
    if (parsed.pathname === '/v1/device-enrollments' && init.method === 'POST') {
      assert.equal(bearer, initialBearer)
      const request = deviceEnrollmentCreateRequestSchema.parse(body)
      assert.match(request.installationId, /^ins_/u)
      return schemaResponse(deviceEnrollmentCreateResponseSchema, {
        enrollmentId: ids.enrollmentId,
        nonce: enrollment.nonce,
        expiresAt: enrollment.expiresAt
      })
    }
    if (parsed.pathname === '/v1/devices' && init.method === 'POST') {
      assert.equal(bearer, initialBearer)
      const request = deviceCreateRequestSchema.parse(body)
      assert.equal(request.enrollmentId, ids.enrollmentId)
      assert.equal(request.nonce, enrollment.nonce)
      assert.deepEqual(request.capabilitySummary, [])
      assert.deepEqual(Object.keys(request.publicKeyJwk).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x'])
      const publicKey = createPublicKey({ key: request.publicKeyJwk, format: 'jwk' })
      assert.equal(verifyBytes(null, canonicalContractEnrollmentBytes({
        enrollmentId: ids.enrollmentId,
        nonce: enrollment.nonce,
        userId: ids.userId,
        installationId: request.installationId,
        expiresAt: enrollment.expiresAt
      }), publicKey, Buffer.from(request.signature, 'base64url')), true)
      storedDeviceRequest = request
      deviceStatus = 'active'
      return schemaResponse(deviceResponseSchema, { device: deviceEntity('active') })
    }
    if (parsed.pathname === '/v1/me/devices' && init.method === 'GET') {
      assert.equal(bearer, deviceStatus === 'active' ? initialBearer : revokeBearer)
      return schemaResponse(deviceListResponseSchema, { devices: [deviceEntity()] })
    }
    if (parsed.pathname === `/v1/me/devices/${ids.deviceId}` && init.method === 'DELETE') {
      assert.equal(bearer, revokeBearer)
      const request = deviceRevokeRequestSchema.parse(body)
      assert.deepEqual(request.deviceId, ids.deviceId)
      deviceStatus = 'revoked'
      return schemaResponse(deviceResponseSchema, { device: deviceEntity('revoked') })
    }
    if (parsed.pathname !== '/v1/commands' || init.method !== 'POST') {
      throw new Error('Unexpected mock API route')
    }
    const command = restRequestSchema.parse(body)
    switch (command.type) {
      case 'agent.register':
        assert.equal(bearer, initialBearer)
        assert.equal(command.deviceId, ids.deviceId)
        assert.equal(Object.hasOwn(command, 'ownerUserId'), false)
        return restResponse(command, {
          type: 'agent.registered',
          agent: agentEntity('offline', 1),
          deviceCredential: agentBearer
        })
      case 'agent.heartbeat':
        if (deviceStatus === 'revoked') {
          assert.equal(bearer, agentBearer)
          return restErrorResponse(command.requestId, 'credential_revoked')
        }
        assert.equal(bearer, agentBearer)
        assert.equal(command.expectedRevision, 1)
        return restResponse(command, {
          type: 'rest.entity',
          entity: agentEntity('online', 2)
        })
      case 'agent.capability_profile.report':
        assert.equal(bearer, agentBearer)
        assert.equal(command.expectedProfileRevision, 0)
        assert.deepEqual(command.profile.capabilities, [])
        return restResponse(command, {
          type: 'rest.entity',
          entity: {
            schemaVersion: 1,
            type: 'agent_capability_profile',
            ...command.profile,
            gpu: [],
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp
          }
        })
      case 'project.create':
        assert.equal(bearer, initialBearer)
        assert.deepEqual(command.memberUserIds, [ids.userId])
        assert.equal(command.coordinatorAgentId, ids.agentId)
        projectStatus = 'active'
        projectRevision = 1
        return restResponse(command, {
          type: 'rest.entity',
          entity: projectEntity(projectStatus, projectRevision)
        })
      case 'task.create':
        assert.equal(bearer, initialBearer)
        assert.equal(command.expectedRevision, 1)
        assert.equal(command.assigneeAgentId, ids.agentId)
        assert.deepEqual(command.resourceRefIds, [])
        projectRevision = 2
        taskStatus = 'offered'
        taskRevision = 1
        return restResponse(command, {
          type: 'rest.entity',
          entity: taskEntity(taskStatus, taskRevision)
        })
      case 'inbox.pull':
        assert.equal(bearer, agentBearer)
        assert.equal(command.recipientType, 'agent')
        assert.equal(command.afterSequence, 0)
        return restResponse(command, {
          type: 'rest.inbox_page',
          messages: [
            {
              schemaVersion: 1,
              type: 'inbox_message',
              inboxMessageId: 'ibx_identity_acceptance_project_0001',
              sequence: 1,
              status: 'pending',
              disposition: 'active',
              createdAt: timestamp,
              recipientType: 'agent',
              recipientAgentId: ids.agentId,
              payload: {
                protocolVersion: '1.0',
                type: 'project.started',
                projectId: ids.projectId,
                revision: 1
              }
            },
            {
              schemaVersion: 1,
              type: 'inbox_message',
              inboxMessageId: 'ibx_identity_acceptance_0001',
              sequence: 2,
              status: 'pending',
              disposition: 'active',
              createdAt: timestamp,
              recipientType: 'agent',
              recipientAgentId: ids.agentId,
              payload: {
                protocolVersion: '1.0',
                type: 'task.offered',
                projectId: ids.projectId,
                taskId: ids.taskId,
                executionId: ids.executionId,
                revision: 1
              }
            }
          ],
          ackedSequence: inboxAckedSequence,
          nextSequence: 3
        })
      case 'inbox.ack': {
        assert.equal(bearer, agentBearer)
        const expectedMessageIds = new Map([
          [1, 'ibx_identity_acceptance_project_0001'],
          [2, 'ibx_identity_acceptance_0001']
        ])
        assert.equal(command.sequence, inboxAckedSequence + 1)
        assert.equal(command.inboxMessageId, expectedMessageIds.get(command.sequence))
        inboxAckedSequence = command.sequence
        return restResponse(command, {
          type: 'inbox.acked',
          ackedSequence: inboxAckedSequence,
          nextSequence: 3
        })
      }
      case 'task.get':
        assert.ok([initialBearer, revokeBearer].includes(bearer))
        if (hangCleanupTaskGet && command.requestId.startsWith('req_aid_90_')) {
          return new Promise((resolve, reject) => {
            const keepAlive = setTimeout(() => reject(new Error('simulated cleanup hang exceeded test guard')), 1_000)
            const rejectOnAbort = () => {
              clearTimeout(keepAlive)
              reject(new Error('simulated cleanup timeout'))
            }
            if (init.signal.aborted) rejectOnAbort()
            else init.signal.addEventListener('abort', rejectOnAbort, { once: true })
          })
        }
        return restResponse(command, {
          type: 'rest.entity',
          entity: taskEntity(taskStatus, taskRevision)
        })
      case 'task.transition':
        if (command.status === 'accepted') {
          assert.equal(bearer, agentBearer)
          assert.equal(command.expectedRevision, 1)
          taskStatus = 'accepted'
          taskRevision = 2
          return restResponse(command, {
            type: 'rest.entity',
            entity: taskEntity(taskStatus, taskRevision)
          })
        }
        if (command.status === 'running') {
          assert.equal(bearer, agentBearer)
          assert.equal(command.expectedRevision, 2)
          taskStatus = 'running'
          taskRevision = 3
          if (committedRunningFailure === 'malformed-body') {
            return jsonResponse({
              protocolVersion: '1.0',
              type: 'rest.entity',
              requestId: command.requestId,
              entity: { type: 'task', status: taskStatus }
            })
          }
          return restResponse(command, {
            type: 'rest.entity',
            entity: taskEntity(taskStatus, taskRevision)
          }, 200, committedRunningFailure === 'edge-revision'
            ? '0'.repeat(40)
            : COMMIT)
        }
        if (command.status === 'succeeded') {
          assert.equal(bearer, agentBearer)
          assert.equal(command.expectedRevision, 3)
          assert.deepEqual(command.result, {
            summary: 'A identity acceptance Task completed.', criterionEvidence: [], resourceRefIds: []
          })
          taskStatus = 'succeeded'
          taskRevision = 4
          return restResponse(command, {
            type: 'rest.entity',
            entity: taskEntity(taskStatus, taskRevision)
          })
        }
        assert.equal(command.status, 'cancelled')
        assert.equal(bearer, initialBearer)
        assert.equal(command.expectedRevision, taskRevision)
        taskStatus = 'cancelled'
        taskRevision += 1
        return restResponse(command, {
          type: 'rest.entity',
          entity: taskEntity(taskStatus, taskRevision)
        })
      case 'project_record.get':
        assert.equal(bearer, revokeBearer)
        assert.equal(command.projectRecordId, ids.resultRecordId)
        return restResponse(command, {
          type: 'rest.entity',
          entity: projectRecordEntity('proposed', 1)
        })
      case 'project_record.accept':
        assert.equal(bearer, revokeBearer)
        assert.equal(command.projectRecordId, ids.resultRecordId)
        assert.equal(command.expectedRevision, 1)
        assert.equal(command.decision, 'accepted')
        return restResponse(command, {
          type: 'rest.entity',
          entity: projectRecordEntity('accepted', 2)
        })
      case 'project.get':
        assert.ok([initialBearer, revokeBearer].includes(bearer))
        return restResponse(command, {
          type: 'rest.entity',
          entity: projectEntity(projectStatus, projectRevision)
        })
      case 'project.transition':
        assert.equal(bearer, command.status === 'completed' ? revokeBearer : initialBearer)
        assert.equal(command.expectedRevision, projectRevision)
        assert.ok(['completed', 'cancelled'].includes(command.status))
        projectStatus = command.status
        projectRevision += 1
        return restResponse(command, {
          type: 'rest.entity',
          entity: projectEntity(projectStatus, projectRevision)
        })
      default:
        throw new Error('Unexpected mock command')
    }
  }
  return {
    fetch,
    calls,
    ids,
    snapshot: () => ({ deviceStatus, projectStatus, projectRevision, taskStatus, taskRevision })
  }
}

test('secure token reader accepts only an owned 0600 regular non-symlink file', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-a-identity-token-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const bearer = oidcBearer()
  const secure = await secureTokenFile(directory, 'secure.jwt', bearer)
  assert.equal(await readSecureOidcTokenFile(secure), bearer)

  const permissive = await secureTokenFile(directory, 'permissive.jwt', bearer)
  await chmod(permissive, 0o640)
  await assert.rejects(readSecureOidcTokenFile(permissive), { code: 'token_file_rejected' })

  const linked = join(directory, 'linked.jwt')
  await symlink(secure, linked)
  await assert.rejects(readSecureOidcTokenFile(linked), { code: 'token_file_rejected' })
  await assert.rejects(readSecureOidcTokenFile('relative.jwt'), { code: 'token_file_rejected' })
})

test('A-only public API harness completes identity, accepted Task result, Project completion, Device cascade, and optional Zulip fail-closed proof', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-a-identity-flow-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const initialBearer = oidcBearer({ authTimeOffset: -30, claims: { nbf: undefined } })
  const revokeBearer = oidcBearer({ authTimeOffset: -5, claims: { nbf: undefined } })
  const agentBearer = `agent_${randomBytes(32).toString('base64url')}`
  const bindingCode = `SF-${randomBytes(8).toString('hex').toUpperCase()}`
  const tokenFile = await secureTokenFile(directory, 'initial.jwt', initialBearer)
  const revokeTokenFile = await secureTokenFile(directory, 'revoke.jwt', revokeBearer)
  const api = mockIdentityApi({ initialBearer, revokeBearer, agentBearer, bindingCode })

  const receipt = await runIdentityAcceptance({
    baseUrl: BASE_URL,
    tokenFile,
    revokeTokenFile,
    commit: COMMIT,
    expectedHarnessSha256: HARNESS_SHA256,
    runId: RUN_ID,
    now: () => new Date(NOW),
    fetch: api.fetch,
    platform: 'linux',
    architecture: 'x64',
    zulipRealmUrl: 'https://chat.sciforge.cn'
  })

  assert.deepEqual(receipt, {
    type: 'sciforge.a.identity_acceptance.receipt',
    commit: COMMIT,
    harnessSha256: HARNESS_SHA256,
    runId: RUN_ID,
    status: 'succeeded',
    userId: api.ids.userId,
    oidcIdentityId: api.ids.identityId,
    deviceId: api.ids.deviceId,
    deviceStatus: 'revoked',
    agentId: api.ids.agentId,
    agentCredentialStatus: 'credential_revoked',
    projectId: api.ids.projectId,
    projectStatus: 'completed',
    taskId: api.ids.taskId,
    executionId: api.ids.executionId,
    taskStatus: 'succeeded',
    resultProjectRecordId: api.ids.resultRecordId,
    resultStatus: 'accepted',
    zulipBindingRequestId: api.ids.bindingRequestId,
    zulipConfirmStatus: 'authentication_required'
  })
  const serialized = JSON.stringify(receipt)
  for (const forbidden of [initialBearer, revokeBearer, agentBearer, bindingCode]) {
    assert.equal(serialized.includes(forbidden), false)
  }
  const inboxAcknowledgements = api.calls.filter((call) => call.body?.type === 'inbox.ack')
  assert.deepEqual(inboxAcknowledgements.map((call) => ({
    inboxMessageId: call.body.inboxMessageId,
    sequence: call.body.sequence,
    bearer: call.bearer
  })), [
    {
      inboxMessageId: 'ibx_identity_acceptance_project_0001',
      sequence: 1,
      bearer: agentBearer
    },
    {
      inboxMessageId: 'ibx_identity_acceptance_0001',
      sequence: 2,
      bearer: agentBearer
    }
  ])
  const secondAcknowledgementIndex = api.calls.indexOf(inboxAcknowledgements[1])
  const taskAcceptIndex = api.calls.findIndex((call) =>
    call.body?.type === 'task.transition' && call.body.status === 'accepted')
  assert.ok(secondAcknowledgementIndex >= 0 && secondAcknowledgementIndex < taskAcceptIndex)
  const oldAgentProbe = api.calls.at(-1)
  assert.equal(oldAgentProbe.body.type, 'agent.heartbeat')
  assert.equal(oldAgentProbe.bearer, agentBearer)
})

test('cleanup re-reads committed Task revision before cancelling Task, Project, and Device after a rejected mutation response', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-a-identity-cleanup-'))
  context.after(() => rm(directory, { recursive: true, force: true }))

  for (const failure of [
    { mode: 'edge-revision', code: 'live_commit_mismatch' },
    { mode: 'malformed-body', code: 'response_contract_rejected' }
  ]) {
    const initialBearer = oidcBearer({ authTimeOffset: -30 })
    const revokeBearer = oidcBearer({ authTimeOffset: -5 })
    const agentBearer = `agent_${randomBytes(32).toString('base64url')}`
    const tokenFile = await secureTokenFile(directory, `${failure.mode}-initial.jwt`, initialBearer)
    const revokeTokenFile = await secureTokenFile(directory, `${failure.mode}-revoke.jwt`, revokeBearer)
    const api = mockIdentityApi({
      initialBearer,
      revokeBearer,
      agentBearer,
      bindingCode: `SF-${randomBytes(8).toString('hex').toUpperCase()}`,
      committedRunningFailure: failure.mode
    })

    await assert.rejects(runIdentityAcceptance({
      baseUrl: BASE_URL,
      tokenFile,
      revokeTokenFile,
      commit: COMMIT,
      expectedHarnessSha256: HARNESS_SHA256,
      runId: RUN_ID,
      now: () => new Date(NOW),
      fetch: api.fetch,
      platform: 'linux',
      architecture: 'x64'
    }), (error) => {
      assert.equal(error.code, failure.code)
      assert.equal(error.safeFacts.taskStatus, 'cancelled')
      assert.equal(error.safeFacts.projectStatus, 'cancelled')
      assert.equal(error.safeFacts.deviceStatus, 'revoked')
      return true
    })

    assert.deepEqual(api.snapshot(), {
      deviceStatus: 'revoked',
      projectStatus: 'cancelled',
      projectRevision: 3,
      taskStatus: 'cancelled',
      taskRevision: 4
    })
    const freshTaskRead = api.calls.findIndex((call) => call.bearer === initialBearer &&
      call.body?.type === 'task.get' && call.body.requestId.startsWith('req_aid_90_'))
    const cleanupDeviceRevoke = api.calls.findIndex((call) => call.bearer === revokeBearer &&
      call.method === 'DELETE' && call.path === `/v1/me/devices/${api.ids.deviceId}`)
    const cleanupTaskCancel = api.calls.findIndex((call) => call.bearer === initialBearer &&
      call.body?.type === 'task.transition' && call.body.status === 'cancelled')
    const freshProjectRead = api.calls.findIndex((call) => call.bearer === initialBearer && call.body?.type === 'project.get')
    const cleanupProjectCancel = api.calls.findIndex((call) => call.bearer === initialBearer &&
      call.body?.type === 'project.transition' && call.body.status === 'cancelled')
    assert.ok(cleanupDeviceRevoke >= 0 && cleanupDeviceRevoke < freshTaskRead)
    assert.ok(freshTaskRead >= 0 && freshTaskRead < cleanupTaskCancel)
    assert.ok(cleanupTaskCancel < freshProjectRead && freshProjectRead < cleanupProjectCancel)
  }
})

test('Device credentials are revoked before a hanging Task cleanup can consume cleanup time', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-a-identity-cleanup-priority-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const initialBearer = oidcBearer({ authTimeOffset: -30 })
  const revokeBearer = oidcBearer({ authTimeOffset: -5 })
  const tokenFile = await secureTokenFile(directory, 'initial.jwt', initialBearer)
  const revokeTokenFile = await secureTokenFile(directory, 'revoke.jwt', revokeBearer)
  const api = mockIdentityApi({
    initialBearer,
    revokeBearer,
    agentBearer: `agent_${randomBytes(32).toString('base64url')}`,
    bindingCode: `SF-${randomBytes(8).toString('hex').toUpperCase()}`,
    committedRunningFailure: 'edge-revision',
    hangCleanupTaskGet: true
  })

  await assert.rejects(runIdentityAcceptance({
    baseUrl: BASE_URL,
    tokenFile,
    revokeTokenFile,
    commit: COMMIT,
    expectedHarnessSha256: HARNESS_SHA256,
    runId: RUN_ID,
    now: () => new Date(NOW),
    fetch: api.fetch,
    requestTimeoutMs: 5,
    platform: 'linux',
    architecture: 'x64'
  }), (error) => {
    assert.equal(error.code, 'live_commit_mismatch')
    assert.equal(error.safeFacts.deviceStatus, 'revoked')
    assert.equal(error.safeFacts.projectStatus, 'cancelled')
    return true
  })

  assert.deepEqual(api.snapshot(), {
    deviceStatus: 'revoked',
    projectStatus: 'cancelled',
    projectRevision: 3,
    taskStatus: 'running',
    taskRevision: 3
  })
  const cleanupDeviceRevoke = api.calls.findIndex((call) => call.method === 'DELETE' &&
    call.path === `/v1/me/devices/${api.ids.deviceId}`)
  const hangingTaskRead = api.calls.findIndex((call) => call.body?.type === 'task.get' &&
    call.body.requestId.startsWith('req_aid_90_'))
  const cleanupProjectRead = api.calls.findIndex((call) => call.body?.type === 'project.get' &&
    call.body.requestId.startsWith('req_aid_92_'))
  assert.ok(cleanupDeviceRevoke >= 0 && cleanupDeviceRevoke < hangingTaskRead)
  assert.ok(hangingTaskRead < cleanupProjectRead)
})

test('configuration has no inline bearer option and a revoke token must represent the same fresh principal', async (context) => {
  assert.throws(() => parseIdentityAcceptanceConfiguration(['--token', 'inline-value']), {
    code: 'configuration_rejected'
  })
  for (const baseUrl of [
    'https://evil.example.invalid',
    'https://cloud-test.sciforge.cn/v1',
    'https://user:password@cloud-test.sciforge.cn'
  ]) {
    await assert.rejects(runIdentityAcceptance({
      baseUrl,
      tokenFile: '/not-read.jwt',
      revokeTokenFile: '/not-read-fresh.jwt',
      commit: COMMIT,
      expectedHarnessSha256: HARNESS_SHA256,
      runId: RUN_ID
    }), { code: 'configuration_rejected' })
  }
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-a-identity-principal-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const initialBearer = oidcBearer({ subject: 'a-owner' })
  const differentBearer = oidcBearer({ subject: 'another-owner' })
  const agentBearer = `agent_${randomBytes(32).toString('base64url')}`
  const tokenFile = await secureTokenFile(directory, 'initial.jwt', initialBearer)
  const revokeTokenFile = await secureTokenFile(directory, 'different.jwt', differentBearer)
  const api = mockIdentityApi({
    initialBearer,
    revokeBearer: differentBearer,
    agentBearer,
    bindingCode: `SF-${randomBytes(8).toString('hex').toUpperCase()}`
  })
  await assert.rejects(runIdentityAcceptance({
    baseUrl: BASE_URL,
    tokenFile,
    revokeTokenFile,
    commit: COMMIT,
    expectedHarnessSha256: HARNESS_SHA256,
    runId: RUN_ID,
    now: () => new Date(NOW),
    fetch: api.fetch,
    platform: 'linux',
    architecture: 'x64'
  }), (error) => {
    assert.equal(error.code, 'oidc_principal_mismatch')
    const serialized = JSON.stringify(error.safeFacts)
    assert.equal(serialized.includes(initialBearer), false)
    assert.equal(serialized.includes(differentBearer), false)
    assert.equal(serialized.includes(agentBearer), false)
    return true
  })
})

test('both OIDC token files and their lifetime, freshness, and principal are preflighted before all HTTP', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-a-identity-dual-token-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const initialBearer = oidcBearer({ subject: 'a-owner' })
  const tokenFile = await secureTokenFile(directory, 'initial.jwt', initialBearer)
  const cases = [
    {
      name: 'missing',
      revokeTokenFile: join(directory, 'missing.jwt'),
      code: 'token_file_rejected'
    },
    {
      name: 'malformed',
      revokeTokenFile: await secureTokenFile(directory, 'malformed.jwt', 'not-a-valid-jwt-token'),
      code: 'oidc_token_rejected'
    },
    {
      name: 'invalid-not-before',
      revokeTokenFile: await secureTokenFile(directory, 'invalid-nbf.jwt', oidcBearer({
        subject: 'a-owner', claims: { nbf: 'not-a-numeric-date' }
      })),
      code: 'oidc_token_rejected'
    },
    {
      name: 'stale-authentication',
      revokeTokenFile: await secureTokenFile(directory, 'stale.jwt', oidcBearer({
        subject: 'a-owner', authTimeOffset: -181
      })),
      code: 'oidc_reauthentication_required'
    },
    {
      name: 'different-principal',
      revokeTokenFile: await secureTokenFile(directory, 'different.jwt', oidcBearer({ subject: 'another-owner' })),
      code: 'oidc_principal_mismatch'
    },
    {
      name: 'insufficient-lifetime',
      revokeTokenFile: await secureTokenFile(directory, 'short.jwt', oidcBearer({
        subject: 'a-owner', expiresIn: 179
      })),
      code: 'oidc_token_rejected'
    }
  ]

  let fetchCalls = 0
  const fetch = async () => {
    fetchCalls += 1
    throw new Error('preflight must not fetch')
  }
  for (const scenario of cases) {
    await assert.rejects(runIdentityAcceptance({
      baseUrl: BASE_URL,
      tokenFile,
      revokeTokenFile: scenario.revokeTokenFile,
      commit: COMMIT,
      expectedHarnessSha256: HARNESS_SHA256,
      runId: RUN_ID,
      now: () => new Date(NOW),
      fetch,
      platform: 'linux',
      architecture: 'x64'
    }), (error) => {
      assert.equal(error.code, scenario.code, scenario.name)
      return true
    })
  }
  assert.equal(fetchCalls, 0)
})

test('the fresh revoke token is server-validated before any resource mutation', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-a-identity-revoke-auth-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const initialBearer = oidcBearer({ authTimeOffset: -30 })
  const revokeBearer = oidcBearer({ authTimeOffset: -5 })
  const tokenFile = await secureTokenFile(directory, 'initial.jwt', initialBearer)
  const revokeTokenFile = await secureTokenFile(directory, 'revoke.jwt', revokeBearer)
  const api = mockIdentityApi({
    initialBearer,
    revokeBearer,
    agentBearer: `agent_${randomBytes(32).toString('base64url')}`,
    bindingCode: `SF-${randomBytes(8).toString('hex').toUpperCase()}`,
    rejectRevokeMe: true
  })

  await assert.rejects(runIdentityAcceptance({
    baseUrl: BASE_URL,
    tokenFile,
    revokeTokenFile,
    commit: COMMIT,
    expectedHarnessSha256: HARNESS_SHA256,
    runId: RUN_ID,
    now: () => new Date(NOW),
    fetch: api.fetch,
    platform: 'linux',
    architecture: 'x64'
  }), (error) => {
    assert.equal(error.code, 'http_request_rejected')
    assert.equal(error.safeFacts.deviceId, undefined)
    assert.equal(error.safeFacts.projectId, undefined)
    return true
  })

  assert.deepEqual(api.calls.map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: '/v1/me' },
    { method: 'GET', path: '/v1/me' }
  ])
  assert.equal(api.calls.some((call) => ['POST', 'DELETE'].includes(call.method)), false)
  assert.deepEqual(api.snapshot(), {
    deviceStatus: 'not_created',
    projectStatus: 'not_created',
    projectRevision: 0,
    taskStatus: 'not_created',
    taskRevision: 0
  })
})

test('global fetch rejects ambient preload, TLS, CA, and proxy controls before token access', { concurrency: false }, async () => {
  const unsafeKeySet = new Set(DANGEROUS_NETWORK_ENV_KEYS)
  const originalUnsafeEnvironment = new Map(Object.entries(process.env)
    .filter(([key]) => unsafeKeySet.has(key.toUpperCase())))
  const originalGlobalFetch = globalThis.fetch
  const clearUnsafeEnvironment = () => {
    for (const key of Object.keys(process.env)) {
      if (unsafeKeySet.has(key.toUpperCase())) delete process.env[key]
    }
  }
  let globalFetchCalls = 0
  try {
    clearUnsafeEnvironment()
    globalThis.fetch = async () => {
      globalFetchCalls += 1
      throw new Error('unsafe environment must stop before fetch')
    }
    for (const key of [...DANGEROUS_NETWORK_ENV_KEYS, 'https_proxy']) {
      process.env[key] = 'unsafe-test-value'
      await assert.rejects(runIdentityAcceptance({
        baseUrl: BASE_URL,
        tokenFile: '/not-read-initial.jwt',
        revokeTokenFile: '/not-read-revoke.jwt',
        commit: COMMIT,
        expectedHarnessSha256: HARNESS_SHA256,
        runId: RUN_ID
      }), (error) => {
        assert.equal(error.code, 'configuration_rejected')
        assert.equal(error.safeFacts.field, 'network-environment')
        return true
      })
      delete process.env[key]
    }
    assert.equal(globalFetchCalls, 0)

    process.env.HTTPS_PROXY = 'https://ambient-proxy.invalid'
    let injectedFetchCalls = 0
    await assert.rejects(runIdentityAcceptance({
      baseUrl: BASE_URL,
      tokenFile: '/not-read-initial.jwt',
      revokeTokenFile: '/not-read-revoke.jwt',
      commit: COMMIT,
      expectedHarnessSha256: HARNESS_SHA256,
      runId: RUN_ID,
      fetch: async () => {
        injectedFetchCalls += 1
        throw new Error('token preflight must stop before injected fetch')
      }
    }), { code: 'token_file_rejected' })
    assert.equal(injectedFetchCalls, 0)
  } finally {
    clearUnsafeEnvironment()
    for (const [key, value] of originalUnsafeEnvironment) process.env[key] = value
    globalThis.fetch = originalGlobalFetch
  }
})

test('the configured harness SHA-256 is required, self-checked before tokens, and emitted in receipts', async () => {
  let fetchCalls = 0
  await assert.rejects(runIdentityAcceptance({
    baseUrl: BASE_URL,
    tokenFile: '/not-read-initial.jwt',
    revokeTokenFile: '/not-read-revoke.jwt',
    commit: COMMIT,
    expectedHarnessSha256: '0'.repeat(64),
    runId: RUN_ID,
    fetch: async () => {
      fetchCalls += 1
      throw new Error('integrity mismatch must stop before fetch')
    }
  }), { code: 'harness_integrity_rejected' })
  assert.equal(fetchCalls, 0)

  const configured = parseIdentityAcceptanceConfiguration([
    '--base-url', BASE_URL,
    '--token-file', '/tmp/initial.jwt',
    '--revoke-token-file', '/tmp/revoke.jwt',
    '--commit', COMMIT,
    '--expected-harness-sha256', HARNESS_SHA256
  ], {})
  assert.equal(configured.expectedHarnessSha256, HARNESS_SHA256)
  assert.throws(() => parseIdentityAcceptanceConfiguration([
    '--base-url', BASE_URL,
    '--token-file', '/tmp/initial.jwt',
    '--revoke-token-file', '/tmp/revoke.jwt',
    '--commit', COMMIT
  ], {}), { code: 'configuration_rejected' })
  assert.equal(parseIdentityAcceptanceConfiguration([], {
    SCIFORGE_CLOUD_BASE_URL: BASE_URL,
    SCIFORGE_OIDC_ACCESS_TOKEN_FILE: '/tmp/initial.jwt',
    SCIFORGE_OIDC_REVOKE_TOKEN_FILE: '/tmp/revoke.jwt',
    SCIFORGE_COLLAB_CONTRACT_COMMIT: COMMIT,
    SCIFORGE_IDENTITY_ACCEPTANCE_HARNESS_SHA256: HARNESS_SHA256
  }).expectedHarnessSha256, HARNESS_SHA256)
})

test('OIDC timing boundaries reserve 180 seconds at preflight and 120 seconds through final cleanup auth checks', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-a-identity-time-boundary-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const initialBearer = oidcBearer({ authTimeOffset: -30, expiresIn: 180 })
  const revokeBearer = oidcBearer({ authTimeOffset: -180, expiresIn: 180 })
  const tokenFile = await secureTokenFile(directory, 'initial.jwt', initialBearer)
  const revokeTokenFile = await secureTokenFile(directory, 'revoke.jwt', revokeBearer)
  const api = mockIdentityApi({
    initialBearer,
    revokeBearer,
    agentBearer: `agent_${randomBytes(32).toString('base64url')}`,
    bindingCode: `SF-${randomBytes(8).toString('hex').toUpperCase()}`
  })
  let logicalNow = new Date(NOW)
  const fetch = async (url, init) => {
    const request = init.body ? JSON.parse(init.body) : undefined
    const response = await api.fetch(url, init)
    if (request?.type === 'task.transition' && request.status === 'succeeded') {
      logicalNow = new Date(NOW.getTime() + 60_000)
    }
    return response
  }

  const receipt = await runIdentityAcceptance({
    baseUrl: BASE_URL,
    tokenFile,
    revokeTokenFile,
    commit: COMMIT,
    expectedHarnessSha256: HARNESS_SHA256,
    runId: RUN_ID,
    now: () => new Date(logicalNow),
    fetch,
    platform: 'linux',
    architecture: 'x64'
  })
  assert.equal(receipt.status, 'succeeded')
  assert.equal(receipt.deviceStatus, 'revoked')
})

test('the request timeout remains armed after headers and aborts a stalled bounded response body without leaking it', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-a-identity-body-timeout-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const initialBearer = oidcBearer()
  const revokeBearer = oidcBearer({ authTimeOffset: -5 })
  const tokenFile = await secureTokenFile(directory, 'initial.jwt', initialBearer)
  const revokeTokenFile = await secureTokenFile(directory, 'revoke.jwt', revokeBearer)
  const privateBodyMarker = 'private-body-marker-must-not-leak'
  let fetchCalls = 0
  let bodyAbortObserved = false
  const fetch = async (url, init) => {
    fetchCalls += 1
    assert.equal(new URL(url).pathname, '/v1/me')
    assert.equal(init.method, 'GET')
    let keepAlive
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"partial":"${privateBodyMarker}`))
        keepAlive = setTimeout(() => controller.error(new Error('body timeout test guard')), 1_000)
        init.signal.addEventListener('abort', () => {
          bodyAbortObserved = true
          clearTimeout(keepAlive)
          controller.error(new Error('response body aborted'))
        }, { once: true })
      },
      cancel() {
        clearTimeout(keepAlive)
      }
    })
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-sciforge-edge-revision': COMMIT
      }
    })
  }

  const startedAt = performance.now()
  await assert.rejects(runIdentityAcceptance({
    baseUrl: BASE_URL,
    tokenFile,
    revokeTokenFile,
    commit: COMMIT,
    expectedHarnessSha256: HARNESS_SHA256,
    runId: RUN_ID,
    now: () => new Date(NOW),
    fetch,
    requestTimeoutMs: 5,
    platform: 'linux',
    architecture: 'x64'
  }), (error) => {
    assert.equal(error.code, 'network_request_failed')
    assert.equal(`${error.message}${JSON.stringify(error.safeFacts)}`.includes(privateBodyMarker), false)
    return true
  })
  assert.ok(performance.now() - startedAt < 500)
  assert.equal(fetchCalls, 1)
  assert.equal(bodyAbortObserved, true)
})
