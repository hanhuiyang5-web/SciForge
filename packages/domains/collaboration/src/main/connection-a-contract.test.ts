import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type RestRequest,
  type RestResponse
} from '@sciforge/collaboration-contracts'
import {
  TEST_IDS,
  TEST_LATER_TIMESTAMP,
  TEST_TIMESTAMP,
  agentCapabilityProfileFixture,
  agentNodeFixture,
  humanEndpointBindingFixture,
  participantProfileFixture,
  userPrincipalFixture
} from '@sciforge/collaboration-contracts/testing'
import type {
  DomainMainPackageSecretStoreHost,
  DomainMainPackageSettingsHost
} from '@sciforge/domain-sdk/package-storage'

import type { CollaborationCloudClient } from './cloud-client.js'
import {
  COLLABORATION_DEVICE_CREDENTIAL_KEY,
  COLLABORATION_OIDC_ACCESS_TOKEN_KEY,
  CollaborationConnection
} from './connection.js'
import type { DurableCloudOutbox } from './outbox.js'
import { CollaborationSettingsService } from './settings.js'
import {
  CollaborationLocalStore,
  EMPTY_COLLABORATION_LOCAL_STATE,
  type CollaborationLocalState,
  type CollaborationStateBackend
} from './store.js'

const BASE_URL = 'https://collaboration.example.test'
const OIDC_TOKEN = 'o'.repeat(40)
const DEVICE_CREDENTIAL = 'd'.repeat(40)
const BINDING_REQUEST_ID = 'zbr_BindingRequest0001'

test('C pairing uses the A binding contract and never persists a poll credential', async () => {
  const fixture = await connectionFixture({ oidc: true })
  const credentials: Array<string | undefined> = []
  fixture.client.execute = async (request, credential) => {
    credentials.push(credential?.value)
    if (request.type === 'endpoint.catalog.get') return endpointCatalog(request.requestId)
    if (request.type === 'pairing.begin') {
      assert.equal(request.realmUrl, 'https://research.example')
      return {
        protocolVersion: '1.0', type: 'pairing.begun', requestId: request.requestId,
        bindingRequestId: BINDING_REQUEST_ID,
        bindingCode: 'PAIR-2026-TEST',
        expiresAt: '2099-08-15T09:00:00.000Z'
      }
    }
    assert.equal(request.type, 'pairing.redeem')
    return {
      protocolVersion: '1.0', type: 'pairing.pending', requestId: request.requestId,
      bindingRequestId: BINDING_REQUEST_ID, retryAfterSeconds: 7
    }
  }
  await fixture.connection.activate()

  const begun = await fixture.connection.startChallenge({
    providerKey: 'zulip',
    requestedDisplayName: 'Mobile endpoint',
    locator: { realmUrl: 'https://research.example' }
  })
  const pending = await fixture.connection.pollChallenge({ challengeId: begun.challengeId })

  assert.equal(begun.challengeId, BINDING_REQUEST_ID)
  assert.equal(begun.pairingCode, 'sciforge-pair PAIR-2026-TEST')
  assert.deepEqual(pending, {
    status: 'pending',
    expiresAt: '2099-08-15T09:00:00.000Z',
    retryAfterSeconds: 7
  })
  const durablePoll = fixture.secrets.get('pairing-poll') ?? ''
  assert.equal(durablePoll.includes(BINDING_REQUEST_ID), true)
  assert.equal(durablePoll.includes(OIDC_TOKEN), false)
  assert.deepEqual(credentials, [undefined, OIDC_TOKEN, OIDC_TOKEN])
})

