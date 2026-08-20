#!/usr/bin/env node

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes
} from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MAX_TOKEN_BYTES = 16 * 1024
const MAX_HARNESS_BYTES = 512 * 1024
const MAX_HEADER_SEGMENT_BYTES = 2 * 1024
const MAX_PAYLOAD_SEGMENT_BYTES = 12 * 1024
const MAX_SIGNATURE_SEGMENT_BYTES = 2 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const ACCEPTANCE_DEADLINE_MS = 40_000
const CLEANUP_DEADLINE_MS = 15_000
const PREFLIGHT_MIN_TOKEN_REMAINING_SECONDS = 180
const RUNTIME_MIN_TOKEN_REMAINING_SECONDS = 120
const REVOKE_AUTH_MAX_AGE_SECONDS = 240
const REVOKE_PREFLIGHT_MAX_AGE_SECONDS = 180
const REQUIRED_AUDIENCE = 'sciforge-cloud-api'
const EXPECTED_ISSUER = 'https://login-test.sciforge.cn/realms/SciForge'
const EXPECTED_CLOUD_BASE_URL = 'https://cloud-test.sciforge.cn'
const ALLOWED_AUTHORIZED_PARTIES = new Set(['sciforge-desktop', 'sciforge-web-mobile'])
const UNSAFE_GLOBAL_FETCH_ENVIRONMENT_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
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
])
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const RUN_ID_PATTERN = /^[a-f0-9]{24}$/u
const OPAQUE_ID_PATTERN = (prefix) => new RegExp(`^${prefix}_[A-Za-z0-9](?:[A-Za-z0-9_]{10,62}[A-Za-z0-9])$`, 'u')

class AcceptanceFailure extends Error {
  constructor(code, safeFacts = {}) {
    super('The A identity acceptance harness stopped at a fail-closed boundary.')
    this.name = 'AcceptanceFailure'
    this.code = code
    this.safeFacts = Object.freeze({ ...safeFacts })
  }
}

function fail(code, safeFacts) {
  throw new AcceptanceFailure(code, safeFacts)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeString(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : undefined
}

function requiredId(value, prefix, step) {
  const id = safeString(value, OPAQUE_ID_PATTERN(prefix))
  if (!id) fail('response_contract_rejected', { step })
  return id
}

function requiredRevision(value, step) {
  if (!Number.isSafeInteger(value) || value < 1) fail('response_contract_rejected', { step })
  return value
}

function requiredTimestamp(value, step) {
  if (typeof value !== 'string' || value.length > 64 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    fail('response_contract_rejected', { step })
  }
  return value
}

function currentDate(now) {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('configuration_rejected', { field: 'clock' })
  }
  return value
}

function assertSafeGlobalFetchEnvironment(environment) {
  // This is a secondary fail-closed check. A launcher must clear preload-related
  // variables before starting Node because any preload has already executed here.
  if (!isRecord(environment)) fail('configuration_rejected', { field: 'network-environment' })
  for (const [key, value] of Object.entries(environment)) {
    if (UNSAFE_GLOBAL_FETCH_ENVIRONMENT_KEYS.has(key.toUpperCase()) &&
        typeof value === 'string' && value.length > 0) {
      fail('configuration_rejected', { field: 'network-environment' })
    }
  }
}

async function currentHarnessSha256() {
  if (fsConstants.O_NOFOLLOW === undefined) fail('harness_integrity_rejected')
  let handle
  try {
    handle = await open(fileURLToPath(import.meta.url), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_HARNESS_BYTES)) {
      fail('harness_integrity_rejected')
    }
    const source = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      fail('harness_integrity_rejected')
    }
    return createHash('sha256').update(source).digest('hex')
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error
    fail('harness_integrity_rejected')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function requiredRecord(value, step) {
  if (!isRecord(value)) fail('response_contract_rejected', { step })
  return value
}

function exactEntity(value, entityType, step) {
  const response = requiredRecord(value, step)
  if (response.protocolVersion !== '1.0' || response.type !== 'rest.entity') {
    fail('response_contract_rejected', { step })
  }
  const entity = requiredRecord(response.entity, step)
  if (entity.type !== entityType) fail('response_contract_rejected', { step })
  return entity
}

function exactTask(value, taskId, executionId, expectedStatus, step) {
  const task = exactEntity(value, 'task', step)
  if (task.taskId !== taskId || task.executionId !== executionId ||
      (expectedStatus !== undefined && task.status !== expectedStatus)) {
    fail('response_contract_rejected', { step })
  }
  return task
}

function meIdentity(value, step) {
  const me = requiredRecord(value, step)
  if (me.type !== 'me' || me.schemaVersion !== 1 || me.status !== 'active' || me.issuer !== EXPECTED_ISSUER ||
      typeof me.displayName !== 'string' || me.displayName.length === 0 || me.displayName.length > 200) {
    fail('response_contract_rejected', { step })
  }
  const identity = Object.freeze({
    userId: requiredId(me.userId, 'usr', step),
    oidcIdentityId: requiredId(me.oidcIdentityId, 'oid', step),
    issuer: me.issuer
  })
  requiredRevision(me.revision, step)
  requiredTimestamp(me.createdAt, step)
  requiredTimestamp(me.updatedAt, step)
  return identity
}

function normalizeHttpsBaseUrl(value, label, { originOnly = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.length > 2_048) {
    fail('configuration_rejected', { field: label })
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail('configuration_rejected', { field: label })
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('configuration_rejected', { field: label })
  }
  if (/%/u.test(parsed.pathname) || !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?\/?$/u.test(parsed.pathname)) {
    fail('configuration_rejected', { field: label })
  }
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/u, '')
  if (originOnly && path) fail('configuration_rejected', { field: label })
  return `${parsed.origin}${path}`
}

function endpoint(baseUrl, path) {
  if (!path.startsWith('/')) fail('internal_harness_error')
  return `${baseUrl}${path}`
}

function stripSingleTerminalNewline(value) {
  if (value.endsWith('\r\n')) return value.slice(0, -2)
  if (value.endsWith('\n')) return value.slice(0, -1)
  return value
}

