import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  canonicalEnrollmentBytes,
  collaborationErrorSchema,
  deviceCreateRequestSchema,
  deviceEnrollmentCreateRequestSchema,
  deviceEnrollmentCreateResponseSchema,
  deviceListResponseSchema,
  deviceResponseSchema,
  deviceRevokeRequestSchema,
  externalIdentityListResponseSchema,
  externalIdentityResponseSchema,
  externalIdentityRevokeRequestSchema,
  inboxMessageSchema,
  meResponseSchema,
  restEntitySchema,
  restRequestSchema,
  restResponseSchema,
  zulipBindingBeginRequestSchema,
  zulipBindingBeginResponseSchema,
  zulipBindingConfirmRequestSchema,
  zulipBindingConfirmResponseSchema
} from '../packages/collaboration-contracts/src/index.ts'
import {
  ARTIFACT_DIRECTORY,
  COMMIT_PLACEHOLDER,
  generateContractArtifactFiles
} from './collaboration-contract-artifacts.mjs'

const documentSchemas = {
  command: restRequestSchema,
  response: restResponseSchema,
  inbox: inboxMessageSchema,
  entity: restEntitySchema,
  error: collaborationErrorSchema
}

test('machine-readable collaboration artifacts are deterministic and current', async () => {
  const first = generateContractArtifactFiles()
  const second = generateContractArtifactFiles()
  assert.deepEqual([...first], [...second])
  for (const [relativePath, expected] of first) {
    assert.equal(await readFile(join(ARTIFACT_DIRECTORY, relativePath), 'utf8'), expected, relativePath)
    assert.doesNotThrow(() => JSON.parse(expected), relativePath)
  }
})

test('manifest hashes every schema, state table, and fixture without claiming business E2E', () => {
  const files = generateContractArtifactFiles()
  const manifest = JSON.parse(files.get('ARTIFACT_MANIFEST.json'))
  assert.equal(manifest.protocolVersion, '1.0')
  assert.equal(manifest.contractCommit, COMMIT_PLACEHOLDER)
  assert.equal(manifest.acceptance.coreOnly.status, 'available')
  assert.equal(manifest.acceptance.businessEndToEnd.status, 'not-open')
  assert.equal(manifest.acceptance.identityProvider.status, 'not-selected')
  assert.equal(manifest.acceptance.formalProductTransport.status, 'not-selected')
  assert.ok(manifest.acceptance.coreOnly.proves.includes('device-enrollment-signing-vector'))
  assert.ok(manifest.files.some((entry) => entry.path === 'fixtures/device-enrollment-signing-v1.json'))
  assert.equal(manifest.files.length, files.size - 1)
  for (const entry of manifest.files) {
    const content = files.get(entry.path)
    assert.ok(content, entry.path)
    assert.equal(entry.sha256, createHash('sha256').update(content).digest('hex'), entry.path)
    assert.equal(entry.bytes, Buffer.byteLength(content), entry.path)
  }
})