test('C fails closed when A OIDC or Device enrollment is unavailable', async () => {
  const withoutOidc = await connectionFixture()
  withoutOidc.client.execute = async (request) => (
    request.type === 'endpoint.catalog.get'
      ? endpointCatalog(request.requestId)
      : unexpected(request)
  )
  await withoutOidc.connection.activate()
  await assert.rejects(
    withoutOidc.connection.startChallenge({
      providerKey: 'zulip', requestedDisplayName: 'Phone',
      locator: { realmUrl: 'https://research.example' }
    }),
    /OIDC access token is unavailable/u
  )

  const withoutDevice = await connectionFixture({ oidc: true, user: true })
  withoutDevice.client.execute = withoutOidc.client.execute
  await withoutDevice.connection.activate()
  await assert.rejects(
    withoutDevice.connection.registerAgent({
      displayName: 'Desktop', nodeType: 'desktop', capabilities: []
    }),
    /no enrolled A Device/u
  )
})

test('C adopts only the ACTIVE A Device already enrolled by Desktop identity', async (context) => {
  const fixture = await connectionFixture()
  context.after(() => fixture.connection.dispose())
  const credentials: string[] = []
  fixture.client.me = async (credential) => {
    credentials.push(credential.value)
    return {
      schemaVersion: 1,
      type: 'me',
      userId: TEST_IDS.userId,
      displayName: userPrincipalFixture.displayName,
      status: 'active',
      oidcIdentityId: 'oid_Identity000001',
      issuer: 'https://identity.example.test',
      revision: 1,
      createdAt: TEST_TIMESTAMP,
      updatedAt: TEST_TIMESTAMP
    }
  }
  fixture.client.listDevices = async (credential) => {
    credentials.push(credential.value)
    return {
      devices: [{
        schemaVersion: 1,
        type: 'device',
        deviceId: TEST_IDS.deviceId,
        userId: TEST_IDS.userId,
        installationId: TEST_IDS.installationId,
        displayName: 'Research Mac',
        platform: { os: 'macos', arch: 'arm64', osVersion: '15.6', appVersion: '1.0.0' },
        publicKeyJwk: {
          kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig',
          kid: 'desktop-device-key', x: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg'
        },
        capabilitySummary: ['agent.execute', 'content-space.read'],
        status: 'active',
        revision: 1,
        createdAt: TEST_TIMESTAMP,
        updatedAt: TEST_TIMESTAMP
      }]
    }
  }
  fixture.client.execute = async (request, credential) => {
    if (request.type === 'endpoint.catalog.get') return endpointCatalog(request.requestId)
    assert.equal(request.type, 'participant.get')
    credentials.push(credential?.value ?? '')
    return {
      protocolVersion: '1.0', type: 'participant.snapshot', requestId: request.requestId,
      user: userPrincipalFixture, participant: participantProfileFixture,
      humanEndpoints: [humanEndpointBindingFixture], agents: []
    }
  }
  await fixture.connection.activate()

  const identity = await fixture.connection.adoptCloudIdentity({
    accessToken: OIDC_TOKEN,
    userId: TEST_IDS.userId,
    deviceId: TEST_IDS.deviceId
  })

  assert.deepEqual(identity, { userId: TEST_IDS.userId, deviceId: TEST_IDS.deviceId })
  assert.deepEqual(credentials, [OIDC_TOKEN, OIDC_TOKEN, OIDC_TOKEN])
  assert.equal(fixture.secrets.get(COLLABORATION_OIDC_ACCESS_TOKEN_KEY), OIDC_TOKEN)
  assert.equal(JSON.stringify(fixture.store.snapshot()).includes(OIDC_TOKEN), false)
  assert.equal((await fixture.settings.read()).settings?.deviceId, TEST_IDS.deviceId)
})

