#!/usr/bin/env node

import {
  generateKeyPairSync,
  randomBytes,
  sign as signBytes
} from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { WebSocket } from 'ws'

import {
  AcceptanceFailure,
  assertSafeGlobalFetchEnvironment,
  assertSameOidcPrincipal,
  canonicalEnrollmentBytes,
  failIdentityAcceptance as fail,
  identityAcceptanceCommand as command,
  identityAcceptanceCurrentDate as currentDate,
  identityAcceptanceDeviceFromResponse as deviceFromResponse,
  identityAcceptanceExactEntity as exactEntity,
  identityAcceptanceExactTask as exactTask,
  identityAcceptanceListedDevice as listedDevice,
  identityAcceptanceMeIdentity as meIdentity,
  identityAcceptancePlatformFacts as platformFacts,
  identityAcceptanceRequestJson as requestJson,
  identityAcceptanceRequiredId as requiredId,
  identityAcceptanceRequiredRecord as requiredRecord,
  identityAcceptanceRequiredRevision as requiredRevision,
  identityAcceptanceSecurityPolicy as securityPolicy,
  inspectOidcToken,
  isIdentityAcceptanceRecord as isRecord,
  normalizeHttpsBaseUrl,
  readSecureOidcTokenFile,
  secureRegularFileSha256
} from './collaboration-a-identity-acceptance.mjs'

const BASE_ACCEPTANCE_DEADLINE_MS = 70_000
const PER_ADDITIONAL_WORKER_DEADLINE_MS = 5_000
// Fresh-revoke tokens may already be 120 seconds old at preflight and the API's
// recent-auth boundary is 240 seconds. Keep the whole success gate below that
// remaining window, then re-check freshness immediately before every revoke.
const MAX_ACCEPTANCE_DEADLINE_MS = 105_000
const BASE_CLEANUP_DEADLINE_MS = 20_000
const PER_ADDITIONAL_WORKER_CLEANUP_DEADLINE_MS = 10_000
const MAX_CLEANUP_DEADLINE_MS = 90_000
const WEBSOCKET_TIMEOUT_MS = 15_000
const MAX_WEBSOCKET_MESSAGE_BYTES = 8 * 1_024
const MAX_INBOX_SCAN_MESSAGES = 1_000
const MAX_WORKER_DESCRIPTOR_BYTES = 8 * 1_024
const MIN_RELEASE_WORKERS = 2
const MAX_WORKERS = 8
const MULTI_WORKER_PREFLIGHT_MIN_TOKEN_REMAINING_SECONDS = 240
const MULTI_WORKER_REVOKE_PREFLIGHT_MAX_AUTHENTICATION_AGE_SECONDS = 120
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const RUN_ID_PATTERN = /^[a-f0-9]{24}$/u
const SAFE_MESSAGE_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u
const OPAQUE_ID_SUFFIX_PATTERN = '[A-Za-z0-9](?:[A-Za-z0-9_]{10,62}[A-Za-z0-9])'
const PROVIDER_OPAQUE_ID_MAX_LENGTH = 512
const COLLABORATION_ERROR_RULES = Object.freeze({
  validation_error: ['validation', 400, false],
  authentication_required: ['authentication', 401, false],
  credential_revoked: ['authentication', 401, false],
  permission_denied: ['authorization', 403, false],
  assurance_insufficient: ['authorization', 403, false],
  not_found: ['validation', 404, false],
  identity_conflict: ['conflict', 409, false],
  IDENTITY_ALREADY_BOUND: ['conflict', 409, false],
  BINDING_CODE_USED: ['conflict', 409, false],
  BINDING_CODE_EXPIRED: ['conflict', 410, false],
  ownership_conflict: ['conflict', 409, false],
  revision_conflict: ['conflict', 409, true],
  execution_conflict: ['conflict', 409, false],
  idempotency_conflict: ['conflict', 409, false],
  invalid_state_transition: ['conflict', 409, false],
  assignee_mismatch: ['authorization', 403, false],
  coordinator_mismatch: ['authorization', 403, false],
  confirmation_required: ['authorization', 403, false],
  confirmation_mismatch: ['conflict', 409, false],
  resource_unavailable: ['conflict', 409, false],
  capability_profile_expired: ['conflict', 409, false],
  inbox_ack_gap: ['conflict', 409, false],
  routing_ambiguous: ['routing', 409, false],
  routing_not_found: ['routing', 404, false],
  provider_unavailable: ['provider', 503, true],
  recipient_mismatch: ['routing', 409, false],
  payload_too_large: ['limit', 413, false],
  rate_limited: ['limit', 429, true],
  expired: ['conflict', 410, false],
  version_incompatible: ['version', 426, false],
  internal_error: ['internal', 500, true]
})

function exactRecord(value, requiredKeys, optionalKeys = []) {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  return requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    keys.length >= requiredKeys.length && keys.every((key) => allowed.has(key))
}

function opaqueId(value, prefix) {
  return typeof value === 'string' &&
    new RegExp(`^${prefix}_${OPAQUE_ID_SUFFIX_PATTERN}$`, 'u').test(value)
}

function boundedIntegerValue(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum
}

function protocolTimestamp(value) {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[10] === undefined ? 0 : Number(match[10])
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1] &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59
}

function providerOpaqueId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= PROVIDER_OPAQUE_ID_MAX_LENGTH
}

function strictCollaborationError(value) {
  const optionalKeys = [
    'requestId',
    'resourceType',
    'resourceId',
    'expectedRevision',
    'currentRevision',
    'currentExecutionId',
    'confirmationId',
    'ackedSequence',
    'nextSequence',
    'details'
  ]
  if (!exactRecord(value, [
    'protocolVersion',
    'type',
    'traceId',
    'code',
    'category',
    'httpStatus',
    'retryable',
    'message'
  ], optionalKeys)) return false
  const rule = COLLABORATION_ERROR_RULES[value.code]
  if (!rule || value.protocolVersion !== '1.0' || value.type !== 'error' ||
      value.category !== rule[0] || value.httpStatus !== rule[1] || value.retryable !== rule[2] ||
      !opaqueId(value.traceId, 'trc') || typeof value.message !== 'string' ||
      value.message.trim().length < 1 || value.message.trim().length > 500) return false
  if (value.requestId !== undefined && !opaqueId(value.requestId, 'req')) return false
  if (value.resourceType !== undefined && (typeof value.resourceType !== 'string' ||
      !/^[a-z][a-z0-9_.-]{0,63}$/u.test(value.resourceType))) return false
  if (value.resourceId !== undefined && (typeof value.resourceId !== 'string' ||
      value.resourceId.length < 1 || value.resourceId.length > 128)) return false
  if (value.expectedRevision !== undefined && !boundedIntegerValue(value.expectedRevision, 1)) return false
  if (value.currentRevision !== undefined && !boundedIntegerValue(value.currentRevision, 1)) return false
  if (value.currentExecutionId !== undefined && !opaqueId(value.currentExecutionId, 'exe')) return false
  if (value.confirmationId !== undefined && !opaqueId(value.confirmationId, 'cnf')) return false
  if (value.ackedSequence !== undefined && !boundedIntegerValue(value.ackedSequence, 0)) return false
  if (value.nextSequence !== undefined && !boundedIntegerValue(value.nextSequence, 1)) return false
  if (value.details !== undefined) {
    try {
      JSON.stringify(value.details)
    } catch {
      return false
    }
  }
  return true
}

export function parseStrictWebSocketMessage(value) {
  if (!isRecord(value) || value.protocolVersion !== '1.0' || typeof value.type !== 'string') return undefined
  if (value.type === 'connection.ready') {
    return exactRecord(value, ['protocolVersion', 'type', 'connectionId', 'connectedAt']) &&
      providerOpaqueId(value.connectionId) && protocolTimestamp(value.connectedAt) ? value : undefined
  }
  if (value.type === 'inbox.available') {
    return exactRecord(value, ['protocolVersion', 'type', 'recipientType', 'highestSequence']) &&
      ['user', 'agent'].includes(value.recipientType) && boundedIntegerValue(value.highestSequence, 1)
      ? value
      : undefined
  }
  if (value.type === 'connection.error') {
    return exactRecord(value, ['protocolVersion', 'type', 'error']) && strictCollaborationError(value.error)
      ? value
      : undefined
  }
  if (value.type === 'connection.ping' || value.type === 'connection.pong') {
    return exactRecord(value, ['protocolVersion', 'type', 'nonce', 'sentAt']) &&
      providerOpaqueId(value.nonce) && protocolTimestamp(value.sentAt) ? value : undefined
  }
  return undefined
}