test('Device enrollment golden vector freezes canonical bytes and verifies with public material only', () => {
  const files = generateContractArtifactFiles()
  const path = 'fixtures/device-enrollment-signing-v1.json'
  const fixture = JSON.parse(files.get(path))
  const expectedUtf8 = [
    'SCIFORGE-DEVICE-ENROLLMENT-V1',
    'enr_golden_vector_0001',
    'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    'usr_golden_vector_0001',
    'ins_golden_vector_0001',
    '2026-08-20T12:34:56.000Z'
  ].join('\n')

  assert.equal(fixture.kind, 'device-enrollment-signing-vector')
  assert.equal(fixture.algorithm, 'Ed25519')
  assert.deepEqual(fixture.canonicalization, {
    domain: 'SCIFORGE-DEVICE-ENROLLMENT-V1',
    encoding: 'UTF-8',
    fieldOrder: ['enrollmentId', 'nonce', 'userId', 'installationId', 'expiresAt'],
    separator: 'LF',
    trailingLf: false
  })
  assert.equal(fixture.canonical.utf8, expectedUtf8)
  assert.equal(fixture.canonical.utf8.split('\n').length, 6)
  assert.equal(fixture.canonical.utf8.endsWith('\n'), false)

  const canonical = Buffer.from(canonicalEnrollmentBytes(fixture.input))
  assert.equal(canonical.toString('utf8'), expectedUtf8)
  assert.equal(canonical.toString('base64url'), fixture.canonical.base64url)
  assert.equal(canonical.toString('hex'), fixture.canonical.hex)
  assert.equal(canonical.length, fixture.canonical.byteLength)
  assert.deepEqual(Buffer.from(fixture.canonical.base64url, 'base64url'), canonical)
  assert.deepEqual(Buffer.from(fixture.canonical.hex, 'hex'), canonical)

  const publicKeyJwk = fixture.expected.publicKeyJwk
  assert.deepEqual(Object.keys(publicKeyJwk).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x'])
  assert.equal('d' in publicKeyJwk, false)
  const signature = Buffer.from(fixture.expected.signatureBase64url, 'base64url')
  assert.equal(signature.length, 64)
  assert.equal(signature.toString('base64url'), fixture.expected.signatureBase64url)
  assert.equal(verify(null, canonical, createPublicKey({ key: publicKeyJwk, format: 'jwk' }), signature), true)
  assert.equal(/"(?:d|privateKey|privateKeyJwk|seed|secret)"\s*:/iu.test(JSON.stringify(fixture)), false)
})

test('JSON Schemas expose the complete strict public roots and actor table', () => {
  const files = generateContractArtifactFiles()
  for (const path of [
    'schemas/commands.schema.json',
    'schemas/responses.schema.json',
    'schemas/inbox.schema.json',
    'schemas/entities.schema.json',
    'schemas/errors.schema.json',
    'schemas/identity-me-response.schema.json',
    'schemas/identity-device-enrollment-create-request.schema.json',
    'schemas/identity-device-enrollment-create-response.schema.json',
    'schemas/identity-device-create-request.schema.json',
    'schemas/identity-device-response.schema.json',
    'schemas/identity-device-list-response.schema.json',
    'schemas/identity-device-revoke-request.schema.json',
    'schemas/identity-zulip-binding-begin-request.schema.json',
    'schemas/identity-zulip-binding-begin-response.schema.json',
    'schemas/identity-zulip-binding-confirm-request.schema.json',
    'schemas/identity-zulip-binding-confirm-response.schema.json',
    'schemas/identity-external-identity-list-response.schema.json',
    'schemas/identity-external-identity-revoke-request.schema.json',
    'schemas/identity-external-identity-response.schema.json'
  ]) {
    const schema = JSON.parse(files.get(path))
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.equal(schema['x-sciforge-contract'].protocolVersion, '1.0')
  }
  const commands = JSON.parse(files.get('schemas/commands.schema.json')).oneOf
    .map((entry) => entry.properties.type.const).sort()
  const actorTable = JSON.parse(files.get('state-and-actors.json'))
  const permissions = actorTable.permissions
    .map((entry) => entry.command).sort()
  assert.deepEqual(permissions, commands)
  assert.ok(commands.includes('task.create'))
  assert.ok(commands.includes('inbox.ack'))

  const permissionByCommand = new Map(actorTable.permissions.map((entry) => [entry.command, entry]))
  assert.equal(permissionByCommand.has('pairing.verify'), false)
  assert.deepEqual(permissionByCommand.get('pairing.begin').actors, ['user'])
  assert.deepEqual(permissionByCommand.get('pairing.redeem').actors, ['user'])
  assert.deepEqual(permissionByCommand.get('endpoint.catalog.get').actors, ['anonymous'])
  assert.deepEqual(permissionByCommand.get('credential.revoke_current').actors, ['agent'])
  assert.equal(permissionByCommand.get('credential.revoke_current').availability, 'current')
  assert.deepEqual(permissionByCommand.get('endpoint.challenge.create').actors, [])
  assert.equal(permissionByCommand.get('endpoint.challenge.create').availability, 'reserved')
  assert.deepEqual(permissionByCommand.get('endpoint.bind').actors, [])
  assert.equal(permissionByCommand.get('endpoint.bind').availability, 'reserved')
  assert.deepEqual(permissionByCommand.get('user.create').actors, [])
  assert.equal(permissionByCommand.get('user.create').availability, 'reserved')
  assert.deepEqual(permissionByCommand.get('task.create').authorizationModes, [
    { actor: 'user', authority: 'project_owner', confirmation: 'owner_direct', decisionAuthority: 'project_owner', scope: 'initial_assignment' },
    { actor: 'agent', authority: 'current_coordinator', confirmableActionKind: 'tasks.create', confirmation: 'required', decisionAuthority: 'project_owner', scope: 'initial_assignment' }
  ])
  assert.deepEqual(permissionByCommand.get('task.retry').authorizationModes, [
    { actor: 'user', authority: 'project_owner', confirmation: 'owner_direct', decisionAuthority: 'project_owner', scope: 'same_assignee_retry_or_reassign' },
    { actor: 'agent', authority: 'current_coordinator', confirmation: 'not_required', decisionAuthority: 'current_coordinator', scope: 'same_assignee_terminal_retry' },
    { actor: 'agent', authority: 'current_coordinator', confirmableActionKind: 'task.retry_reassign', confirmation: 'required', decisionAuthority: 'project_owner', scope: 'different_assignee_reassign' }
  ])
  assert.deepEqual(permissionByCommand.get('task.transition').authorizationModes, [
    { actor: 'agent', authority: 'current_assignee', confirmation: 'not_applicable', decisionAuthority: 'current_assignee', scope: 'execution_transition' },
    { actor: 'user', authority: 'project_owner', confirmation: 'owner_direct', decisionAuthority: 'project_owner', scope: 'cancel_only' },
    { actor: 'agent', authority: 'current_coordinator', confirmableActionKind: 'task.cancel', confirmation: 'required', decisionAuthority: 'project_owner', scope: 'cancel_only' }
  ])
  assert.deepEqual(permissionByCommand.get('project.transition').authorizationModes, [
    { actor: 'user', authority: 'project_owner', confirmation: 'owner_direct', decisionAuthority: 'project_owner', scope: 'permitted_project_transition' },
    { actor: 'agent', authority: 'current_coordinator', confirmableActionKind: 'project.complete', confirmation: 'required', decisionAuthority: 'project_owner', scope: 'completed_only' }
  ])

  assert.deepEqual(actorTable.stateTransitions.task.succeeded, ['offered'])
  assert.deepEqual(actorTable.stateTransitions.task.failed, ['offered'])
  assert.deepEqual(actorTable.stateTransitions.task.rejected, ['offered'])
  assert.ok(actorTable.stateTransitions.task.running.includes('offered'))
  assert.deepEqual(actorTable.stateTransitions.resource_ref.unavailable, ['available', 'revoked'])
  assert.deepEqual(actorTable.stateTransitions.resource_ref.revoked, ['available', 'unavailable'])
  assert.deepEqual(actorTable.stateTransitions.resource_ref.invalidated, [])
})

test('identity REST machine schemas cover every current public identity body', () => {
  const files = generateContractArtifactFiles()
  const cases = [
    {
      path: 'schemas/identity-me-response.schema.json',
      source: meResponseSchema,
      required: ['schemaVersion', 'type', 'userId', 'displayName', 'status', 'oidcIdentityId', 'issuer', 'revision', 'createdAt', 'updatedAt'],
      bindings: [{ method: 'GET', path: '/v1/me', body: 'response' }]
    },
    {
      path: 'schemas/identity-device-enrollment-create-request.schema.json',
      source: deviceEnrollmentCreateRequestSchema,
      required: ['installationId', 'idempotencyKey'],
      bindings: [{ method: 'POST', path: '/v1/device-enrollments', body: 'request' }]
    },
    {
      path: 'schemas/identity-device-enrollment-create-response.schema.json',
      source: deviceEnrollmentCreateResponseSchema,
      required: ['enrollmentId', 'nonce', 'expiresAt'],
      bindings: [{ method: 'POST', path: '/v1/device-enrollments', body: 'response' }]
    },
    {
      path: 'schemas/identity-device-create-request.schema.json',
      source: deviceCreateRequestSchema,
      required: ['enrollmentId', 'nonce', 'installationId', 'displayName', 'platform', 'publicKeyJwk', 'capabilitySummary', 'signature', 'idempotencyKey'],
      bindings: [{ method: 'POST', path: '/v1/devices', body: 'request' }]
    },
    {
      path: 'schemas/identity-device-response.schema.json',
      source: deviceResponseSchema,
      required: ['device'],
      bindings: [
        { method: 'POST', path: '/v1/devices', body: 'response' },
        { method: 'DELETE', path: '/v1/me/devices/{deviceId}', body: 'response' }
      ]
    },
    {
      path: 'schemas/identity-device-list-response.schema.json',
      source: deviceListResponseSchema,
      required: ['devices'],
      bindings: [{ method: 'GET', path: '/v1/me/devices', body: 'response' }]
    },
    {
      path: 'schemas/identity-device-revoke-request.schema.json',
      source: deviceRevokeRequestSchema,
      required: ['deviceId', 'idempotencyKey'],
      bindings: [{ method: 'DELETE', path: '/v1/me/devices/{deviceId}', body: 'request' }]
    },
    {
      path: 'schemas/identity-zulip-binding-begin-request.schema.json',
      source: zulipBindingBeginRequestSchema,
      required: ['realmUrl', 'idempotencyKey'],
      bindings: [{ method: 'POST', path: '/v1/integrations/zulip/bindings', body: 'request' }]
    },
    {
      path: 'schemas/identity-zulip-binding-begin-response.schema.json',
      source: zulipBindingBeginResponseSchema,
      required: ['bindingRequestId', 'bindingCode', 'expiresAt'],
      bindings: [{ method: 'POST', path: '/v1/integrations/zulip/bindings', body: 'response' }]
    },
    {
      path: 'schemas/identity-zulip-binding-confirm-request.schema.json',
      source: zulipBindingConfirmRequestSchema,
      required: ['bindingCode', 'realmUrl', 'realmId', 'zulipUserId', 'providerEventId', 'idempotencyKey'],
      bindings: [{ method: 'POST', path: '/v1/integrations/zulip/bindings/confirm', body: 'request' }]
    },
    {
      path: 'schemas/identity-zulip-binding-confirm-response.schema.json',
      source: zulipBindingConfirmResponseSchema,
      required: ['identity'],
      bindings: [{ method: 'POST', path: '/v1/integrations/zulip/bindings/confirm', body: 'response' }]
    },
    {
      path: 'schemas/identity-external-identity-list-response.schema.json',
      source: externalIdentityListResponseSchema,
      required: ['identities'],
      bindings: [{ method: 'GET', path: '/v1/me/external-identities', body: 'response' }]
    },
    {
      path: 'schemas/identity-external-identity-revoke-request.schema.json',
      source: externalIdentityRevokeRequestSchema,
      required: ['externalIdentityId', 'idempotencyKey'],
      bindings: [{ method: 'DELETE', path: '/v1/me/external-identities/{externalIdentityId}', body: 'request' }]
    },
    {
      path: 'schemas/identity-external-identity-response.schema.json',
      source: externalIdentityResponseSchema,
      required: ['identity'],
      bindings: [{ method: 'DELETE', path: '/v1/me/external-identities/{externalIdentityId}', body: 'response' }]
    }
  ]

  assert.equal(cases.length, 14, 'every exported public identity REST body root has one schema')
  assert.equal(new Set(cases.map((entry) => entry.path)).size, cases.length,
    'identity REST schema paths must be unique')

  for (const entry of cases) {
    assert.ok(entry.source, `${entry.path} source Zod schema`)
    const schema = JSON.parse(files.get(entry.path))
    assert.equal(schema.additionalProperties, false, entry.path)
    assert.deepEqual(new Set(schema.required), new Set(entry.required), entry.path)
    assert.deepEqual(schema['x-sciforge-http'].bindings, entry.bindings, entry.path)
    assert.equal(schema['x-sciforge-contract'].contractCommit, COMMIT_PLACEHOLDER, entry.path)
  }
})

test('machine schemas distinguish command input defaults from normalized entity output', () => {
  const files = generateContractArtifactFiles()
  const commands = JSON.parse(files.get('schemas/commands.schema.json'))
  const responses = JSON.parse(files.get('schemas/responses.schema.json'))
  const entities = JSON.parse(files.get('schemas/entities.schema.json'))
  for (const [name, variants] of [
    ['command', strictObjectVariants(commands.oneOf)],
    ['response', strictObjectVariants(responses.oneOf)],
    ['entity', strictObjectVariants(entities.anyOf)]
  ]) {
    assert.ok(variants.length > 0, `${name} root variants`)
    for (const variant of variants) {
      assert.equal(variant.additionalProperties, false,
        `${name} ${variant.properties?.type?.const ?? '<unknown>'} must reject unknown properties`)
    }
  }

  const capabilityReport = commands.oneOf.find(
    (entry) => entry.properties?.type?.const === 'agent.capability_profile.report'
  )
  assert.ok(capabilityReport, 'agent.capability_profile.report command schema')
  assert.equal(capabilityReport.additionalProperties, false)
  assert.equal(capabilityReport.properties.profile.additionalProperties, false)
  assert.equal(capabilityReport.properties.profile.required.includes('gpu'), false,
    'the input command may omit gpu because Zod defaults it to []')
  assert.deepEqual(capabilityReport.properties.profile.properties.gpu.default, [])

  const commandWithoutGpu = {
    protocolVersion: '1.0',
    requestId: 'req_Capability01',
    type: 'agent.capability_profile.report',
    idempotencyKey: 'idem_contract_fixture_capability-without-gpu',
    expectedProfileRevision: 0,
    profile: {
      agentId: 'agt_Agent0000001',
      ownerUserId: 'usr_User00000001',
      nodeType: 'personal_computer',
      os: { family: 'macos', architecture: 'arm64' },
      runtimeIds: ['runtime.default'],
      capabilities: [],
      vpnAccessIds: [],
      slurmClusterIds: [],
      accessibleResourceRefIds: [],
      resultReturnPolicy: {
        summary: true,
        evidenceRefs: true,
        resourceRefs: true,
        logSummary: true,
        fullFileRequiresConfirmation: true,
        fullLogRequiresConfirmation: true
      },
      reportedAt: '2026-08-15T08:00:00.000Z',
      expiresAt: '2026-08-15T09:00:00.000Z'
    }
  }
  const normalizedCommand = restRequestSchema.parse(commandWithoutGpu)
  assert.deepEqual(normalizedCommand.profile.gpu, [])

  const capabilityProfile = entities.anyOf.find(
    (entry) => entry.properties?.type?.const === 'agent_capability_profile'
  )
  assert.ok(capabilityProfile, 'agent_capability_profile entity schema')
  assert.equal(capabilityProfile.additionalProperties, false)
  assert.ok(capabilityProfile.required.includes('gpu'),
    'normalized capability profile output must always contain gpu')
})

function strictObjectVariants(variants) {
  return variants.flatMap((variant) => {
    if (Array.isArray(variant.oneOf)) return strictObjectVariants(variant.oneOf)
    if (Array.isArray(variant.anyOf)) return strictObjectVariants(variant.anyOf)
    return [variant]
  })
}

test('fixtures cover required compatibility and ordering scenarios with valid public documents', () => {
  const files = generateContractArtifactFiles()
  const fixtures = [...files.entries()]
    .filter(([path]) => path.startsWith('fixtures/'))
    .map(([, content]) => JSON.parse(content))
    .filter((fixture) => Array.isArray(fixture.documents))
  assert.deepEqual(new Set(fixtures.map((fixture) => fixture.category)), new Set([
    'normal',
    'duplicate',
    'out-of-order',
    'revision-conflict',
    'idempotency-conflict',
    'execution-conflict',
    'confirmation-conflict',
    'credential-revoke'
  ]))
  for (const fixture of fixtures) {
    assert.equal(fixture.protocolVersion, '1.0')
    for (const document of fixture.documents) {
      assert.doesNotThrow(() => documentSchemas[document.schema].parse(document.value),
        `${fixture.id}:${document.role}`)
    }
  }
  const outOfOrder = fixtures.find((fixture) => fixture.category === 'out-of-order')
  assert.equal(outOfOrder.contractStatus, 'current')
  const gapResponse = outOfOrder.documents.find((document) => document.role === 'gap-response').value
  assert.equal(gapResponse.error.code, 'inbox_ack_gap')
  assert.equal(gapResponse.error.ackedSequence, 11)
  assert.equal(gapResponse.error.nextSequence, 12)
  assert.deepEqual(outOfOrder.expectations.serverCursorAtGap, { ackedSequence: 11, nextSequence: 12 })
  assert.equal(fixtures.find((fixture) => fixture.category === 'execution-conflict').contractStatus, 'current')
  assert.equal(fixtures.find((fixture) => fixture.category === 'confirmation-conflict').contractStatus, 'current')
  const credentialRevoke = fixtures.find((fixture) => fixture.category === 'credential-revoke')
  assert.equal(credentialRevoke.contractStatus, 'current')
  assert.equal(credentialRevoke.documents.find((entry) => entry.role === 'revoke-request').value.type,
    'credential.revoke_current')
  assert.equal(credentialRevoke.documents.find((entry) => entry.role === 'success-receipt').value.receipt.status,
    'succeeded')
  assert.equal(credentialRevoke.documents.find((entry) => entry.role === 'subsequent-response').value.error.code,
    'credential_revoked')
  assert.deepEqual(credentialRevoke.expectations, {
    actorType: 'agent',
    credentialMaterialDisclosed: false,
    oidcUserTokenRevoked: false,
    revocationScope: 'current-bearer-only',
    subsequentAuthentication: 'same-revoked-agent-bearer',
    subsequentUseAccepted: false,
    subsequentUseErrorCode: 'credential_revoked',
    successReceiptStatus: 'succeeded'
  })
})

test('release generation can inject one fixed commit without changing the source artifact set', () => {
  const commit = 'a'.repeat(40)
  const files = generateContractArtifactFiles(commit)
  const manifest = JSON.parse(files.get('ARTIFACT_MANIFEST.json'))
  assert.equal(manifest.contractCommit, commit)
  for (const [path, content] of files) {
    if (path === 'ARTIFACT_MANIFEST.json') continue
    assert.equal(content.includes(COMMIT_PLACEHOLDER), false, path)
  }
})