export async function readSecureOidcTokenFile(filename) {
  if (typeof filename !== 'string' || !isAbsolute(filename) || fsConstants.O_NOFOLLOW === undefined) {
    fail('token_file_rejected')
  }
  let handle
  try {
    handle = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    const mode = Number(before.mode & 0o7777n)
    const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined
    if (!before.isFile() || before.nlink !== 1n || mode !== 0o600 ||
        (currentUid !== undefined && before.uid !== currentUid) ||
        before.size < 16n || before.size > BigInt(MAX_TOKEN_BYTES)) {
      fail('token_file_rejected')
    }
    const source = await handle.readFile({ encoding: 'utf8' })
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      fail('token_file_changed')
    }
    const token = stripSingleTerminalNewline(source)
    if (token.length < 16 || Buffer.byteLength(token) > MAX_TOKEN_BYTES || /\s/u.test(token)) {
      fail('token_file_rejected')
    }
    return token
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error
    fail('token_file_rejected')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function decodeCanonicalBase64UrlJson(value) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    fail('oidc_token_rejected')
  }
  let decoded
  try {
    decoded = Buffer.from(value, 'base64url')
  } catch {
    fail('oidc_token_rejected')
  }
  if (decoded.length === 0 || decoded.toString('base64url') !== value) fail('oidc_token_rejected')
  let parsed
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded))
  } catch {
    fail('oidc_token_rejected')
  }
  if (!isRecord(parsed)) fail('oidc_token_rejected')
  return parsed
}

function numericClaim(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('oidc_token_rejected')
  return value
}

function hasAsciiControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

function boundedClaimString(value, maximumLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength ||
      hasAsciiControlCharacter(value)) {
    fail('oidc_token_rejected')
  }
  return value
}

function inspectOidcToken(token, nowSeconds, {
  maximumAuthenticationAgeSeconds,
  minimumRemainingSeconds = PREFLIGHT_MIN_TOKEN_REMAINING_SECONDS
} = {}) {
  const segments = token.split('.')
  if (segments.length !== 3 || !segments.every((segment) => /^[A-Za-z0-9_-]+$/u.test(segment))) {
    fail('oidc_token_rejected')
  }
  if (segments[0].length > MAX_HEADER_SEGMENT_BYTES || segments[1].length > MAX_PAYLOAD_SEGMENT_BYTES ||
      segments[2].length > MAX_SIGNATURE_SEGMENT_BYTES) {
    fail('oidc_token_rejected')
  }
  const header = decodeCanonicalBase64UrlJson(segments[0])
  const claims = decodeCanonicalBase64UrlJson(segments[1])
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' ||
      !/^[A-Za-z0-9._~-]{1,128}$/u.test(header.kid) ||
      (header.typ !== undefined && !['JWT', 'at+jwt'].includes(header.typ)) ||
      Object.keys(header).some((field) => !['alg', 'kid', 'typ'].includes(field))) {
    fail('oidc_token_rejected')
  }
  const signature = Buffer.from(segments[2], 'base64url')
  if (signature.toString('base64url') !== segments[2] || signature.length < 128 || signature.length > 1_024) {
    fail('oidc_token_rejected')
  }
  const issuer = boundedClaimString(claims.iss, 2_048)
  const subject = boundedClaimString(claims.sub, 512)
  if (issuer !== EXPECTED_ISSUER) fail('oidc_token_rejected')
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud
  if (!Array.isArray(audiences) || audiences.length === 0 || audiences.length > 16 ||
      audiences.some((audience) => boundedClaimString(audience, 256) !== audience) ||
      new Set(audiences).size !== audiences.length || !audiences.includes(REQUIRED_AUDIENCE) ||
      !ALLOWED_AUTHORIZED_PARTIES.has(boundedClaimString(claims.azp, 128))) {
    fail('oidc_token_rejected')
  }
  const expiresAt = numericClaim(claims.exp)
  const notBefore = numericClaim(claims.nbf)
  const issuedAt = numericClaim(claims.iat)
  const authTime = numericClaim(claims.auth_time)
  if (!Number.isSafeInteger(minimumRemainingSeconds) || minimumRemainingSeconds < 0 ||
      notBefore > nowSeconds || issuedAt > nowSeconds || expiresAt < nowSeconds + minimumRemainingSeconds ||
      expiresAt <= notBefore || expiresAt <= issuedAt || authTime > issuedAt) {
    fail('oidc_token_rejected')
  }
  if (maximumAuthenticationAgeSeconds !== undefined) {
    const age = nowSeconds - authTime
    if (!Number.isSafeInteger(maximumAuthenticationAgeSeconds) || maximumAuthenticationAgeSeconds < 0 ||
        age < 0 || age > maximumAuthenticationAgeSeconds) {
      fail('oidc_reauthentication_required')
    }
  }
  return Object.freeze({ issuer, subject })
}

function assertSameOidcPrincipal(initial, candidate) {
  if (initial.issuer !== candidate.issuer || initial.subject !== candidate.subject) {
    fail('oidc_principal_mismatch')
  }
}

export function canonicalEnrollmentBytes(input) {
  const values = [
    'SCIFORGE-DEVICE-ENROLLMENT-V1',
    input.enrollmentId,
    input.nonce,
    input.userId,
    input.installationId,
    input.expiresAt
  ]
  if (values.some((value) => typeof value !== 'string' || value.length === 0 || /[\r\n]/u.test(value))) {
    fail('enrollment_contract_rejected')
  }
  return Buffer.from(values.join('\n'), 'utf8')
}

function platformFacts(platform = process.platform, architecture = process.arch) {
  const os = { darwin: 'macos', linux: 'linux', win32: 'windows' }[platform]
  const arch = architecture === 'arm64' ? 'arm64' : architecture === 'x64' ? 'x64' : undefined
  if (!os || !arch) fail('platform_not_supported')
  return Object.freeze({ os, arch })
}

async function readBoundedJson(response, step) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    fail('response_too_large', { step })
  }
  if (!response.body) fail('response_contract_rejected', { step })
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      length += chunk.length
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        fail('response_too_large', { step })
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)))
    if (!isRecord(value)) fail('response_contract_rejected', { step })
    return value
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error
    fail('response_contract_rejected', { step })
  }
}

function safeHttpFailure(value, step, status) {
  const response = isRecord(value) ? value : {}
  const error = isRecord(response.error) ? response.error : {}
  const errorCode = safeString(error.code, /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u)
  const requestId = safeString(response.requestId, OPAQUE_ID_PATTERN('req'))
  const traceId = safeString(error.traceId, OPAQUE_ID_PATTERN('trc'))
  return new AcceptanceFailure('http_request_rejected', {
    step,
    status,
    ...(errorCode ? { errorCode } : {}),
    ...(requestId ? { requestId } : {}),
    ...(traceId ? { traceId } : {})
  })
}