function timestamp(now) {
  return currentDate(now).toISOString()
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('configuration_rejected', { field })
  }
  return value
}

function safePrincipal(principal) {
  return {
    ...(principal.userId ? { userId: principal.userId } : {}),
    ...(principal.oidcIdentityId ? { oidcIdentityId: principal.oidcIdentityId } : {}),
    ...(principal.deviceId ? { deviceId: principal.deviceId, deviceStatus: principal.deviceStatus } : {}),
    ...(principal.agentId ? {
      agentId: principal.agentId,
      agentCredentialStatus: principal.agentCredentialStatus
    } : {})
  }
}

function safeRunState(state, code = undefined) {
  const safeWorker = (worker) => ({
    ...safePrincipal(worker),
    websocket: {
      ready: worker.webSocketReady === true,
      pong: worker.webSocketPong === true,
      inboxAvailable: worker.webSocketInboxAvailable === true,
      reconnected: worker.webSocketReconnected === true,
      replayPulled: worker.webSocketReplayPulled === true,
      revocationClosed: worker.webSocketRevocationClosed === true,
      ...(Number.isSafeInteger(worker.webSocketHighestSequence)
        ? { highestSequence: worker.webSocketHighestSequence }
        : {})
    },
    inbox: {
      ...(Number.isSafeInteger(worker.inboxBaseline)
        ? { baselineAckedSequence: worker.inboxBaseline }
        : {}),
      ...(Number.isSafeInteger(worker.inboxAckedThrough)
        ? { ackedThroughSequence: worker.inboxAckedThrough }
        : {}),
      ...(worker.inboxGap ? { activeGap: worker.inboxGap } : {}),
      supersededSequences: [...worker.supersededSequences]
    },
    ...(worker.taskId ? {
      taskId: worker.taskId,
      executionId: worker.executionId,
      taskStatus: worker.taskStatus
    } : {}),
    ...(worker.resultRecordId ? {
      resultProjectRecordId: worker.resultRecordId,
      resultStatus: worker.resultStatus
    } : {})
  })
  const workers = state.workers.map(safeWorker)
  return {
    type: 'sciforge.a.multi_worker_acceptance.receipt',
    commit: state.commit,
    multiWorkerHarnessSha256: state.multiWorkerHarnessSha256,
    identityHarnessSha256: state.identityHarnessSha256,
    runId: state.runId,
    status: code ? 'failed' : 'succeeded',
    ...(code ? { code } : {}),
    ...(!code && state.verifiedAtUtc ? { verifiedAtUtc: state.verifiedAtUtc } : {}),
    oidcPrincipalsDistinct: state.oidcPrincipalsDistinct === true,
    owner: safePrincipal(state.owner),
    workerCount: workers.length,
    workers,
    ...(state.projectId ? { projectId: state.projectId, projectStatus: state.projectStatus } : {}),
  }
}

function principalState(label) {
  return {
    label,
    initialBearerValidated: false,
    cleanupBearerValidated: false,
    deviceStatus: 'not_created',
    agentCredentialStatus: 'not_issued',
    taskStatus: 'not_created',
    resultStatus: 'not_created',
    supersededSequences: []
  }
}

function nextCommand(state, type, fields = {}) {
  state.commandOrdinal += 1
  return command(state.runId, state.commandOrdinal, type, fields)
}

function exactWorkerInput(value, field) {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'tokenFile') || !Object.hasOwn(value, 'revokeTokenFile') ||
      typeof value.tokenFile !== 'string' || !isAbsolute(value.tokenFile) ||
      typeof value.revokeTokenFile !== 'string' || !isAbsolute(value.revokeTokenFile)) {
    fail('configuration_rejected', { field })
  }
  return Object.freeze({ tokenFile: value.tokenFile, revokeTokenFile: value.revokeTokenFile })
}