test('C adopts a replacement ACTIVE Device and clears the old Agent binding', async (context) => {
  const fixture = await connectionFixture({ device: true, agent: true })
  context.after(() => fixture.connection.dispose())
  fixture.client.execute = async (request) => {
    if (request.type === 'endpoint.catalog.get') return endpointCatalog(request.requestId)
    assert.equal(request.type, 'participant.get')
    return {
      protocolVersion: '1.0', type: 'participant.snapshot', requestId: request.requestId,
      user: userPrincipalFixture, participant: participantProfileFixture,
      humanEndpoints: [], agents: []
    }
  }
  fixture.client.me = async () => ({
    schemaVersion: 1, type: 'me', userId: TEST_IDS.userId, displayName: 'Test User',
    status: 'active', oidcIdentityId: 'oid_Identity000001', issuer: 'https://identity.example.test',
    revision: 1, createdAt: TEST_TIMESTAMP, updatedAt: TEST_TIMESTAMP
  })
  fixture.client.listDevices = async () => ({
    devices: [{
      schemaVersion: 1, type: 'device', deviceId: 'dev_Replacement001', userId: TEST_IDS.userId,
      installationId: 'ins_Replacement0001', displayName: 'Replacement Device',
      platform: { os: 'macos', arch: 'arm64', appVersion: '1.0.0' },
      publicKeyJwk: {
        kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig',
        kid: 'replacement-device-key', x: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg'
      },
      capabilitySummary: ['agent.execute'], status: 'active', revision: 1,
      createdAt: TEST_TIMESTAMP, updatedAt: TEST_TIMESTAMP
    }]
  })
  await fixture.connection.activate()
  fixture.secrets.set(COLLABORATION_DEVICE_CREDENTIAL_KEY, DEVICE_CREDENTIAL)

  const identity = await fixture.connection.adoptCloudIdentity({
    accessToken: OIDC_TOKEN,
    userId: TEST_IDS.userId,
    deviceId: 'dev_Replacement001'
  })

  assert.equal(identity.deviceId, 'dev_Replacement001')
  assert.equal((await fixture.settings.read()).settings?.deviceId, 'dev_Replacement001')
  assert.equal((await fixture.settings.read()).settings?.installationId, 'ins_Replacement0001')
  assert.equal((await fixture.settings.read()).settings?.agentId, undefined)
  assert.equal(fixture.secrets.has(COLLABORATION_DEVICE_CREDENTIAL_KEY), false)
})

test('C clears the previous Cloud authority only when the configured base URL changes', async (context) => {
  const fixture = await connectionFixture({ oidc: true, user: true, device: true, agent: true })
  context.after(() => fixture.connection.dispose())
  fixture.secrets.set(COLLABORATION_DEVICE_CREDENTIAL_KEY, DEVICE_CREDENTIAL)
  fixture.client.execute = async (request) => {
    if (request.type === 'endpoint.catalog.get') return endpointCatalog(request.requestId)
    assert.equal(request.type, 'participant.get')
    return {
      protocolVersion: '1.0', type: 'participant.snapshot', requestId: request.requestId,
      user: userPrincipalFixture, participant: participantProfileFixture,
      humanEndpoints: [humanEndpointBindingFixture], agents: [agentNodeFixture]
    }
  }
  await fixture.connection.activate()

  await fixture.connection.configure(BASE_URL)
  assert.equal(fixture.secrets.get(COLLABORATION_DEVICE_CREDENTIAL_KEY), DEVICE_CREDENTIAL)
  assert.equal(fixture.store.snapshot().user?.userId, TEST_IDS.userId)

  await fixture.connection.configure('https://second-authority.example.test/collaboration')
  const settings = (await fixture.settings.read()).settings
  assert.equal(settings?.deviceId, undefined)
  assert.equal(settings?.agentId, undefined)
  assert.equal(fixture.secrets.has(COLLABORATION_OIDC_ACCESS_TOKEN_KEY), false)
  assert.equal(fixture.secrets.has(COLLABORATION_DEVICE_CREDENTIAL_KEY), false)
  assert.equal(fixture.store.snapshot().user, undefined)
  assert.equal(fixture.store.snapshot().agents.length, 0)
  assert.equal(fixture.store.snapshot().outbox.length, 0)
})