async function requestJson(options, request) {
  const controller = new AbortController()
  const remaining = Math.floor(options.deadlineAt - performance.now())
  if (remaining <= 0) fail('acceptance_deadline_exceeded', { step: request.step })
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, remaining)
  )
  timer.unref?.()
  const headers = new Headers({ accept: 'application/json' })
  if (request.bearer) headers.set('authorization', `Bearer ${request.bearer}`)
  if (request.body !== undefined) {
    headers.set('content-type', 'application/json')
    if (typeof request.body.idempotencyKey === 'string') {
      headers.set('idempotency-key', request.body.idempotencyKey)
    }
  }
  try {
    let response
    try {
      response = await options.fetch(endpoint(options.baseUrl, request.path), {
        method: request.method ?? 'GET',
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal
      })
    } catch {
      if (performance.now() >= options.deadlineAt) {
        fail('acceptance_deadline_exceeded', { step: request.step })
      }
      fail('network_request_failed', { step: request.step })
    }
    const revision = response.headers.get('x-sciforge-edge-revision')
    if (revision !== options.commit) fail('live_commit_mismatch', { step: request.step })
    const contentType = response.headers.get('content-type') ?? ''
    if (!/^application\/json(?:;|$)/iu.test(contentType)) {
      fail('response_contract_rejected', { step: request.step })
    }
    let body
    try {
      body = await readBoundedJson(response, request.step)
    } catch (error) {
      if (error instanceof AcceptanceFailure) throw error
      if (performance.now() >= options.deadlineAt) {
        fail('acceptance_deadline_exceeded', { step: request.step })
      }
      fail('network_request_failed', { step: request.step })
    }
    if (typeof request.body?.requestId === 'string' &&
        (body.protocolVersion !== '1.0' || body.requestId !== request.body.requestId)) {
      fail('response_contract_rejected', { step: request.step })
    }
    const expectedStatus = request.expectedStatus ?? 200
    if (response.status !== expectedStatus) throw safeHttpFailure(body, request.step, response.status)
    return body
  } finally {
    clearTimeout(timer)
  }
}

function command(runId, ordinal, type, fields = {}) {
  const suffix = `${String(ordinal).padStart(2, '0')}_${runId}`
  const body = {
    protocolVersion: '1.0',
    requestId: `req_aid_${suffix}`,
    type,
    ...fields
  }
  if (!type.endsWith('.get') && !['endpoint.catalog.get', 'inbox.pull'].includes(type)) {
    body.idempotencyKey = `idem_aid_${suffix}`
  }
  return body
}

function deviceFromResponse(value, expectedStatus, step) {
  const response = requiredRecord(value, step)
  const device = requiredRecord(response.device, step)
  if (device.type !== 'device' || device.status !== expectedStatus) fail('response_contract_rejected', { step })
  requiredId(device.deviceId, 'dev', step)
  requiredRevision(device.revision, step)
  return device
}

function listedDevice(value, deviceId, expectedStatus, step) {
  const response = requiredRecord(value, step)
  if (!Array.isArray(response.devices)) fail('response_contract_rejected', { step })
  const matches = response.devices.filter((device) => isRecord(device) && device.deviceId === deviceId)
  if (matches.length !== 1 || matches[0].type !== 'device' || matches[0].status !== expectedStatus) {
    fail('response_contract_rejected', { step })
  }
  requiredRevision(matches[0].revision, step)
  return matches[0]
}

function canonicalPublicJson(value) {
  if (Array.isArray(value)) return value.map(canonicalPublicJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalPublicJson(value[key])]))
}

function externalIdentitySnapshot(value, expectedUserId, step) {
  const response = requiredRecord(value, step)
  if (!Array.isArray(response.identities)) fail('response_contract_rejected', { step })
  const identities = response.identities.map((identity) => {
    const item = requiredRecord(identity, step)
    requiredId(item.externalIdentityId, 'xid', step)
    if (item.type !== 'external_identity' || item.provider !== 'zulip' || item.userId !== expectedUserId ||
        !['active', 'revoked'].includes(item.status)) {
      fail('response_contract_rejected', { step })
    }
    requiredRevision(item.revision, step)
    return canonicalPublicJson(item)
  })
  identities.sort((left, right) => String(left.externalIdentityId).localeCompare(String(right.externalIdentityId)))
  return JSON.stringify(identities)
}

async function runOptionalZulipFailClosed(options, oidcBearer, userId, runId, now) {
  if (!options.zulipRealmUrl) return undefined
  const before = externalIdentitySnapshot(await requestJson(options, {
    step: 'zulip-identities-before',
    path: '/v1/me/external-identities',
    bearer: oidcBearer
  }), userId, 'zulip-identities-before')
  const idempotencyKey = `idem_aid_zulip_begin_${runId}`
  const begun = requiredRecord(await requestJson(options, {
    step: 'zulip-binding-begin',
    path: '/v1/integrations/zulip/bindings',
    method: 'POST',
    bearer: oidcBearer,
    body: { realmUrl: options.zulipRealmUrl, idempotencyKey }
  }), 'zulip-binding-begin')
  const bindingRequestId = requiredId(begun.bindingRequestId, 'zbr', 'zulip-binding-begin')
  if (typeof begun.bindingCode !== 'string' || !/^[A-Z0-9][A-Z0-9-]{7,127}$/u.test(begun.bindingCode)) {
    fail('response_contract_rejected', { step: 'zulip-binding-begin' })
  }
  requiredTimestamp(begun.expiresAt, 'zulip-binding-begin')
  const bindingLifetime = Date.parse(begun.expiresAt) - currentDate(now).getTime()
  if (bindingLifetime <= 0 || bindingLifetime > 6 * 60_000) {
    fail('response_contract_rejected', { step: 'zulip-binding-begin' })
  }
  const confirmKey = `idem_aid_zulip_confirm_${runId}`
  const rejected = await requestJson(options, {
    step: 'zulip-binding-confirm',
    path: '/v1/integrations/zulip/bindings/confirm',
    method: 'POST',
    expectedStatus: 401,
    body: {
      bindingCode: begun.bindingCode,
      realmUrl: options.zulipRealmUrl,
      realmId: 'a-identity-acceptance-realm',
      zulipUserId: 'a-identity-acceptance-user',
      providerEventId: `a-identity-acceptance-${runId}`,
      idempotencyKey: confirmKey
    }
  })
  if (rejected.type !== 'rest.error' || rejected.error?.code !== 'authentication_required') {
    fail('zulip_fail_closed_boundary_rejected')
  }
  const after = externalIdentitySnapshot(await requestJson(options, {
    step: 'zulip-identities-after',
    path: '/v1/me/external-identities',
    bearer: oidcBearer
  }), userId, 'zulip-identities-after')
  if (before !== after) fail('zulip_external_identity_changed')
  return Object.freeze({ bindingRequestId, confirmStatus: 'authentication_required' })
}