async function readSecureWorkerDescriptorFile(filename) {
  if (typeof filename !== 'string' || !isAbsolute(filename) || fsConstants.O_NOFOLLOW === undefined) {
    fail('worker_descriptor_rejected')
  }
  let handle
  try {
    handle = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    const mode = Number(before.mode & 0o7777n)
    const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined
    if (!before.isFile() || before.nlink !== 1n || mode !== 0o600 ||
        (currentUid !== undefined && before.uid !== currentUid) ||
        before.size < 2n || before.size > BigInt(MAX_WORKER_DESCRIPTOR_BYTES)) {
      fail('worker_descriptor_rejected')
    }
    const source = await handle.readFile({ encoding: 'utf8' })
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      fail('worker_descriptor_changed')
    }
    let descriptor
    try {
      descriptor = JSON.parse(source)
    } catch {
      fail('worker_descriptor_rejected')
    }
    if (!isRecord(descriptor) || Object.keys(descriptor).length !== 2 ||
        !Object.hasOwn(descriptor, 'accessTokenFile') || !Object.hasOwn(descriptor, 'revokeTokenFile')) {
      fail('worker_descriptor_rejected')
    }
    return exactWorkerInput({
      tokenFile: descriptor.accessTokenFile,
      revokeTokenFile: descriptor.revokeTokenFile
    }, 'worker-descriptor-file')
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error
    fail('worker_descriptor_rejected')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function workerInputs(rawOptions) {
  const descriptorFiles = rawOptions.workerDescriptorFiles
  const injectedWorkers = rawOptions.workers
  const sources = Number(descriptorFiles !== undefined) + Number(injectedWorkers !== undefined)
  if (sources !== 1) fail('configuration_rejected', { field: 'workers' })
  let inputs
  if (descriptorFiles !== undefined) {
    if (!Array.isArray(descriptorFiles)) fail('configuration_rejected', { field: 'worker-descriptor-file' })
    inputs = []
    for (const filename of descriptorFiles) inputs.push(await readSecureWorkerDescriptorFile(filename))
  } else if (injectedWorkers !== undefined) {
    if (!Array.isArray(injectedWorkers)) fail('configuration_rejected', { field: 'workers' })
    inputs = injectedWorkers.map((value) => exactWorkerInput(value, 'workers'))
  }
  if (inputs.length < MIN_RELEASE_WORKERS || inputs.length > MAX_WORKERS) {
    fail('configuration_rejected', { field: 'worker-count' })
  }
  return inputs
}

async function preflightPrincipal(input, principal, now) {
  principal.initialBearer = await readSecureOidcTokenFile(input.tokenFile)
  principal.initialClaims = inspectOidcToken(
    principal.initialBearer,
    Math.floor(currentDate(now).getTime() / 1_000),
    { minimumRemainingSeconds: MULTI_WORKER_PREFLIGHT_MIN_TOKEN_REMAINING_SECONDS }
  )
  principal.cleanupBearer = await readSecureOidcTokenFile(input.revokeTokenFile)
  principal.cleanupClaims = inspectOidcToken(
    principal.cleanupBearer,
    Math.floor(currentDate(now).getTime() / 1_000),
    {
      minimumRemainingSeconds: MULTI_WORKER_PREFLIGHT_MIN_TOKEN_REMAINING_SECONDS,
      maximumAuthenticationAgeSeconds: MULTI_WORKER_REVOKE_PREFLIGHT_MAX_AUTHENTICATION_AGE_SECONDS
    }
  )
  assertSameOidcPrincipal(principal.initialClaims, principal.cleanupClaims)
}

async function resolvePrincipal(options, principal) {
  const initial = meIdentity(await requestJson(options, {
    step: `${principal.label}-me`,
    path: '/v1/me',
    bearer: principal.initialBearer
  }), `${principal.label}-me`)
  principal.initialBearerValidated = true
  principal.userId = initial.userId
  principal.oidcIdentityId = initial.oidcIdentityId

  const cleanup = meIdentity(await requestJson(options, {
    step: `${principal.label}-revoke-me-preflight`,
    path: '/v1/me',
    bearer: principal.cleanupBearer
  }), `${principal.label}-revoke-me-preflight`)
  if (cleanup.userId !== initial.userId || cleanup.oidcIdentityId !== initial.oidcIdentityId ||
      cleanup.issuer !== initial.issuer) {
    fail('oidc_principal_mismatch')
  }
  principal.cleanupBearerValidated = true
}

async function enrollPrincipal(options, state, principal, now, rawOptions) {
  const runId = state.runId
  const installationId = `ins_a_multi_worker_${principal.label}_${runId}`
  const enrollment = requiredRecord(await requestJson(options, {
    step: `${principal.label}-device-enrollment`,
    path: '/v1/device-enrollments',
    method: 'POST',
    bearer: principal.initialBearer,
    body: {
      installationId,
      idempotencyKey: `idem_adp_${principal.label}_enrollment_${runId}`
    }
  }), `${principal.label}-device-enrollment`)
  const enrollmentId = requiredId(
    enrollment.enrollmentId,
    'enr',
    `${principal.label}-device-enrollment`
  )
  if (typeof enrollment.nonce !== 'string' || enrollment.nonce.length > 512 ||
      !/^[A-Za-z0-9_-]+$/u.test(enrollment.nonce) ||
      Buffer.from(enrollment.nonce, 'base64url').toString('base64url') !== enrollment.nonce ||
      Buffer.from(enrollment.nonce, 'base64url').length < 32 ||
      typeof enrollment.expiresAt !== 'string' || !Number.isFinite(Date.parse(enrollment.expiresAt))) {
    fail('response_contract_rejected', { step: `${principal.label}-device-enrollment` })
  }
  const enrollmentLifetime = Date.parse(enrollment.expiresAt) - currentDate(now).getTime()
  if (enrollmentLifetime <= 0 || enrollmentLifetime > 6 * 60_000) {
    fail('response_contract_rejected', { step: `${principal.label}-device-enrollment` })
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyJwk = publicKey.export({ format: 'jwk' })
  if (publicKeyJwk.kty !== 'OKP' || publicKeyJwk.crv !== 'Ed25519' || typeof publicKeyJwk.x !== 'string') {
    fail('device_key_generation_failed')
  }
  const signature = signBytes(null, canonicalEnrollmentBytes({
    enrollmentId,
    nonce: enrollment.nonce,
    userId: principal.userId,
    installationId,
    expiresAt: enrollment.expiresAt
  }), privateKey).toString('base64url')
  const platform = platformFacts(rawOptions.platform, rawOptions.architecture)
  const createdDevice = deviceFromResponse(await requestJson(options, {
    step: `${principal.label}-device-create`,
    path: '/v1/devices',
    method: 'POST',
    bearer: principal.initialBearer,
    body: {
      enrollmentId,
      nonce: enrollment.nonce,
      installationId,
      displayName: `A multi-worker ${principal.label} device`,
      platform: { ...platform, appVersion: `acceptance-${state.commit.slice(0, 12)}` },
      publicKeyJwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        alg: 'EdDSA',
        use: 'sig',
        kid: `a-multi-worker-${principal.label}-${runId}`,
        x: publicKeyJwk.x
      },
      capabilitySummary: [],
      signature,
      idempotencyKey: `idem_adp_${principal.label}_device_${runId}`
    }
  }), 'active', `${principal.label}-device-create`)
  principal.deviceId = createdDevice.deviceId
  principal.deviceStatus = createdDevice.status

  listedDevice(await requestJson(options, {
    step: `${principal.label}-device-list-active`,
    path: '/v1/me/devices',
    bearer: principal.initialBearer
  }), principal.deviceId, 'active', `${principal.label}-device-list-active`)

  const registered = requiredRecord(await requestJson(options, {
    step: `${principal.label}-agent-register`,
    path: '/v1/commands',
    method: 'POST',
    bearer: principal.initialBearer,
    body: nextCommand(state, 'agent.register', {
      deviceId: principal.deviceId,
      displayName: `A multi-worker ${principal.label} agent`,
      nodeType: 'desktop',
      capabilities: []
    })
  }), `${principal.label}-agent-register`)
  if (registered.protocolVersion !== '1.0' || registered.type !== 'agent.registered' ||
      typeof registered.deviceCredential !== 'string' || registered.deviceCredential.length < 32 ||
      registered.deviceCredential.length > 2_048 || /[\r\n]/u.test(registered.deviceCredential)) {
    fail('response_contract_rejected', { step: `${principal.label}-agent-register` })
  }
  const agent = requiredRecord(registered.agent, `${principal.label}-agent-register`)
  principal.agentId = requiredId(agent.agentId, 'agt', `${principal.label}-agent-register`)
  if (agent.type !== 'agent_node' || agent.deviceId !== principal.deviceId ||
      agent.ownerUserId !== principal.userId || agent.lifecycleStatus !== 'active') {
    fail('response_contract_rejected', { step: `${principal.label}-agent-register` })
  }
  principal.agentRevision = requiredRevision(agent.revision, `${principal.label}-agent-register`)
  principal.agentBearer = registered.deviceCredential
  principal.agentCredentialStatus = 'active'

  const heartbeat = exactEntity(await requestJson(options, {
    step: `${principal.label}-agent-heartbeat`,
    path: '/v1/commands',
    method: 'POST',
    bearer: principal.agentBearer,
    body: nextCommand(state, 'agent.heartbeat', {
      agentId: principal.agentId,
      expectedRevision: principal.agentRevision,
      connectionStatus: 'online',
      capabilities: []
    })
  }), 'agent_node', `${principal.label}-agent-heartbeat`)
  if (heartbeat.agentId !== principal.agentId || heartbeat.deviceId !== principal.deviceId ||
      heartbeat.ownerUserId !== principal.userId || heartbeat.connectionStatus !== 'online') {
    fail('response_contract_rejected', { step: `${principal.label}-agent-heartbeat` })
  }
  principal.agentRevision = requiredRevision(heartbeat.revision, `${principal.label}-agent-heartbeat`)

  const reportedAt = timestamp(now)
  const expiresAt = new Date(Date.parse(reportedAt) + 10 * 60_000).toISOString()
  const profile = exactEntity(await requestJson(options, {
    step: `${principal.label}-capability-profile`,
    path: '/v1/commands',
    method: 'POST',
    bearer: principal.agentBearer,
    body: nextCommand(state, 'agent.capability_profile.report', {
      expectedProfileRevision: 0,
      profile: {
        agentId: principal.agentId,
        ownerUserId: principal.userId,
        nodeType: 'personal_computer',
        os: { family: platform.os, architecture: platform.arch },
        runtimeIds: [`sciforge-a-multi-worker-${principal.label}`],
        capabilities: [],
        vpnAccessIds: [],
        slurmClusterIds: [],
        accessibleResourceRefIds: [],
        resultReturnPolicy: {
          summary: true,
          evidenceRefs: false,
          resourceRefs: false,
          logSummary: false,
          fullFileRequiresConfirmation: true,
          fullLogRequiresConfirmation: true
        },
        reportedAt,
        expiresAt
      }
    })
  }), 'agent_capability_profile', `${principal.label}-capability-profile`)
  if (profile.agentId !== principal.agentId || profile.ownerUserId !== principal.userId) {
    fail('response_contract_rejected', { step: `${principal.label}-capability-profile` })
  }
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === 'function') return response.headers.get(name)
  const value = response?.headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function createWebSocketChannel(options, bearer) {
  const url = new URL('/v1/events', options.baseUrl)
  url.protocol = 'wss:'
  const notifications = []
  const waiters = new Set()
  let fatalError
  let closing = false
  let upgradeValidated = false
  let socket
  let expectingRevocationClose = false
  let revocationCloseResolve
  let revocationCloseReject

  const rejectWaiters = (error) => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    waiters.clear()
  }
  const failChannel = (code, safeFacts = {}) => {
    if (fatalError) return
    fatalError = new AcceptanceFailure(code, safeFacts)
    rejectWaiters(fatalError)
    try {
      socket?.terminate?.()
    } catch {
      // The primary fail-closed reason is retained.
    }
  }
  const dispatch = (message) => {
    notifications.push(message)
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
      waiter.resolve(message)
    }
  }

  try {
    socket = options.webSocketFactory(url.toString(), {
      headers: { authorization: `Bearer ${bearer}` },
      maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: options.webSocketTimeoutMs,
      followRedirects: false,
      rejectUnauthorized: true
    })
  } catch {
    fail('websocket_connection_failed')
  }
  if (!socket || typeof socket.on !== 'function' || typeof socket.send !== 'function') {
    fail('websocket_connection_failed')
  }

  socket.once?.('upgrade', (response) => {
    if (responseHeader(response, 'x-sciforge-edge-revision') !== options.commit) {
      failChannel('live_commit_mismatch', { step: 'worker-websocket-upgrade' })
      return
    }
    upgradeValidated = true
  })
  socket.on('message', (data, binary) => {
    if (binary === true || Buffer.byteLength(data) > MAX_WEBSOCKET_MESSAGE_BYTES) {
      failChannel('websocket_protocol_rejected')
      return
    }
    let raw
    try {
      raw = JSON.parse(data.toString())
    } catch {
      failChannel('websocket_protocol_rejected')
      return
    }
    const parsed = parseStrictWebSocketMessage(raw)
    if (!parsed || parsed.type === 'connection.error') {
      failChannel('websocket_protocol_rejected')
      return
    }
    dispatch(parsed)
  })
  socket.once?.('error', () => failChannel('websocket_connection_failed'))
  socket.once?.('unexpected-response', () => failChannel('websocket_connection_failed'))
  socket.once?.('close', (code) => {
    if (expectingRevocationClose) {
      closing = true
      if (code === 1008) revocationCloseResolve?.(code)
      else revocationCloseReject?.(new AcceptanceFailure('websocket_revocation_close_rejected'))
      return
    }
    if (!closing) failChannel('websocket_connection_closed')
  })

  const waitFor = (predicate, step) => {
    if (fatalError) return Promise.reject(fatalError)
    const existing = notifications.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolveWaiter, rejectWaiter) => {
      const waiter = {
        predicate,
        resolve: resolveWaiter,
        reject: rejectWaiter,
        timer: setTimeout(() => {
          waiters.delete(waiter)
          rejectWaiter(new AcceptanceFailure('websocket_timeout', { step }))
        }, options.webSocketTimeoutMs)
      }
      waiters.add(waiter)
    })
  }

  return Object.freeze({
    async ready() {
      await waitFor((message) => message.type === 'connection.ready', 'worker-websocket-ready')
      if (!upgradeValidated) fail('live_commit_mismatch', { step: 'worker-websocket-upgrade' })
    },
    async ping(nonce) {
      const sentAt = timestamp(options.now)
      try {
        socket.send(JSON.stringify({ protocolVersion: '1.0', type: 'connection.ping', nonce, sentAt }))
      } catch {
        fail('websocket_connection_failed')
      }
      return waitFor(
        (message) => message.type === 'connection.pong' && message.nonce === nonce,
        'worker-websocket-pong'
      )
    },
    waitForInboxAbove(sequence) {
      return waitFor(
        (message) => message.type === 'inbox.available' && message.recipientType === 'agent' &&
          message.highestSequence > sequence,
        'worker-websocket-inbox-available'
      )
    },
    async assertRevocationClosed(nonce) {
      if (fatalError) throw fatalError
      const notificationStart = notifications.length
      expectingRevocationClose = true
      const closed = new Promise((resolveWaiter, rejectWaiter) => {
        revocationCloseResolve = resolveWaiter
        revocationCloseReject = rejectWaiter
      })
      try {
        socket.send(JSON.stringify({
          protocolVersion: '1.0',
          type: 'connection.ping',
          nonce,
          sentAt: timestamp(options.now)
        }))
      } catch {
        fail('websocket_connection_failed')
      }
      let timer
      try {
        await Promise.race([
          closed,
          new Promise((_, rejectWaiter) => {
            timer = setTimeout(
              () => rejectWaiter(new AcceptanceFailure('websocket_revocation_close_timeout')),
              options.webSocketTimeoutMs
            )
          })
        ])
      } finally {
        clearTimeout(timer)
      }
      if (notifications.slice(notificationStart).some((message) => (
        message.type === 'connection.pong' && message.nonce === nonce
      ))) {
        fail('websocket_revoked_pong_received')
      }
    },
    close() {
      closing = true
      rejectWaiters(new AcceptanceFailure('websocket_channel_closed'))
      try {
        socket.terminate?.()
      } catch {
        // Closing the hint channel is best effort after its assertions finish.
      }
    }
  })
}