test('C registers the A Device-backed Agent and advertises B capabilities', async (context) => {
  const fixture = await connectionFixture({ oidc: true, user: true, device: true })
  context.after(() => fixture.connection.dispose())
  const requests: RestRequest[] = []
  const credentialUse: Array<string | undefined> = []
  let registered = false
  fixture.client.execute = async (request, credential) => {
    requests.push(request)
    credentialUse.push(credential?.value)
    if (request.type === 'endpoint.catalog.get') return endpointCatalog(request.requestId)
    if (request.type === 'agent.register') {
      assert.equal(request.deviceId, TEST_IDS.deviceId)
      registered = true
      return {
        protocolVersion: '1.0', type: 'agent.registered', requestId: request.requestId,
        agent: agentNodeFixture, deviceCredential: DEVICE_CREDENTIAL
      }
    }
    if (request.type === 'participant.get') {
      return {
        protocolVersion: '1.0', type: 'participant.snapshot', requestId: request.requestId,
        user: userPrincipalFixture, participant: participantProfileFixture,
        humanEndpoints: [humanEndpointBindingFixture], agents: registered ? [agentNodeFixture] : []
      }
    }
    if (request.type === 'endpoint.locator.list') {
      return {
        protocolVersion: '1.0', type: 'endpoint.locator_page',
        requestId: request.requestId, locators: []
      }
    }
    if (request.type === 'agent.capability_profile.report') {
      return {
        protocolVersion: '1.0', type: 'rest.entity', requestId: request.requestId,
        entity: {
          ...agentCapabilityProfileFixture,
          ...request.profile,
          revision: request.expectedProfileRevision + 1,
          createdAt: request.profile.reportedAt,
          updatedAt: request.profile.reportedAt
        }
      }
    }
    assert.equal(request.type, 'agent.heartbeat')
    return {
      protocolVersion: '1.0', type: 'rest.entity', requestId: request.requestId,
      entity: {
        ...agentNodeFixture,
        capabilities: request.capabilities,
        connectionStatus: request.connectionStatus,
        revision: agentNodeFixture.revision + 1,
        updatedAt: TEST_LATER_TIMESTAMP
      }
    }
  }
  await fixture.connection.activate()

  const agent = await fixture.connection.registerAgent({
    displayName: 'Desktop', nodeType: 'desktop', capabilities: ['workspace.read']
  })
  await fixture.connection.setBCCapabilities(true)

  assert.equal(agent.agentId, TEST_IDS.agentId)
  assert.equal(fixture.secrets.get(COLLABORATION_DEVICE_CREDENTIAL_KEY), DEVICE_CREDENTIAL)
  assert.equal((await fixture.settings.read()).settings?.agentId, TEST_IDS.agentId)
  const heartbeats = requests.filter((request): request is Extract<RestRequest, { type: 'agent.heartbeat' }> => (
    request.type === 'agent.heartbeat'
  ))
  const profiles = requests.filter((request): request is Extract<RestRequest, { type: 'agent.capability_profile.report' }> => (
    request.type === 'agent.capability_profile.report'
  ))
  assert.equal(heartbeats.length >= 2, true)
  assert.deepEqual(heartbeats.at(-1)?.capabilities, [
    'agent.execute', 'project.coordinator.v1', 'project.worker.v1', 'workspace.read'
  ])
  assert.equal(profiles.length >= 2, true)
  assert.deepEqual(profiles.at(-1)?.profile.capabilities.map((item) => item.capabilityId), [
    'agent.execute', 'project.coordinator.v1', 'project.worker.v1', 'workspace.read'
  ])
  assert.equal((await fixture.settings.read()).settings?.capabilityProfileRevision, 2)
  assert.equal((await fixture.settings.read()).settings?.pendingCapabilityProfileReport, undefined)
  const registrationIndex = requests.findIndex((request) => request.type === 'agent.register')
  assert.equal(credentialUse[registrationIndex], OIDC_TOKEN)
  assert.equal(credentialUse.at(-1), DEVICE_CREDENTIAL)
})