function safeRunState(state, code = undefined) {
  return {
    type: 'sciforge.a.identity_acceptance.receipt',
    commit: state.commit,
    harnessSha256: state.harnessSha256,
    runId: state.runId,
    status: code ? 'failed' : 'succeeded',
    ...(code ? { code } : {}),
    ...(state.userId ? { userId: state.userId } : {}),
    ...(state.oidcIdentityId ? { oidcIdentityId: state.oidcIdentityId } : {}),
    ...(state.deviceId ? { deviceId: state.deviceId, deviceStatus: state.deviceStatus } : {}),
    ...(state.agentId ? { agentId: state.agentId, agentCredentialStatus: state.agentCredentialStatus } : {}),
    ...(state.projectId ? { projectId: state.projectId, projectStatus: state.projectStatus } : {}),
    ...(state.taskId ? { taskId: state.taskId, executionId: state.executionId, taskStatus: state.taskStatus } : {}),
    ...(state.resultRecordId ? { resultProjectRecordId: state.resultRecordId, resultStatus: state.resultStatus } : {}),
    ...(state.bindingRequestId ? {
      zulipBindingRequestId: state.bindingRequestId,
      zulipConfirmStatus: state.zulipConfirmStatus
    } : {})
  }
}

async function bestEffortCleanup(options, state, userBearer, freshRevokeBearer) {
  if (freshRevokeBearer && state.deviceId && state.deviceStatus !== 'revoked') {
    try {
      const idempotencyKey = `idem_aid_cleanup_revoke_${state.runId}`
      const revoked = deviceFromResponse(await requestJson(options, {
        step: 'cleanup-device-revoke',
        path: `/v1/me/devices/${state.deviceId}`,
        method: 'DELETE',
        bearer: freshRevokeBearer,
        body: { deviceId: state.deviceId, idempotencyKey }
      }), 'revoked', 'cleanup-device-revoke')
      state.deviceStatus = revoked.status
    } catch {
      // Cleanup is best effort and must not replace the primary failure.
    }
  }
  if (state.taskId && state.executionId) {
    try {
      const current = exactTask(await requestJson(options, {
        step: 'cleanup-task-get',
        path: '/v1/commands',
        method: 'POST',
        bearer: userBearer,
        body: command(state.runId, 90, 'task.get', { taskId: state.taskId })
      }), state.taskId, state.executionId, undefined, 'cleanup-task-get')
      state.taskStatus = current.status
      state.taskRevision = requiredRevision(current.revision, 'cleanup-task-get')
      if (!['cancelled', 'succeeded', 'failed', 'rejected'].includes(current.status)) {
        const cancelled = exactTask(await requestJson(options, {
          step: 'cleanup-task-cancel',
          path: '/v1/commands',
          method: 'POST',
          bearer: userBearer,
          body: command(state.runId, 91, 'task.transition', {
            taskId: state.taskId,
            executionId: state.executionId,
            expectedRevision: state.taskRevision,
            status: 'cancelled'
          })
        }), state.taskId, state.executionId, 'cancelled', 'cleanup-task-cancel')
        state.taskStatus = cancelled.status
        state.taskRevision = requiredRevision(cancelled.revision, 'cleanup-task-cancel')
      }
    } catch {
      // Cleanup is best effort and must not replace the primary failure.
    }
  }
  if (state.projectId && !['cancelled', 'completed'].includes(state.projectStatus)) {
    try {
      const current = exactEntity(await requestJson(options, {
        step: 'cleanup-project-get',
        path: '/v1/commands',
        method: 'POST',
        bearer: userBearer,
        body: command(state.runId, 92, 'project.get', { projectId: state.projectId })
      }), 'project', 'cleanup-project-get')
      if (current.projectId !== state.projectId) fail('response_contract_rejected', { step: 'cleanup-project-get' })
      state.projectStatus = current.status
      if (!['cancelled', 'completed'].includes(current.status)) {
        const cancelled = exactEntity(await requestJson(options, {
          step: 'cleanup-project-cancel',
          path: '/v1/commands',
          method: 'POST',
          bearer: userBearer,
          body: command(state.runId, 93, 'project.transition', {
            projectId: state.projectId,
            expectedRevision: requiredRevision(current.revision, 'cleanup-project-get'),
            status: 'cancelled'
          })
        }), 'project', 'cleanup-project-cancel')
        if (cancelled.projectId !== state.projectId || cancelled.status !== 'cancelled') {
          fail('response_contract_rejected', { step: 'cleanup-project-cancel' })
        }
        state.projectStatus = cancelled.status
      }
    } catch {
      // Cleanup is best effort and must not replace the primary failure.
    }
  }
}