function exactInboxPage(value, step) {
  const page = requiredRecord(value, step)
  if (page.protocolVersion !== '1.0' || page.type !== 'rest.inbox_page' ||
      !Array.isArray(page.messages) || page.messages.length > 1_000 ||
      !Number.isSafeInteger(page.ackedSequence) || page.ackedSequence < 0 ||
      !Number.isSafeInteger(page.nextSequence) || page.nextSequence <= page.ackedSequence) {
    fail('response_contract_rejected', { step })
  }
  return page
}

async function inboxBaseline(options, state, principal, step) {
  const page = exactInboxPage(await requestJson(options, {
    step,
    path: '/v1/commands',
    method: 'POST',
    bearer: principal.agentBearer,
    body: nextCommand(state, 'inbox.pull', {
      recipientType: 'agent',
      afterSequence: 0,
      limit: 1
    })
  }), step)
  return page.ackedSequence
}

function safeInboxMessage(message, expectedAgentId, expectedSequence, step) {
  const item = requiredRecord(message, step)
  const payload = requiredRecord(item.payload, step)
  const messageType = typeof payload.type === 'string' && SAFE_MESSAGE_TYPE_PATTERN.test(payload.type)
    ? payload.type
    : undefined
  const superseded = item.disposition === 'superseded'
  if (!exactRecord(item, [
    'schemaVersion',
    'type',
    'inboxMessageId',
    'sequence',
    'status',
    'disposition',
    'createdAt',
    'recipientType',
    'recipientAgentId',
    'payload'
  ], ['expiresAt', 'supersededAt', 'supersededByMessageId']) ||
      item.schemaVersion !== 1 || item.type !== 'inbox_message' || item.recipientType !== 'agent' ||
      item.recipientAgentId !== expectedAgentId || item.sequence !== expectedSequence ||
      !Number.isSafeInteger(item.sequence) || item.sequence < 1 ||
      !['active', 'superseded'].includes(item.disposition) ||
      !['pending', 'superseded'].includes(item.status) ||
      (item.status === 'superseded') !== superseded ||
      Object.hasOwn(item, 'supersededAt') !== superseded ||
      !protocolTimestamp(item.createdAt) ||
      (item.expiresAt !== undefined && !protocolTimestamp(item.expiresAt)) ||
      (item.supersededAt !== undefined && !protocolTimestamp(item.supersededAt)) ||
      (!superseded && item.supersededByMessageId !== undefined) || !messageType) {
    fail('response_contract_rejected', { step })
  }
  requiredId(item.inboxMessageId, 'ibx', step)
  if (item.supersededByMessageId !== undefined) {
    requiredId(item.supersededByMessageId, 'ibx', step)
  }
  return { item, payload, messageType }
}