test('C recovers one-time Agent credentials after registration and rotation responses are lost', async (context) => {
  const fixture = await connectionFixture({ oidc: true, user: true, device: true })
  context.after(() => fixture.connection.dispose())
  const registrations: Extract<RestRequest, { type: 'agent.register' }>[] = []
  const rotations: Extract<RestRequest, { type: 'agent.rotate_credential' }>[] = []
  let cloudAgent: typeof agentNodeFixture | undefined
  fixture.client.execute = async (request, credential) => {
    if (request.type === 'endpoint.catalog.get') return endpointCatalog(request.requestId)
    if (request.type === 'participant.get') {
      return {
        protocolVersion: '1.0', type: 'participant.snapshot', requestId: request.requestId,
        user: userPrincipalFixture, participant: participantProfileFixture,
        humanEndpoints: [humanEndpointBindingFixture], agents: cloudAgent ? [cloudAgent] : []
      }
    }
    if (request.type === 'agent.register') {
      assert.equal(credential?.value, OIDC_TOKEN)
      registrations.push(structuredClone(request))
      if (registrations.length === 1) {
        cloudAgent = structuredClone(agentNodeFixture)
        throw new Error('registration response lost after A commit')
      }
      throw new Error('A rejected the exact replay because the one-time credential was consumed')
    }
    if (request.type === 'agent.rotate_credential') {
      assert.equal(credential?.value, OIDC_TOKEN)
      assert.ok(cloudAgent)
      rotations.push(structuredClone(request))
      if (rotations.length === 1) {
        assert.equal(request.expectedRevision, cloudAgent.revision)
        cloudAgent = {
          ...cloudAgent,
          revision: cloudAgent.revision + 1,
          credentialVersion: cloudAgent.credentialVersion + 1,
          updatedAt: TEST_LATER_TIMESTAMP
        }
        throw new Error('rotation response lost after A commit')
      }
      if (rotations.length === 2) {
        throw new Error('A rejected the exact replay because the one-time credential was consumed')
      }
      assert.equal(request.expectedRevision, cloudAgent.revision)
      cloudAgent = {
        ...cloudAgent,
        revision: cloudAgent.revision + 1,
        credentialVersion: cloudAgent.credentialVersion + 1,
        updatedAt: TEST_LATER_TIMESTAMP
      }
      return {
        protocolVersion: '1.0', type: 'agent.credential_rotated', requestId: request.requestId,
        agent: cloudAgent, deviceCredential: DEVICE_CREDENTIAL
      }
    }
    if (request.type === 'endpoint.locator.list') {
      return {
        protocolVersion: '1.0', type: 'endpoint.locator_page',
        requestId: request.requestId, locators: []
      }
    }
    if (request.type === 'agent.heartbeat') {
      assert.equal(credential?.value, DEVICE_CREDENTIAL)
      return {
        protocolVersion: '1.0', type: 'rest.entity', requestId: request.requestId,
        entity: {
          ...cloudAgent!,
          connectionStatus: request.connectionStatus,
          capabilities: request.capabilities,
          revision: request.expectedRevision + 1,
          updatedAt: TEST_LATER_TIMESTAMP
        }
      }
    }
    assert.equal(request.type, 'agent.capability_profile.report')
    return {
      protocolVersion: '1.0', type: 'rest.entity', requestId: request.requestId,
      entity: {
        ...agentCapabilityProfileFixture,
        ...request.profile,
        revision: request.expectedProfileRevision + 1,
        createdAt: request.profile.reportedAt,
        updatedAt: request.profile.reportedAt
      }
    }
  }

  await fixture.connection.activate()
  const recovered = await fixture.connection.registerAgent({
    displayName: 'Desktop', nodeType: 'desktop', capabilities: ['workspace.read']
  })

  assert.equal(registrations.length, 2)
  assert.deepEqual(registrations[1], registrations[0])
  assert.equal(rotations.length, 3)
  assert.deepEqual(rotations[1], rotations[0])
  assert.deepEqual(rotations.map((request) => request.expectedRevision), [1, 1, 2])
  assert.equal(recovered.revision, 3)
  assert.equal(fixture.secrets.get(COLLABORATION_DEVICE_CREDENTIAL_KEY), DEVICE_CREDENTIAL)
  assert.equal((await fixture.settings.read()).settings?.agentId, TEST_IDS.agentId)
})