export async function runIdentityAcceptance(rawOptions) {
  const baseUrl = normalizeHttpsBaseUrl(rawOptions.baseUrl, 'base-url')
  if (baseUrl !== EXPECTED_CLOUD_BASE_URL) {
    fail('configuration_rejected', { field: 'base-url' })
  }
  const commit = typeof rawOptions.commit === 'string' && COMMIT_PATTERN.test(rawOptions.commit)
    ? rawOptions.commit
    : fail('configuration_rejected', { field: 'commit' })
  const runId = rawOptions.runId ?? randomBytes(12).toString('hex')
  if (!RUN_ID_PATTERN.test(runId)) fail('configuration_rejected', { field: 'run-id' })
  let fetchImplementation
  if (rawOptions.fetch === undefined) {
    assertSafeGlobalFetchEnvironment(process.env)
    fetchImplementation = globalThis.fetch
  } else if (typeof rawOptions.fetch === 'function') {
    fetchImplementation = rawOptions.fetch
  } else {
    fail('configuration_rejected', { field: 'fetch' })
  }
  const expectedHarnessSha256 = typeof rawOptions.expectedHarnessSha256 === 'string' &&
    SHA256_PATTERN.test(rawOptions.expectedHarnessSha256)
    ? rawOptions.expectedHarnessSha256
    : fail('configuration_rejected', { field: 'expected-harness-sha256' })
  const harnessSha256 = await currentHarnessSha256()
  if (harnessSha256 !== expectedHarnessSha256) fail('harness_integrity_rejected')
  const options = {
    baseUrl,
    commit,
    fetch: fetchImplementation,
    deadlineAt: performance.now() + ACCEPTANCE_DEADLINE_MS,
    requestTimeoutMs: rawOptions.requestTimeoutMs,
    zulipRealmUrl: rawOptions.zulipRealmUrl
      ? normalizeHttpsBaseUrl(rawOptions.zulipRealmUrl, 'zulip-realm-url', { originOnly: true })
      : undefined
  }
  if (typeof options.fetch !== 'function') fail('configuration_rejected', { field: 'fetch' })
  const now = rawOptions.now ?? (() => new Date())
  const state = {
    commit,
    harnessSha256,
    runId,
    deviceStatus: 'not_created',
    agentCredentialStatus: 'not_issued',
    projectStatus: 'not_created',
    taskStatus: 'not_created',
    resultStatus: 'not_created'
  }
  let initialBearer
  let cleanupBearer
  let initialBearerValidated = false
  let cleanupBearerValidated = false
  try {
    initialBearer = await readSecureOidcTokenFile(rawOptions.tokenFile)
    const preflightNow = Math.floor(currentDate(now).getTime() / 1_000)
    const initialClaims = inspectOidcToken(initialBearer, preflightNow)
    cleanupBearer = await readSecureOidcTokenFile(rawOptions.revokeTokenFile)
    const cleanupClaims = inspectOidcToken(cleanupBearer, preflightNow, {
      maximumAuthenticationAgeSeconds: REVOKE_PREFLIGHT_MAX_AGE_SECONDS
    })
    assertSameOidcPrincipal(initialClaims, cleanupClaims)

    const me = meIdentity(await requestJson(options, {
      step: 'me', path: '/v1/me', bearer: initialBearer
    }), 'me')
    initialBearerValidated = true
    state.userId = me.userId
    state.oidcIdentityId = me.oidcIdentityId

    const cleanupMe = meIdentity(await requestJson(options, {
      step: 'revoke-me-preflight', path: '/v1/me', bearer: cleanupBearer
    }), 'revoke-me-preflight')
    if (cleanupMe.userId !== me.userId || cleanupMe.oidcIdentityId !== me.oidcIdentityId ||
        cleanupMe.issuer !== me.issuer) {
      fail('oidc_principal_mismatch')
    }
    cleanupBearerValidated = true

    const zulip = await runOptionalZulipFailClosed(options, initialBearer, state.userId, runId, now)
    if (zulip) {
      state.bindingRequestId = zulip.bindingRequestId
      state.zulipConfirmStatus = zulip.confirmStatus
    }

    const installationId = `ins_a_identity_${runId}`
    const enrollmentKey = `idem_aid_enrollment_${runId}`
    const enrollment = requiredRecord(await requestJson(options, {
      step: 'device-enrollment',
      path: '/v1/device-enrollments',
      method: 'POST',
      bearer: initialBearer,
      body: { installationId, idempotencyKey: enrollmentKey }
    }), 'device-enrollment')
    const enrollmentId = requiredId(enrollment.enrollmentId, 'enr', 'device-enrollment')
    if (typeof enrollment.nonce !== 'string' || enrollment.nonce.length > 512 ||
        !/^[A-Za-z0-9_-]+$/u.test(enrollment.nonce) ||
        Buffer.from(enrollment.nonce, 'base64url').toString('base64url') !== enrollment.nonce ||
        Buffer.from(enrollment.nonce, 'base64url').length < 32) {
      fail('response_contract_rejected', { step: 'device-enrollment' })
    }
    requiredTimestamp(enrollment.expiresAt, 'device-enrollment')
    const enrollmentLifetime = Date.parse(enrollment.expiresAt) - currentDate(now).getTime()
    if (enrollmentLifetime <= 0 || enrollmentLifetime > 6 * 60_000) {
      fail('response_contract_rejected', { step: 'device-enrollment' })
    }

    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const exported = publicKey.export({ format: 'jwk' })
    if (exported.kty !== 'OKP' || exported.crv !== 'Ed25519' || typeof exported.x !== 'string') {
      fail('device_key_generation_failed')
    }
    const signature = signBytes(null, canonicalEnrollmentBytes({
      enrollmentId,
      nonce: enrollment.nonce,
      userId: state.userId,
      installationId,
      expiresAt: enrollment.expiresAt
    }), privateKey).toString('base64url')
    const platform = platformFacts(rawOptions.platform, rawOptions.architecture)
    const deviceKey = `idem_aid_device_${runId}`
    const createdDevice = deviceFromResponse(await requestJson(options, {
      step: 'device-create',
      path: '/v1/devices',
      method: 'POST',
      bearer: initialBearer,
      body: {
        enrollmentId,
        nonce: enrollment.nonce,
        installationId,
        displayName: 'A identity acceptance device',
        platform: { ...platform, appVersion: `acceptance-${commit.slice(0, 12)}` },
        publicKeyJwk: {
          kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig',
          kid: `a-identity-${runId}`, x: exported.x
        },
        capabilitySummary: [],
        signature,
        idempotencyKey: deviceKey
      }
    }), 'active', 'device-create')
    state.deviceId = createdDevice.deviceId
    state.deviceStatus = createdDevice.status

    listedDevice(await requestJson(options, {
      step: 'device-list-active', path: '/v1/me/devices', bearer: initialBearer
    }), state.deviceId, 'active', 'device-list-active')

    const registered = requiredRecord(await requestJson(options, {
      step: 'agent-register',
      path: '/v1/commands',
      method: 'POST',
      bearer: initialBearer,
      body: command(runId, 10, 'agent.register', {
        deviceId: state.deviceId,
        displayName: 'A identity acceptance agent',
        nodeType: 'desktop',
        capabilities: []
      })
    }), 'agent-register')
    if (registered.protocolVersion !== '1.0' || registered.type !== 'agent.registered' ||
        typeof registered.deviceCredential !== 'string' || registered.deviceCredential.length < 32 ||
        registered.deviceCredential.length > 2_048 || /[\r\n]/u.test(registered.deviceCredential)) {
      fail('response_contract_rejected', { step: 'agent-register' })
    }
    const agent = requiredRecord(registered.agent, 'agent-register')
    state.agentId = requiredId(agent.agentId, 'agt', 'agent-register')
    if (agent.type !== 'agent_node' || agent.deviceId !== state.deviceId || agent.ownerUserId !== state.userId ||
        agent.lifecycleStatus !== 'active') {
      fail('response_contract_rejected', { step: 'agent-register' })
    }
    let agentRevision = requiredRevision(agent.revision, 'agent-register')
    const agentBearer = registered.deviceCredential
    state.agentCredentialStatus = 'active'

    const heartbeat = exactEntity(await requestJson(options, {
      step: 'agent-heartbeat',
      path: '/v1/commands',
      method: 'POST',
      bearer: agentBearer,
      body: command(runId, 11, 'agent.heartbeat', {
        agentId: state.agentId,
        expectedRevision: agentRevision,
        connectionStatus: 'online',
        capabilities: []
      })
    }), 'agent_node', 'agent-heartbeat')
    if (heartbeat.agentId !== state.agentId || heartbeat.connectionStatus !== 'online') {
      fail('response_contract_rejected', { step: 'agent-heartbeat' })
    }
    agentRevision = requiredRevision(heartbeat.revision, 'agent-heartbeat')

    const reportedAt = currentDate(now).toISOString()
    const expiresAt = new Date(new Date(reportedAt).getTime() + 10 * 60_000).toISOString()
    const profile = exactEntity(await requestJson(options, {
      step: 'capability-profile',
      path: '/v1/commands',
      method: 'POST',
      bearer: agentBearer,
      body: command(runId, 12, 'agent.capability_profile.report', {
        expectedProfileRevision: 0,
        profile: {
          agentId: state.agentId,
          ownerUserId: state.userId,
          nodeType: 'personal_computer',
          os: { family: platform.os, architecture: platform.arch },
          runtimeIds: ['sciforge-acceptance'],
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
    }), 'agent_capability_profile', 'capability-profile')
    if (profile.agentId !== state.agentId || profile.ownerUserId !== state.userId) {
      fail('response_contract_rejected', { step: 'capability-profile' })
    }

    const project = exactEntity(await requestJson(options, {
      step: 'project-create',
      path: '/v1/commands',
      method: 'POST',
      bearer: initialBearer,
      body: command(runId, 20, 'project.create', {
        ownerUserId: state.userId,
        displayName: `A identity acceptance ${runId}`,
        goal: 'Verify the public identity and basic Task contract.',
        memberUserIds: [state.userId],
        coordinatorAgentId: state.agentId,
        budget: { maxTasks: 1, maxTasksPerRound: 1, maxCoordinationRounds: 1, maxTaskRetries: 0 }
      })
    }), 'project', 'project-create')
    state.projectId = requiredId(project.projectId, 'prj', 'project-create')
    state.projectStatus = project.status
    if (project.ownerUserId !== state.userId || project.coordinatorAgentId !== state.agentId ||
        project.status !== 'active') {
      fail('response_contract_rejected', { step: 'project-create' })
    }
    const projectRevision = requiredRevision(project.revision, 'project-create')

    const task = exactEntity(await requestJson(options, {
      step: 'task-create',
      path: '/v1/commands',
      method: 'POST',
      bearer: initialBearer,
      body: command(runId, 21, 'task.create', {
        projectId: state.projectId,
        expectedRevision: projectRevision,
        assigneeAgentId: state.agentId,
        title: 'A identity acceptance Task',
        objective: 'Persist one metadata-only Task through the public API.',
        completionCriteria: ['The Task is readable through the public API.'],
        dependencyTaskIds: [],
        requiredCapabilities: { capabilityIds: [], vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: [] },
        resourceRefIds: [],
        authorizationRequirements: []
      })
    }), 'task', 'task-create')
    state.taskId = requiredId(task.taskId, 'tsk', 'task-create')
    state.executionId = requiredId(task.executionId, 'exe', 'task-create')
    state.taskStatus = task.status
    state.taskRevision = requiredRevision(task.revision, 'task-create')
    if (task.status !== 'offered' || task.assigneeAgentId !== state.agentId) {
      fail('response_contract_rejected', { step: 'task-create' })
    }

    const agentInbox = requiredRecord(await requestJson(options, {
      step: 'task-offer-inbox',
      path: '/v1/commands',
      method: 'POST',
      bearer: agentBearer,
      body: command(runId, 13, 'inbox.pull', {
        recipientType: 'agent',
        afterSequence: 0,
        limit: 100
      })
    }), 'task-offer-inbox')
    if (agentInbox.protocolVersion !== '1.0' || agentInbox.type !== 'rest.inbox_page' ||
        !Array.isArray(agentInbox.messages) || !Number.isSafeInteger(agentInbox.ackedSequence) ||
        agentInbox.ackedSequence < 0 || !Number.isSafeInteger(agentInbox.nextSequence) ||
        agentInbox.nextSequence <= agentInbox.ackedSequence) {
      fail('response_contract_rejected', { step: 'task-offer-inbox' })
    }
    const taskOffers = agentInbox.messages.filter((message) => isRecord(message) &&
      message.type === 'inbox_message' && message.recipientType === 'agent' &&
      message.recipientAgentId === state.agentId && message.status === 'pending' && message.disposition === 'active' &&
      isRecord(message.payload) && message.payload.type === 'task.offered' &&
      message.payload.projectId === state.projectId && message.payload.taskId === state.taskId &&
      message.payload.executionId === state.executionId && message.payload.revision === state.taskRevision)
    if (taskOffers.length !== 1) fail('response_contract_rejected', { step: 'task-offer-inbox' })

    const taskOffer = taskOffers[0]
    const taskOfferMessageId = requiredId(taskOffer.inboxMessageId, 'ibx', 'task-offer-inbox')
    const taskOfferSequence = taskOffer.sequence
    if (!Number.isSafeInteger(taskOfferSequence) || taskOfferSequence <= agentInbox.ackedSequence) {
      fail('response_contract_rejected', { step: 'task-offer-inbox' })
    }
    const projectStarts = agentInbox.messages.filter((message) => isRecord(message) &&
      message.type === 'inbox_message' && message.recipientType === 'agent' &&
      message.recipientAgentId === state.agentId && message.status === 'pending' && message.disposition === 'active' &&
      isRecord(message.payload) && message.payload.type === 'project.started' &&
      message.payload.projectId === state.projectId && message.payload.revision === projectRevision)
    if (projectStarts.length !== 1) fail('response_contract_rejected', { step: 'task-offer-inbox' })
    const projectStart = projectStarts[0]
    requiredId(projectStart.inboxMessageId, 'ibx', 'task-offer-inbox')
    if (!Number.isSafeInteger(projectStart.sequence) || projectStart.sequence <= agentInbox.ackedSequence ||
        projectStart.sequence >= taskOfferSequence) {
      fail('response_contract_rejected', { step: 'task-offer-inbox' })
    }
    const activeMessagesThroughOffer = agentInbox.messages.filter((message) => isRecord(message) &&
      Number.isSafeInteger(message.sequence) && message.sequence > agentInbox.ackedSequence &&
      message.sequence <= taskOfferSequence && message.disposition === 'active')
      .sort((left, right) => left.sequence - right.sequence)
    if (activeMessagesThroughOffer.length !== 2 || activeMessagesThroughOffer[0] !== projectStart ||
        activeMessagesThroughOffer[1] !== taskOffer) {
      fail('response_contract_rejected', { step: 'task-offer-inbox' })
    }
    let acknowledgedSequence = agentInbox.ackedSequence
    for (const [index, message] of activeMessagesThroughOffer.entries()) {
      const inboxMessageId = requiredId(message.inboxMessageId, 'ibx', 'task-offer-inbox')
      if (message.sequence <= acknowledgedSequence || message.type !== 'inbox_message' ||
          message.recipientType !== 'agent' || message.recipientAgentId !== state.agentId ||
          message.status !== 'pending' || message.disposition !== 'active') {
        fail('response_contract_rejected', { step: 'task-offer-inbox' })
      }
      const acknowledgement = requiredRecord(await requestJson(options, {
        step: 'task-offer-inbox-ack',
        path: '/v1/commands',
        method: 'POST',
        bearer: agentBearer,
        body: command(runId, 14 + index, 'inbox.ack', {
          inboxMessageId,
          sequence: message.sequence
        })
      }), 'task-offer-inbox-ack')
      if (acknowledgement.protocolVersion !== '1.0' || acknowledgement.type !== 'inbox.acked' ||
          acknowledgement.ackedSequence !== message.sequence ||
          !Number.isSafeInteger(acknowledgement.nextSequence) ||
          acknowledgement.nextSequence <= acknowledgement.ackedSequence) {
        fail('response_contract_rejected', { step: 'task-offer-inbox-ack' })
      }
      acknowledgedSequence = acknowledgement.ackedSequence
    }
    if (acknowledgedSequence !== taskOfferSequence ||
        activeMessagesThroughOffer.at(-1)?.inboxMessageId !== taskOfferMessageId) {
      fail('response_contract_rejected', { step: 'task-offer-inbox-ack' })
    }

    exactTask(await requestJson(options, {
      step: 'task-get',
      path: '/v1/commands',
      method: 'POST',
      bearer: initialBearer,
      body: command(runId, 22, 'task.get', { taskId: state.taskId })
    }), state.taskId, state.executionId, 'offered', 'task-get')

    const acceptedTask = exactTask(await requestJson(options, {
      step: 'task-accept',
      path: '/v1/commands',
      method: 'POST',
      bearer: agentBearer,
      body: command(runId, 23, 'task.transition', {
        taskId: state.taskId,
        executionId: state.executionId,
        expectedRevision: state.taskRevision,
        status: 'accepted'
      })
    }), state.taskId, state.executionId, 'accepted', 'task-accept')
    state.taskStatus = acceptedTask.status
    state.taskRevision = requiredRevision(acceptedTask.revision, 'task-accept')

    const runningTask = exactTask(await requestJson(options, {
      step: 'task-run',
      path: '/v1/commands',
      method: 'POST',
      bearer: agentBearer,
      body: command(runId, 24, 'task.transition', {
        taskId: state.taskId,
        executionId: state.executionId,
        expectedRevision: state.taskRevision,
        status: 'running'
      })
    }), state.taskId, state.executionId, 'running', 'task-run')
    state.taskStatus = runningTask.status
    state.taskRevision = requiredRevision(runningTask.revision, 'task-run')

    const succeededTask = exactTask(await requestJson(options, {
      step: 'task-succeed',
      path: '/v1/commands',
      method: 'POST',
      bearer: agentBearer,
      body: command(runId, 25, 'task.transition', {
        taskId: state.taskId,
        executionId: state.executionId,
        expectedRevision: state.taskRevision,
        status: 'succeeded',
        result: {
          summary: 'A identity acceptance Task completed.',
          criterionEvidence: [],
          resourceRefIds: []
        }
      })
    }), state.taskId, state.executionId, 'succeeded', 'task-succeed')
    state.taskStatus = succeededTask.status
    state.taskRevision = requiredRevision(succeededTask.revision, 'task-succeed')
    state.resultRecordId = requiredId(succeededTask.resultProjectRecordId, 'rec', 'task-succeed')
    state.resultStatus = 'proposed'

    const freshCleanupClaims = inspectOidcToken(cleanupBearer, Math.floor(currentDate(now).getTime() / 1_000), {
      maximumAuthenticationAgeSeconds: REVOKE_AUTH_MAX_AGE_SECONDS,
      minimumRemainingSeconds: RUNTIME_MIN_TOKEN_REMAINING_SECONDS
    })
    assertSameOidcPrincipal(initialClaims, freshCleanupClaims)

    const resultRecord = exactEntity(await requestJson(options, {
      step: 'result-get',
      path: '/v1/commands',
      method: 'POST',
      bearer: cleanupBearer,
      body: command(runId, 26, 'project_record.get', { projectRecordId: state.resultRecordId })
    }), 'project_record', 'result-get')
    if (resultRecord.projectRecordId !== state.resultRecordId || resultRecord.kind !== 'task_result' ||
        resultRecord.status !== 'proposed' || resultRecord.sourceTaskId !== state.taskId ||
        resultRecord.sourceExecutionId !== state.executionId) {
      fail('response_contract_rejected', { step: 'result-get' })
    }
    const acceptedResult = exactEntity(await requestJson(options, {
      step: 'result-accept',
      path: '/v1/commands',
      method: 'POST',
      bearer: cleanupBearer,
      body: command(runId, 27, 'project_record.accept', {
        projectRecordId: state.resultRecordId,
        expectedRevision: requiredRevision(resultRecord.revision, 'result-get'),
        decision: 'accepted'
      })
    }), 'project_record', 'result-accept')
    if (acceptedResult.projectRecordId !== state.resultRecordId || acceptedResult.projectId !== state.projectId ||
        acceptedResult.kind !== 'task_result' || acceptedResult.status !== 'accepted') {
      fail('response_contract_rejected', { step: 'result-accept' })
    }
    state.resultStatus = acceptedResult.status

    const currentProject = exactEntity(await requestJson(options, {
      step: 'project-get',
      path: '/v1/commands',
      method: 'POST',
      bearer: cleanupBearer,
      body: command(runId, 28, 'project.get', { projectId: state.projectId })
    }), 'project', 'project-get')
    const completedProject = exactEntity(await requestJson(options, {
      step: 'project-complete',
      path: '/v1/commands',
      method: 'POST',
      bearer: cleanupBearer,
      body: command(runId, 29, 'project.transition', {
        projectId: state.projectId,
        expectedRevision: requiredRevision(currentProject.revision, 'project-get'),
        status: 'completed'
      })
    }), 'project', 'project-complete')
    if (completedProject.projectId !== state.projectId || completedProject.status !== 'completed') {
      fail('response_contract_rejected', { step: 'project-complete' })
    }
    state.projectStatus = completedProject.status

    const revokeClaims = inspectOidcToken(cleanupBearer, Math.floor(currentDate(now).getTime() / 1_000), {
      maximumAuthenticationAgeSeconds: REVOKE_AUTH_MAX_AGE_SECONDS,
      minimumRemainingSeconds: RUNTIME_MIN_TOKEN_REMAINING_SECONDS
    })
    assertSameOidcPrincipal(initialClaims, revokeClaims)
    const revokeKey = `idem_aid_device_revoke_${runId}`
    const revokedDevice = deviceFromResponse(await requestJson(options, {
      step: 'device-revoke',
      path: `/v1/me/devices/${state.deviceId}`,
      method: 'DELETE',
      bearer: cleanupBearer,
      body: { deviceId: state.deviceId, idempotencyKey: revokeKey }
    }), 'revoked', 'device-revoke')
    state.deviceStatus = revokedDevice.status

    listedDevice(await requestJson(options, {
      step: 'device-list-revoked', path: '/v1/me/devices', bearer: cleanupBearer
    }), state.deviceId, 'revoked', 'device-list-revoked')

    const rejectedAgent = await requestJson(options, {
      step: 'old-agent-rejected',
      path: '/v1/commands',
      method: 'POST',
      expectedStatus: 401,
      bearer: agentBearer,
      body: command(runId, 30, 'agent.heartbeat', {
        agentId: state.agentId,
        expectedRevision: agentRevision,
        connectionStatus: 'offline',
        capabilities: []
      })
    })
    if (rejectedAgent.protocolVersion !== '1.0' || rejectedAgent.type !== 'rest.error' ||
        rejectedAgent.error?.code !== 'credential_revoked' || rejectedAgent.error?.retryable !== false) {
      fail('old_agent_not_rejected')
    }
    state.agentCredentialStatus = 'credential_revoked'
    return Object.freeze(safeRunState(state))
  } catch (error) {
    let freshRevokeBearer
    if (cleanupBearerValidated && cleanupBearer) {
      try {
        inspectOidcToken(cleanupBearer, Math.floor(currentDate(now).getTime() / 1_000), {
          maximumAuthenticationAgeSeconds: REVOKE_AUTH_MAX_AGE_SECONDS,
          minimumRemainingSeconds: RUNTIME_MIN_TOKEN_REMAINING_SECONDS
        })
        freshRevokeBearer = cleanupBearer
      } catch {
        // An expired cleanup credential is intentionally ignored here.
      }
    }
    if (initialBearerValidated && initialBearer) {
      await bestEffortCleanup({
        ...options,
        deadlineAt: performance.now() + CLEANUP_DEADLINE_MS
      }, state, initialBearer, freshRevokeBearer)
    }
    const code = error instanceof AcceptanceFailure ? error.code : 'internal_harness_error'
    const wrapped = new AcceptanceFailure(code, safeRunState(state, code))
    throw wrapped
  }
}

export function parseIdentityAcceptanceConfiguration(argv, environment = process.env) {
  const values = new Map()
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (!['--base-url', '--token-file', '--revoke-token-file', '--commit', '--expected-harness-sha256',
      '--zulip-realm-url'].includes(argument) ||
        values.has(argument) || index + 1 >= argv.length) {
      fail('configuration_rejected')
    }
    values.set(argument, argv[index + 1])
    index += 1
  }
  if (help) return Object.freeze({ help: true })
  const baseUrl = values.get('--base-url') ?? environment.SCIFORGE_CLOUD_BASE_URL
  const tokenFile = values.get('--token-file') ?? environment.SCIFORGE_OIDC_ACCESS_TOKEN_FILE
  const revokeTokenFile = values.get('--revoke-token-file') ?? environment.SCIFORGE_OIDC_REVOKE_TOKEN_FILE
  const commit = values.get('--commit') ?? environment.SCIFORGE_COLLAB_CONTRACT_COMMIT
  const expectedHarnessSha256 = values.get('--expected-harness-sha256') ??
    environment.SCIFORGE_IDENTITY_ACCEPTANCE_HARNESS_SHA256
  const zulipRealmUrl = values.get('--zulip-realm-url') ?? environment.SCIFORGE_ZULIP_REALM_URL
  if (!baseUrl || !tokenFile || !revokeTokenFile || !commit || !expectedHarnessSha256) {
    fail('configuration_rejected')
  }
  return Object.freeze({ baseUrl, tokenFile, revokeTokenFile, commit, expectedHarnessSha256,
    ...(zulipRealmUrl ? { zulipRealmUrl } : {}) })
}

export function identityAcceptanceUsage() {
  return [
    'Usage: node scripts/collaboration-a-identity-acceptance.mjs [options]',
    '',
    'Required (flags or environment):',
    '  --base-url URL           SCIFORGE_CLOUD_BASE_URL (exact HTTPS API base URL)',
    '  --token-file PATH        SCIFORGE_OIDC_ACCESS_TOKEN_FILE (owned 0600 regular file)',
    '  --revoke-token-file PATH SCIFORGE_OIDC_REVOKE_TOKEN_FILE (fresh owned 0600 file)',
    '  --commit SHA             SCIFORGE_COLLAB_CONTRACT_COMMIT (40 lowercase hex)',
    '  --expected-harness-sha256 SHA256',
    '                            SCIFORGE_IDENTITY_ACCEPTANCE_HARNESS_SHA256',
    '',
    'Optional:',
    '  --zulip-realm-url URL    SCIFORGE_ZULIP_REALM_URL (A fail-closed confirm probe only)',
    '',
    'The process prints one redacted receipt. It never accepts an inline token.'
  ].join('\n')
}

async function main() {
  try {
    const configuration = parseIdentityAcceptanceConfiguration(process.argv.slice(2))
    if (configuration.help) {
      process.stdout.write(`${identityAcceptanceUsage()}\n`)
      return
    }
    const receipt = await runIdentityAcceptance(configuration)
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } catch (error) {
    const failure = error instanceof AcceptanceFailure
      ? (isRecord(error.safeFacts) && error.safeFacts.type
          ? error.safeFacts
          : { type: 'sciforge.a.identity_acceptance.receipt', status: 'failed', code: error.code })
      : { type: 'sciforge.a.identity_acceptance.receipt', status: 'failed', code: 'internal_harness_error' }
    process.stderr.write(`${JSON.stringify(failure)}\n`)
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) await main()