async function collectAndAcknowledgeInbox(options, state, {
  principal,
  baseline,
  step,
  allowedActive,
  target,
  targetSatisfied,
  notifiedThroughSequence
}) {
  let readCursor = baseline
  const collected = []
  let targetIndex = -1
  while (collected.length < MAX_INBOX_SCAN_MESSAGES) {
    const page = exactInboxPage(await requestJson(options, {
      step: `${step}-pull`,
      path: '/v1/commands',
      method: 'POST',
      bearer: principal.agentBearer,
      body: nextCommand(state, 'inbox.pull', {
        recipientType: 'agent',
        afterSequence: readCursor,
        limit: Math.min(1_000, MAX_INBOX_SCAN_MESSAGES - collected.length)
      })
    }), `${step}-pull`)
    if (page.ackedSequence !== baseline) {
      fail('inbox_cursor_changed', { step })
    }
    for (const message of page.messages) {
      readCursor += 1
      const parsed = safeInboxMessage(message, principal.agentId, readCursor, step)
      collected.push(parsed)
      const matchesTarget = target(parsed.payload)
      if (matchesTarget &&
          (parsed.item.disposition !== 'active' || parsed.item.status !== 'pending')) {
        fail('inbox_target_not_active', {
          step,
          sequence: parsed.item.sequence,
          messageType: parsed.messageType
        })
      }
      if (matchesTarget && (!targetSatisfied || targetSatisfied(parsed.payload))) {
        targetIndex = collected.length - 1
        break
      }
    }
    if (targetIndex >= 0) break
    if (page.messages.length === 0) {
      if (performance.now() >= options.deadlineAt) fail('acceptance_deadline_exceeded', { step })
      await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 100))
    }
  }
  if (targetIndex < 0) fail('inbox_target_not_found', { step })
  const targetSequence = collected[targetIndex].item.sequence
  if (notifiedThroughSequence !== undefined &&
      (!Number.isSafeInteger(notifiedThroughSequence) || notifiedThroughSequence < targetSequence)) {
    fail('websocket_target_notification_missing', { step })
  }
  const throughTarget = collected.slice(0, targetIndex + 1)
  let acknowledgedSequence = baseline
  for (const { item, payload, messageType } of throughTarget) {
    if (item.disposition === 'active' && !allowedActive(payload)) {
      principal.inboxGap = Object.freeze({ sequence: item.sequence, messageType })
      fail('inbox_unrelated_active_gap', { step, sequence: item.sequence, messageType })
    }
    if (item.disposition === 'superseded') {
      principal.supersededSequences.push(item.sequence)
    }
    const acknowledgement = requiredRecord(await requestJson(options, {
      step: `${step}-ack`,
      path: '/v1/commands',
      method: 'POST',
      bearer: principal.agentBearer,
      body: nextCommand(state, 'inbox.ack', {
        inboxMessageId: item.inboxMessageId,
        sequence: item.sequence
      })
    }), `${step}-ack`)
    if (acknowledgement.protocolVersion !== '1.0' || acknowledgement.type !== 'inbox.acked' ||
        acknowledgement.ackedSequence !== item.sequence ||
        !Number.isSafeInteger(acknowledgement.nextSequence) ||
        acknowledgement.nextSequence <= acknowledgement.ackedSequence) {
      fail('response_contract_rejected', { step: `${step}-ack` })
    }
    acknowledgedSequence = acknowledgement.ackedSequence
  }
  return { acknowledgedSequence, targetSequence }
}

async function assertFreshCleanupPrincipal(principal, now) {
  const claims = inspectOidcToken(
    principal.cleanupBearer,
    Math.floor(currentDate(now).getTime() / 1_000),
    {
      maximumAuthenticationAgeSeconds: securityPolicy.revokeMaximumAuthenticationAgeSeconds,
      minimumRemainingSeconds: securityPolicy.runtimeMinimumTokenRemainingSeconds
    }
  )
  assertSameOidcPrincipal(principal.initialClaims, claims)
}

async function revokeDevice(options, state, principal, now, step) {
  await assertFreshCleanupPrincipal(principal, now)
  const revoked = deviceFromResponse(await requestJson(options, {
    step,
    path: `/v1/me/devices/${principal.deviceId}`,
    method: 'DELETE',
    bearer: principal.cleanupBearer,
    body: {
      deviceId: principal.deviceId,
      idempotencyKey: `idem_adp_${principal.label}_revoke_${state.runId}`
    }
  }), 'revoked', step)
  if (revoked.deviceId !== principal.deviceId) fail('response_contract_rejected', { step })
  principal.deviceStatus = 'revoked'
}

async function assertOldAgentRejected(options, state, principal, step) {
  const rejected = await requestJson(options, {
    step,
    path: '/v1/commands',
    method: 'POST',
    expectedStatus: 401,
    bearer: principal.agentBearer,
    body: nextCommand(state, 'agent.heartbeat', {
      agentId: principal.agentId,
      expectedRevision: principal.agentRevision,
      connectionStatus: 'offline',
      capabilities: []
    })
  })
  if (rejected.protocolVersion !== '1.0' || rejected.type !== 'rest.error' ||
      rejected.error?.code !== 'credential_revoked' || rejected.error?.retryable !== false) {
    fail('old_agent_not_rejected', { step })
  }
  principal.agentCredentialStatus = 'credential_revoked'
}

async function bestEffortRevokeFirstCleanup(options, state, now) {
  for (const principal of [...state.workers, state.owner]) {
    if (!principal.cleanupBearerValidated || !principal.deviceId || principal.deviceStatus === 'revoked') continue
    try {
      await revokeDevice(options, state, principal, now, `cleanup-${principal.label}-device-revoke`)
    } catch {
      // Try the other Device before any domain cleanup; preserve the primary failure.
    }
  }
  if (!state.owner.initialBearerValidated) return
  for (const worker of state.workers) {
    if (!worker.taskId || !worker.executionId || !worker.taskStatus ||
        ['cancelled', 'succeeded', 'failed', 'rejected'].includes(worker.taskStatus)) continue
    try {
      const current = exactTask(await requestJson(options, {
        step: `cleanup-${worker.label}-task-get`,
        path: '/v1/commands',
        method: 'POST',
        bearer: state.owner.initialBearer,
        body: nextCommand(state, 'task.get', { taskId: worker.taskId })
      }), worker.taskId, worker.executionId, undefined, `cleanup-${worker.label}-task-get`)
      worker.taskStatus = current.status
      if (!['cancelled', 'succeeded', 'failed', 'rejected'].includes(current.status)) {
        const cancelled = exactTask(await requestJson(options, {
          step: `cleanup-${worker.label}-task-cancel`,
          path: '/v1/commands',
          method: 'POST',
          bearer: state.owner.initialBearer,
          body: nextCommand(state, 'task.transition', {
            taskId: worker.taskId,
            executionId: worker.executionId,
            expectedRevision: requiredRevision(current.revision, `cleanup-${worker.label}-task-get`),
            status: 'cancelled'
          })
        }), worker.taskId, worker.executionId, 'cancelled', `cleanup-${worker.label}-task-cancel`)
        worker.taskStatus = cancelled.status
      }
    } catch {
      // Cleanup is best effort and cannot replace the primary failure.
    }
  }
  if (state.projectId && !['completed', 'cancelled'].includes(state.projectStatus)) {
    try {
      const current = exactEntity(await requestJson(options, {
        step: 'cleanup-project-get',
        path: '/v1/commands',
        method: 'POST',
        bearer: state.owner.initialBearer,
        body: nextCommand(state, 'project.get', { projectId: state.projectId })
      }), 'project', 'cleanup-project-get')
      state.projectStatus = current.status
      if (!['completed', 'cancelled'].includes(current.status)) {
        const cancelled = exactEntity(await requestJson(options, {
          step: 'cleanup-project-cancel',
          path: '/v1/commands',
          method: 'POST',
          bearer: state.owner.initialBearer,
          body: nextCommand(state, 'project.transition', {
            projectId: state.projectId,
            expectedRevision: requiredRevision(current.revision, 'cleanup-project-get'),
            status: 'cancelled'
          })
        }), 'project', 'cleanup-project-cancel')
        if (cancelled.projectId === state.projectId) state.projectStatus = cancelled.status
      }
    } catch {
      // Cleanup is best effort and cannot replace the primary failure.
    }
  }
}

async function quiesceConcurrentBranches(branches) {
  const outcomes = await Promise.allSettled(branches)
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
  if (rejected) throw rejected.reason
}