test('C replays an uncertain capability report with the exact durable payload', async (context) => {
  const fixture = await connectionFixture({ oidc: true, user: true, device: true, agent: true })
  context.after(() => fixture.connection.dispose())
  fixture.secrets.set(COLLABORATION_DEVICE_CREDENTIAL_KEY, DEVICE_CREDENTIAL)
  const reports: Extract<RestRequest, { type: 'agent.capability_profile.report' }>[] = []
  fixture.client.execute = async (request) => {
    if (request.type === 'endpoint.catalog.get') return endpointCatalog(request.requestId)
    if (request.type === 'participant.get') {
      return {
        protocolVersion: '1.0', type: 'participant.snapshot', requestId: request.requestId,
        user: userPrincipalFixture, participant: participantProfileFixture,
        humanEndpoints: [humanEndpointBindingFixture], agents: [agentNodeFixture]
      }
    }
    if (request.type === 'endpoint.locator.list') {
      return {
        protocolVersion: '1.0', type: 'endpoint.locator_page',
        requestId: request.requestId, locators: []
      }
    }
    if (request.type === 'agent.heartbeat') {
      return {
        protocolVersion: '1.0', type: 'rest.entity', requestId: request.requestId,
        entity: {
          ...agentNodeFixture,
          capabilities: request.capabilities,
          connectionStatus: request.connectionStatus,
          revision: request.expectedRevision + 1,
          updatedAt: TEST_LATER_TIMESTAMP
        }
      }
    }
    assert.equal(request.type, 'agent.capability_profile.report')
    reports.push(structuredClone(request))
    if (reports.length === 1) throw new Error('response lost after A commit')
    return {
      protocolVersion: '1.0', type: 'rest.entity', requestId: request.requestId,
      entity: {
        ...agentCapabilityProfileFixture,
        ...request.profile,
        revision: request.expectedProfileRevision + 1,
        createdAt: request.profile.reportedAt,
        updatedAt: request.profile.reportedAt
      }
    }
  }

  await fixture.connection.activate()
  assert.ok((await fixture.settings.read()).settings?.pendingCapabilityProfileReport)
  await fixture.connection.applyConnectionAction({ action: 'recover' })

  assert.equal(reports.length, 2)
  assert.deepEqual(reports[1], reports[0])
  assert.equal((await fixture.settings.read()).settings?.pendingCapabilityProfileReport, undefined)
  assert.equal((await fixture.settings.read()).settings?.capabilityProfileRevision, 1)
})

test('Agent revocation removes only the C device credential and Agent binding', async () => {
  const fixture = await connectionFixture({ oidc: true, user: true, device: true, agent: true })
  fixture.secrets.set(COLLABORATION_DEVICE_CREDENTIAL_KEY, DEVICE_CREDENTIAL)

  await fixture.connection.acceptAgentRevocation(TEST_IDS.agentId, TEST_LATER_TIMESTAMP)

  assert.equal(fixture.secrets.has(COLLABORATION_DEVICE_CREDENTIAL_KEY), false)
  assert.equal((await fixture.settings.read()).settings?.agentId, undefined)
  assert.equal(fixture.store.snapshot().agents[0]?.lifecycleStatus, 'revoked')
  assert.equal(fixture.secrets.get(COLLABORATION_OIDC_ACCESS_TOKEN_KEY), OIDC_TOKEN)
})