export async function runMultiWorkerAcceptance(rawOptions) {
  const baseUrl = normalizeHttpsBaseUrl(rawOptions.baseUrl, 'base-url')
  if (baseUrl !== securityPolicy.expectedCloudBaseUrl) {
    fail('configuration_rejected', { field: 'base-url' })
  }
  const commit = typeof rawOptions.commit === 'string' && COMMIT_PATTERN.test(rawOptions.commit)
    ? rawOptions.commit
    : fail('configuration_rejected', { field: 'commit' })
  const expectedMultiWorkerHarnessSha256 = rawOptions.expectedMultiWorkerHarnessSha256
  if (typeof expectedMultiWorkerHarnessSha256 !== 'string' ||
      !SHA256_PATTERN.test(expectedMultiWorkerHarnessSha256)) {
    fail('configuration_rejected', { field: 'expected-multi-worker-harness-sha256' })
  }
  const expectedIdentityHarnessSha256 = typeof rawOptions.expectedIdentityHarnessSha256 === 'string' &&
    SHA256_PATTERN.test(rawOptions.expectedIdentityHarnessSha256)
    ? rawOptions.expectedIdentityHarnessSha256
    : fail('configuration_rejected', { field: 'expected-identity-harness-sha256' })
  const multiWorkerHarnessSha256 = await secureRegularFileSha256(import.meta.url)
  const identityHarnessSha256 = await secureRegularFileSha256(
    new URL('./collaboration-a-identity-acceptance.mjs', import.meta.url)
  )
  if (multiWorkerHarnessSha256 !== expectedMultiWorkerHarnessSha256 ||
      identityHarnessSha256 !== expectedIdentityHarnessSha256) {
    fail('harness_integrity_rejected')
  }
  const inputs = await workerInputs(rawOptions)
  const runId = rawOptions.runId ?? randomBytes(12).toString('hex')
  if (!RUN_ID_PATTERN.test(runId)) fail('configuration_rejected', { field: 'run-id' })
  if (rawOptions.fetch === undefined || rawOptions.webSocketFactory === undefined) {
    assertSafeGlobalFetchEnvironment(process.env)
  }
  const fetchImplementation = rawOptions.fetch ?? globalThis.fetch
  const webSocketFactory = rawOptions.webSocketFactory ?? ((url, init) => new WebSocket(url, init))
  if (typeof fetchImplementation !== 'function' || typeof webSocketFactory !== 'function') {
    fail('configuration_rejected', { field: 'network-implementation' })
  }
  const deadlineMs = boundedInteger(
    rawOptions.deadlineMs,
    Math.min(
      BASE_ACCEPTANCE_DEADLINE_MS + (inputs.length - 1) * PER_ADDITIONAL_WORKER_DEADLINE_MS,
      MAX_ACCEPTANCE_DEADLINE_MS
    ),
    5_000,
    MAX_ACCEPTANCE_DEADLINE_MS,
    'deadline-ms'
  )
  const requestTimeoutMs = boundedInteger(
    rawOptions.requestTimeoutMs,
    securityPolicy.defaultRequestTimeoutMs,
    100,
    securityPolicy.defaultRequestTimeoutMs,
    'request-timeout-ms'
  )
  const webSocketTimeoutMs = boundedInteger(
    rawOptions.webSocketTimeoutMs,
    WEBSOCKET_TIMEOUT_MS,
    20,
    WEBSOCKET_TIMEOUT_MS,
    'websocket-timeout-ms'
  )
  const now = rawOptions.now ?? (() => new Date())
  const options = {
    baseUrl,
    commit,
    fetch: fetchImplementation,
    webSocketFactory,
    webSocketTimeoutMs,
    requestTimeoutMs,
    now,
    deadlineAt: performance.now() + deadlineMs
  }
  const state = {
    commit,
    multiWorkerHarnessSha256,
    identityHarnessSha256,
    runId,
    commandOrdinal: 0,
    oidcPrincipalsDistinct: false,
    owner: principalState('owner'),
    workers: inputs.map((_, index) => principalState(`worker${index + 1}`)),
    projectStatus: 'not_created'
  }
  const workerChannels = new Map()
  try {
    await preflightPrincipal(exactWorkerInput({
      tokenFile: rawOptions.ownerTokenFile,
      revokeTokenFile: rawOptions.ownerRevokeTokenFile
    }, 'owner-token-file'), state.owner, now)
    for (let index = 0; index < state.workers.length; index += 1) {
      await preflightPrincipal(inputs[index], state.workers[index], now)
    }
    const claimPrincipals = new Set()
    for (const principal of [state.owner, ...state.workers]) {
      const key = `${principal.initialClaims.issuer}\u0000${principal.initialClaims.subject}`
      if (claimPrincipals.has(key)) fail('oidc_principals_not_distinct')
      claimPrincipals.add(key)
    }
    state.oidcPrincipalsDistinct = true

    await quiesceConcurrentBranches([state.owner, ...state.workers].map((principal) => (
      resolvePrincipal(options, principal)
    )))
    const userIds = new Set()
    const identityIds = new Set()
    for (const principal of [state.owner, ...state.workers]) {
      if (userIds.has(principal.userId) || identityIds.has(principal.oidcIdentityId)) {
        fail('oidc_principals_not_distinct')
      }
      userIds.add(principal.userId)
      identityIds.add(principal.oidcIdentityId)
    }

    await enrollPrincipal(options, state, state.owner, now, rawOptions)
    await quiesceConcurrentBranches(state.workers.map((worker) => (
      enrollPrincipal(options, state, worker, now, rawOptions)
    )))
    const deviceIds = new Set([state.owner.deviceId])
    const agentIds = new Set([state.owner.agentId])
    for (const worker of state.workers) {
      if (deviceIds.has(worker.deviceId) || agentIds.has(worker.agentId)) {
        fail('response_contract_rejected', { step: 'principal-enrollment-uniqueness' })
      }
      deviceIds.add(worker.deviceId)
      agentIds.add(worker.agentId)
    }
    await quiesceConcurrentBranches(state.workers.map(async (worker) => {
      worker.inboxBaseline = await inboxBaseline(
        options,
        state,
        worker,
        `${worker.label}-inbox-baseline`
      )
    }))
    state.coordinatorInboxBaseline = await inboxBaseline(
      options,
      state,
      state.owner,
      'coordinator-inbox-baseline'
    )

    await quiesceConcurrentBranches(state.workers.map(async (worker) => {
      const channel = createWebSocketChannel(options, worker.agentBearer)
      workerChannels.set(worker, channel)
      await channel.ready()
      worker.webSocketReady = true
      await channel.ping(`a-multi-worker-${worker.label}-${runId}`)
      worker.webSocketPong = true
    }))

    const project = exactEntity(await requestJson(options, {
      step: 'project-create',
      path: '/v1/commands',
      method: 'POST',
      bearer: state.owner.initialBearer,
      body: nextCommand(state, 'project.create', {
        ownerUserId: state.owner.userId,
        displayName: `A multi-worker acceptance ${runId}`,
        goal: 'Verify one OIDC Orchestrator dispatching independent Tasks to multiple distinct OIDC Workers.',
        memberUserIds: [state.owner.userId, ...state.workers.map((worker) => worker.userId)],
        coordinatorAgentId: state.owner.agentId,
        budget: {
          maxTasks: state.workers.length,
          maxTasksPerRound: state.workers.length,
          maxCoordinationRounds: 1,
          maxTaskRetries: 0
        }
      })
    }), 'project', 'project-create')
    state.projectId = requiredId(project.projectId, 'prj', 'project-create')
    state.projectStatus = project.status
    if (project.ownerUserId !== state.owner.userId ||
        project.coordinatorAgentId !== state.owner.agentId || project.status !== 'active' ||
        !Array.isArray(project.memberUserIds) ||
        project.memberUserIds.length !== state.workers.length + 1 ||
        ![state.owner, ...state.workers].every((principal) => (
          project.memberUserIds.includes(principal.userId)
        ))) {
      fail('response_contract_rejected', { step: 'project-create' })
    }
    let projectRevision = requiredRevision(project.revision, 'project-create')
    const taskIds = new Set()
    for (const worker of state.workers) {
      const step = `${worker.label}-task-create`
      const task = exactEntity(await requestJson(options, {
        step,
        path: '/v1/commands',
        method: 'POST',
        bearer: state.owner.initialBearer,
        body: nextCommand(state, 'task.create', {
          projectId: state.projectId,
          expectedRevision: projectRevision,
          assigneeAgentId: worker.agentId,
          title: 'A multi-worker Orchestrator to Worker Task',
          objective: 'Persist and complete one metadata-only Task on this distinct Worker Agent.',
          completionCriteria: ['This distinct Worker returns a structured accepted result.'],
          dependencyTaskIds: [],
          requiredCapabilities: {
            capabilityIds: [],
            vpnAccessIds: [],
            slurmClusterIds: [],
            requiredResourceRefIds: []
          },
          resourceRefIds: [],
          authorizationRequirements: []
        })
      }), 'task', step)
      worker.taskId = requiredId(task.taskId, 'tsk', step)
      worker.executionId = requiredId(task.executionId, 'exe', step)
      worker.taskStatus = task.status
      worker.taskRevision = requiredRevision(task.revision, step)
      if (taskIds.has(worker.taskId) || task.status !== 'offered' ||
          task.assigneeAgentId !== worker.agentId || task.assigneeUserId !== worker.userId ||
          task.createdByCoordinatorAgentId !== state.owner.agentId ||
          !Array.isArray(task.completionCriteria) || task.completionCriteria.length !== 1) {
        fail('response_contract_rejected', { step })
      }
      taskIds.add(worker.taskId)
      worker.criterionId = requiredId(task.completionCriteria[0]?.criterionId, 'cri', step)
      const refreshedProject = exactEntity(await requestJson(options, {
        step: `${worker.label}-project-revision-readback`,
        path: '/v1/commands',
        method: 'POST',
        bearer: state.owner.initialBearer,
        body: nextCommand(state, 'project.get', { projectId: state.projectId })
      }), 'project', `${worker.label}-project-revision-readback`)
      projectRevision = requiredRevision(refreshedProject.revision, `${worker.label}-project-revision-readback`)
    }

    await quiesceConcurrentBranches(state.workers.map(async (worker) => {
      let channel = workerChannels.get(worker)
      const availability = await channel.waitForInboxAbove(worker.inboxBaseline)
      worker.webSocketInboxAvailable = true
      worker.webSocketHighestSequence = availability.highestSequence
      channel.close()
      channel = createWebSocketChannel(options, worker.agentBearer)
      workerChannels.set(worker, channel)
      await channel.ready()
      await channel.ping(`a-multi-worker-reconnect-${worker.label}-${runId}`)
      worker.webSocketReconnected = true

      const workerInbox = await collectAndAcknowledgeInbox(options, state, {
        principal: worker,
        baseline: worker.inboxBaseline,
        step: `${worker.label}-task-offer-inbox`,
        allowedActive: (payload) => payload.type === 'task.offered' &&
          payload.projectId === state.projectId && payload.taskId === worker.taskId &&
          payload.executionId === worker.executionId,
        target: (payload) => payload.type === 'task.offered' &&
          payload.taskId === worker.taskId && payload.executionId === worker.executionId,
        notifiedThroughSequence: availability.highestSequence
      })
      worker.inboxAckedThrough = workerInbox.acknowledgedSequence
      worker.webSocketReplayPulled = true

      exactTask(await requestJson(options, {
        step: `${worker.label}-task-get-offered`,
        path: '/v1/commands',
        method: 'POST',
        bearer: worker.agentBearer,
        body: nextCommand(state, 'task.get', { taskId: worker.taskId })
      }), worker.taskId, worker.executionId, 'offered', `${worker.label}-task-get-offered`)

      for (const status of ['accepted', 'running']) {
        const transitioned = exactTask(await requestJson(options, {
          step: `${worker.label}-task-${status}`,
          path: '/v1/commands',
          method: 'POST',
          bearer: worker.agentBearer,
          body: nextCommand(state, 'task.transition', {
            taskId: worker.taskId,
            executionId: worker.executionId,
            expectedRevision: worker.taskRevision,
            status
          })
        }), worker.taskId, worker.executionId, status, `${worker.label}-task-${status}`)
        worker.taskStatus = transitioned.status
        worker.taskRevision = requiredRevision(transitioned.revision, `${worker.label}-task-${status}`)
      }

      const progressed = exactTask(await requestJson(options, {
        step: `${worker.label}-task-progress`,
        path: '/v1/commands',
        method: 'POST',
        bearer: worker.agentBearer,
        body: nextCommand(state, 'task.progress.report', {
          taskId: worker.taskId,
          executionId: worker.executionId,
          expectedRevision: worker.taskRevision,
          percent: 100,
          summary: 'Distinct Worker completed the metadata-only acceptance operation.'
        })
      }), worker.taskId, worker.executionId, 'running', `${worker.label}-task-progress`)
      if (progressed.progress?.percent !== 100) {
        fail('response_contract_rejected', { step: `${worker.label}-task-progress` })
      }
      worker.taskRevision = requiredRevision(progressed.revision, `${worker.label}-task-progress`)

      const succeeded = exactTask(await requestJson(options, {
        step: `${worker.label}-task-succeed`,
        path: '/v1/commands',
        method: 'POST',
        bearer: worker.agentBearer,
        body: nextCommand(state, 'task.transition', {
          taskId: worker.taskId,
          executionId: worker.executionId,
          expectedRevision: worker.taskRevision,
          status: 'succeeded',
          result: {
            summary: 'Distinct OIDC Worker completed its A acceptance Task.',
            criterionEvidence: [{
              criterionId: worker.criterionId,
              summary: 'The Worker accepted, ran, reported progress, and returned this structured result.',
              resourceRefIds: []
            }],
            resourceRefIds: [],
            logSummary: 'No task content or credentials are included in this acceptance receipt.'
          }
        })
      }), worker.taskId, worker.executionId, 'succeeded', `${worker.label}-task-succeed`)
      worker.taskStatus = succeeded.status
      worker.taskRevision = requiredRevision(succeeded.revision, `${worker.label}-task-succeed`)
      worker.resultRecordId = requiredId(
        succeeded.resultProjectRecordId,
        'rec',
        `${worker.label}-task-succeed`
      )
      worker.resultStatus = 'proposed'

      exactTask(await requestJson(options, {
        step: `${worker.label}-coordinator-task-readback`,
        path: '/v1/commands',
        method: 'POST',
        bearer: state.owner.agentBearer,
        body: nextCommand(state, 'task.get', { taskId: worker.taskId })
      }), worker.taskId, worker.executionId, 'succeeded', `${worker.label}-coordinator-task-readback`)
    }))

    const expectedResultRecordIds = new Set(state.workers.map((worker) => worker.resultRecordId))
    const observedResultRecordIds = new Set()
    const coordinatorInbox = await collectAndAcknowledgeInbox(options, state, {
      principal: state.owner,
      baseline: state.coordinatorInboxBaseline,
      step: 'coordinator-result-inbox',
      allowedActive: (payload) => (
        payload.type === 'project.started' && payload.projectId === state.projectId
      ) || (
        payload.type === 'task.updated' && payload.projectId === state.projectId &&
        state.workers.some((worker) => payload.taskId === worker.taskId &&
          payload.executionId === worker.executionId)
      ) || (
        payload.type === 'project_record.submitted' && payload.projectId === state.projectId &&
        state.workers.some((worker) => payload.projectRecordId === worker.resultRecordId &&
          payload.sourceTaskId === worker.taskId && payload.sourceExecutionId === worker.executionId)
      ),
      target: (payload) => {
        return payload.type === 'project_record.submitted' &&
          expectedResultRecordIds.has(payload.projectRecordId)
      },
      targetSatisfied: (payload) => {
        observedResultRecordIds.add(payload.projectRecordId)
        return observedResultRecordIds.size === expectedResultRecordIds.size
      }
    })
    state.coordinatorInboxAckedThrough = coordinatorInbox.acknowledgedSequence

    await assertFreshCleanupPrincipal(state.owner, now)
    for (const worker of state.workers) {
      const resultRecord = exactEntity(await requestJson(options, {
        step: `${worker.label}-owner-result-readback`,
        path: '/v1/commands',
        method: 'POST',
        bearer: state.owner.cleanupBearer,
        body: nextCommand(state, 'project_record.get', {
          projectRecordId: worker.resultRecordId
        })
      }), 'project_record', `${worker.label}-owner-result-readback`)
      if (resultRecord.projectRecordId !== worker.resultRecordId ||
          resultRecord.projectId !== state.projectId || resultRecord.kind !== 'task_result' ||
          resultRecord.status !== 'proposed' || resultRecord.sourceTaskId !== worker.taskId ||
          resultRecord.sourceExecutionId !== worker.executionId) {
        fail('response_contract_rejected', { step: `${worker.label}-owner-result-readback` })
      }
      const acceptedResult = exactEntity(await requestJson(options, {
        step: `${worker.label}-owner-result-accept`,
        path: '/v1/commands',
        method: 'POST',
        bearer: state.owner.cleanupBearer,
        body: nextCommand(state, 'project_record.accept', {
          projectRecordId: worker.resultRecordId,
          expectedRevision: requiredRevision(
            resultRecord.revision,
            `${worker.label}-owner-result-readback`
          ),
          decision: 'accepted'
        })
      }), 'project_record', `${worker.label}-owner-result-accept`)
      if (acceptedResult.projectRecordId !== worker.resultRecordId ||
          acceptedResult.projectId !== state.projectId || acceptedResult.status !== 'accepted') {
        fail('response_contract_rejected', { step: `${worker.label}-owner-result-accept` })
      }
      worker.resultStatus = acceptedResult.status
    }

    const currentProject = exactEntity(await requestJson(options, {
      step: 'owner-project-readback',
      path: '/v1/commands',
      method: 'POST',
      bearer: state.owner.cleanupBearer,
      body: nextCommand(state, 'project.get', { projectId: state.projectId })
    }), 'project', 'owner-project-readback')
    const completedProject = exactEntity(await requestJson(options, {
      step: 'owner-project-complete',
      path: '/v1/commands',
      method: 'POST',
      bearer: state.owner.cleanupBearer,
      body: nextCommand(state, 'project.transition', {
        projectId: state.projectId,
        expectedRevision: requiredRevision(currentProject.revision, 'owner-project-readback'),
        status: 'completed'
      })
    }), 'project', 'owner-project-complete')
    if (completedProject.projectId !== state.projectId || completedProject.status !== 'completed') {
      fail('response_contract_rejected', { step: 'owner-project-complete' })
    }
    state.projectStatus = completedProject.status

    for (const worker of state.workers) {
      await revokeDevice(options, state, worker, now, `${worker.label}-device-revoke`)
      await workerChannels.get(worker).assertRevocationClosed(`a-multi-worker-revoked-${worker.label}-${runId}`)
      worker.webSocketRevocationClosed = true
    }
    await revokeDevice(options, state, state.owner, now, 'owner-device-revoke')
    for (const worker of state.workers) {
      listedDevice(await requestJson(options, {
        step: `${worker.label}-device-list-revoked`,
        path: '/v1/me/devices',
        bearer: worker.cleanupBearer
      }), worker.deviceId, 'revoked', `${worker.label}-device-list-revoked`)
    }
    listedDevice(await requestJson(options, {
      step: 'owner-device-list-revoked',
      path: '/v1/me/devices',
      bearer: state.owner.cleanupBearer
    }), state.owner.deviceId, 'revoked', 'owner-device-list-revoked')

    await assertOldAgentRejected(options, state, state.owner, 'old-owner-agent-rejected')
    for (const worker of state.workers) {
      await assertOldAgentRejected(options, state, worker, `old-${worker.label}-agent-rejected`)
    }
    state.verifiedAtUtc = timestamp(now)
    return Object.freeze(safeRunState(state))
  } catch (error) {
    const cleanupOptions = {
      ...options,
      deadlineAt: performance.now() + Math.min(
        BASE_CLEANUP_DEADLINE_MS +
          (state.workers.length - 1) * PER_ADDITIONAL_WORKER_CLEANUP_DEADLINE_MS,
        MAX_CLEANUP_DEADLINE_MS
      )
    }
    await bestEffortRevokeFirstCleanup(cleanupOptions, state, now)
    const code = error instanceof AcceptanceFailure ? error.code : 'internal_harness_error'
    throw new AcceptanceFailure(code, safeRunState(state, code))
  } finally {
    for (const channel of workerChannels.values()) channel.close()
  }
}

export function parseMultiWorkerAcceptanceConfiguration(argv, environment = process.env) {
  const allowed = new Set([
    '--base-url',
    '--owner-token-file',
    '--owner-revoke-token-file',
    '--worker-descriptor-file',
    '--commit',
    '--expected-multi-worker-harness-sha256',
    '--expected-identity-harness-sha256'
  ])
  const values = new Map()
  const workerDescriptorFiles = []
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (!allowed.has(argument) || index + 1 >= argv.length ||
        (argument !== '--worker-descriptor-file' && values.has(argument))) {
      fail('configuration_rejected')
    }
    if (argument === '--worker-descriptor-file') {
      workerDescriptorFiles.push(argv[index + 1])
      if (workerDescriptorFiles.length > MAX_WORKERS) fail('configuration_rejected')
    } else {
      values.set(argument, argv[index + 1])
    }
    index += 1
  }
  if (help) return Object.freeze({ help: true })
  let environmentDescriptorFiles
  if (workerDescriptorFiles.length === 0 &&
      typeof environment.SCIFORGE_WORKER_DESCRIPTOR_FILES_JSON === 'string') {
    try {
      environmentDescriptorFiles = JSON.parse(environment.SCIFORGE_WORKER_DESCRIPTOR_FILES_JSON)
    } catch {
      fail('configuration_rejected')
    }
    if (!Array.isArray(environmentDescriptorFiles) ||
        environmentDescriptorFiles.some((value) => typeof value !== 'string')) {
      fail('configuration_rejected')
    }
  }
  const configuredDescriptors = workerDescriptorFiles.length > 0
    ? workerDescriptorFiles
    : environmentDescriptorFiles
  const configuration = {
    baseUrl: values.get('--base-url') ?? environment.SCIFORGE_CLOUD_BASE_URL,
    ownerTokenFile: values.get('--owner-token-file') ?? environment.SCIFORGE_OWNER_OIDC_ACCESS_TOKEN_FILE,
    ownerRevokeTokenFile: values.get('--owner-revoke-token-file') ??
      environment.SCIFORGE_OWNER_OIDC_REVOKE_TOKEN_FILE,
    workerDescriptorFiles: configuredDescriptors === undefined
      ? undefined
      : Object.freeze([...configuredDescriptors]),
    commit: values.get('--commit') ?? environment.SCIFORGE_COLLAB_CONTRACT_COMMIT,
    expectedMultiWorkerHarnessSha256: values.get('--expected-multi-worker-harness-sha256') ??
      environment.SCIFORGE_MULTI_WORKER_ACCEPTANCE_HARNESS_SHA256,
    expectedIdentityHarnessSha256: values.get('--expected-identity-harness-sha256') ??
      environment.SCIFORGE_IDENTITY_ACCEPTANCE_HARNESS_SHA256
  }
  const requiredStrings = [
    configuration.baseUrl,
    configuration.ownerTokenFile,
    configuration.ownerRevokeTokenFile,
    configuration.commit,
    configuration.expectedMultiWorkerHarnessSha256,
    configuration.expectedIdentityHarnessSha256
  ]
  if (requiredStrings.some((value) => typeof value !== 'string' || value.length === 0) ||
      configuredDescriptors === undefined ||
      configuredDescriptors.length < MIN_RELEASE_WORKERS || configuredDescriptors.length > MAX_WORKERS) {
    fail('configuration_rejected')
  }
  return Object.freeze(configuration)
}