async function connectionFixture(options: Readonly<{
  oidc?: boolean
  user?: boolean
  device?: boolean
  agent?: boolean
}> = {}) {
  const initial: CollaborationLocalState = {
    ...structuredClone(EMPTY_COLLABORATION_LOCAL_STATE),
    ...(options.user ? {
      user: userPrincipalFixture,
      participant: participantProfileFixture,
      endpoints: [humanEndpointBindingFixture]
    } : {}),
    ...(options.agent ? { agents: [agentNodeFixture] } : {})
  }
  const store = new CollaborationLocalStore(new MemoryBackend(initial))
  await store.open()
  const settings = new CollaborationSettingsService(new MemorySettingsHost({
    schemaVersion: 2,
    baseUrl: BASE_URL,
    installationId: TEST_IDS.installationId,
    ...(options.device ? { deviceId: TEST_IDS.deviceId } : {}),
    ...(options.agent ? { agentId: TEST_IDS.agentId } : {})
  }))
  const secrets = new Map<string, string>()
  if (options.oidc) secrets.set(COLLABORATION_OIDC_ACCESS_TOKEN_KEY, OIDC_TOKEN)
  const secretHost: DomainMainPackageSecretStoreHost = {
    has: async (key) => secrets.has(key),
    read: async (key) => secrets.get(key) ?? null,
    write: async (key, value) => { secrets.set(key, value) },
    remove: async (key) => { secrets.delete(key) }
  }
  const client = lifecycleClient()
  const connection = new CollaborationConnection({
    store,
    settings,
    packageSecrets: secretHost,
    outbox: {
      start: () => undefined,
      stop: () => undefined,
      wake: () => undefined
    } as unknown as DurableCloudOutbox,
    createCloudClient: () => client,
    inboxHandler: { handle: async () => undefined }
  })
  return { connection, client, secrets, settings, store }
}

function lifecycleClient(): CollaborationCloudClient {
  return {
    me: async () => { throw new Error('Unexpected A identity request: me') },
    createDeviceEnrollment: async () => { throw new Error('Unexpected A identity request: device enrollment') },
    createDevice: async () => { throw new Error('Unexpected A identity request: device create') },
    listDevices: async () => { throw new Error('Unexpected A identity request: device list') },
    execute: async (request) => unexpected(request),
    pullAgentInbox: async () => ({ messages: [], nextSequence: 1 }),
    observeAgentInbox: async function *(_credential, signal) {
      if (!signal.aborted) yield* []
    }
  }
}

function endpointCatalog(requestId: string): RestResponse {
  return {
    protocolVersion: '1.0', type: 'endpoint.catalog', requestId,
    providers: [{
      protocolVersion: '1.0', type: 'human_endpoint_provider_contract',
      provider: 'zulip', displayName: 'Zulip',
      capabilities: {
        textMessages: true, stableLocators: true, eventCursor: true,
        locatorRename: true, locatorMove: true, locatorDiscovery: true,
        identityChallenge: true
      },
      onboarding: {
        realmLabel: 'Realm', accountLabel: 'Account',
        containerLabel: 'Stream', topicLabel: 'Topic'
      },
      limits: { maxTextLength: 10_000, maxLocatorDisplayLength: 200 }
    }]
  }
}

function unexpected(request: RestRequest): never {
  throw new Error(`Unexpected A request: ${request.type}`)
}

class MemoryBackend implements CollaborationStateBackend {
  constructor(private value: CollaborationLocalState) {}
  async read(): Promise<unknown> { return structuredClone(this.value) }
  async write(value: CollaborationLocalState): Promise<void> { this.value = structuredClone(value) }
}

class MemorySettingsHost implements DomainMainPackageSettingsHost {
  private revision = 1
  constructor(private value: Parameters<DomainMainPackageSettingsHost['write']>[0]) {}
  async read() { return { revision: this.revision, value: structuredClone(this.value) } }
  async write(value: Parameters<DomainMainPackageSettingsHost['write']>[0], expectedRevision?: number) {
    assert.equal(expectedRevision, this.revision)
    this.revision += 1
    this.value = structuredClone(value)
    return { revision: this.revision, value: structuredClone(this.value) }
  }
  async clear(expectedRevision?: number) {
    assert.equal(expectedRevision, this.revision)
    this.revision += 1
    return { revision: this.revision, value: null }
  }
}