export function multiWorkerAcceptanceUsage() {
  return [
    'Usage: node scripts/collaboration-a-multi-worker-acceptance.mjs [options]',
    '       (A multi-worker acceptance: one Orchestrator -> 2..8 Workers)',
    '',
    'Required (flags or environment):',
    '  --base-url URL                  SCIFORGE_CLOUD_BASE_URL',
    '  --owner-token-file PATH         SCIFORGE_OWNER_OIDC_ACCESS_TOKEN_FILE',
    '  --owner-revoke-token-file PATH  SCIFORGE_OWNER_OIDC_REVOKE_TOKEN_FILE',
    '  --worker-descriptor-file PATH   repeat 2..8 times; each is an owned 0600 JSON file',
    '                                      or SCIFORGE_WORKER_DESCRIPTOR_FILES_JSON',
    '  --commit SHA                    SCIFORGE_COLLAB_CONTRACT_COMMIT',
    '  --expected-multi-worker-harness-sha256 SHA',
    '                                      SCIFORGE_MULTI_WORKER_ACCEPTANCE_HARNESS_SHA256',
    '  --expected-identity-harness-sha256 SHA',
    '                                      SCIFORGE_IDENTITY_ACCEPTANCE_HARNESS_SHA256',
    '',
    'Worker descriptor exact shape:',
    '  {"accessTokenFile":"/absolute/0600/token","revokeTokenFile":"/absolute/0600/token"}',
    '',
    'Every descriptor and token input must be an absolute, current-user-owned 0600 regular file.',
    'Owner and all 2..8 Workers must be pairwise-distinct OIDC principals.',
    'Paths, token claims, tokens, and Agent credentials are never printed.'
  ].join('\n')
}

async function main() {
  try {
    const configuration = parseMultiWorkerAcceptanceConfiguration(process.argv.slice(2))
    if (configuration.help) {
      process.stdout.write(`${multiWorkerAcceptanceUsage()}\n`)
      return
    }
    const receipt = await runMultiWorkerAcceptance(configuration)
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } catch (error) {
    const failure = error instanceof AcceptanceFailure && isRecord(error.safeFacts) && error.safeFacts.type
      ? error.safeFacts
      : {
          type: 'sciforge.a.multi_worker_acceptance.receipt',
          status: 'failed',
          code: error instanceof AcceptanceFailure ? error.code : 'internal_harness_error'
        }
    process.stderr.write(`${JSON.stringify(failure)}\n`)
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) await main()
