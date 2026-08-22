import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deviceSchema,
  type RestResponse
} from '@sciforge/collaboration-contracts'
import {
  TEST_IDS,
  TEST_TIMESTAMP,
  agentNodeFixture,
  humanEndpointBindingFixture,
  participantProfileFixture,
  userPrincipalFixture
} from '@sciforge/collaboration-contracts/testing'
import type { IdentityCloudSessionService } from '@sciforge/domain-identity-access/main'
import type { DomainPackageJsonValue } from '@sciforge/domain-sdk/contract'
import type {
  DomainMainPackageSecretStoreHost,
  DomainMainPackageSettingsHost
} from '@sciforge/domain-sdk/package-storage'

import { CollaborationConnection } from './connection.js'
import type { CollaborationCloudClient } from './cloud-client.js'
import { DurableCloudOutbox } from './outbox.js'
import { CollaborationSettingsService } from './settings.js'
import {
  CollaborationLocalStore,
  EMPTY_COLLABORATION_LOCAL_STATE,
  type CollaborationLocalState,
  type CollaborationStateBackend
} from './store.js'

const SNAPSHOT = Object.freeze({
  cloudBaseUrl: 'https://cloud.sciforge.test',
  userId: TEST_IDS.userId,
  deviceId: TEST_IDS.deviceId,
  accessTokenExpiresAt: '2026-08-15T09:00:00.000Z',
  authorityGeneration: 1
})
const ACCESS_TOKEN = 'oidc-access-token-that-must-never-be-persisted'

test('adopts only the ACTIVE identity Device through fresh token leases without persisting OIDC authority', async () => {
  const secretStore = new MemorySecretStore()
  const settingsHost = new MemorySettingsHost()
  const settings = new CollaborationSettingsService(settingsHost)
  const store = new CollaborationLocalStore(new MemoryBackend())
  await store.open()
  const cloudIdentitySession = leaseBoundCloudSession()
  const client = cloudClient(cloudIdentitySession.isLeaseActive)
  let connection!: CollaborationConnection
  const outbox = new DurableCloudOutbox({
    store,
    packageSecrets: secretStore,
    cloudClient: () => connection.cloudClient()
  })
  connection = new CollaborationConnection({
    store,
    settings,
    packageSecrets: secretStore,
    cloudIdentitySession: cloudIdentitySession.service,
    outbox,
    createCloudClient: () => client,
    inboxHandler: { handle: async () => undefined }
  })

  await connection.configure(SNAPSHOT.cloudBaseUrl)
  const adopted = await connection.adoptCloudIdentity(SNAPSHOT)

  assert.deepEqual(adopted, { userId: SNAPSHOT.userId, deviceId: SNAPSHOT.deviceId })
  assert.equal(cloudIdentitySession.leaseCount(), 2)
  assert.deepEqual(secretStore.keys(), [])
  assert.deepEqual(await settings.require(), {
    schemaVersion: 3,
    baseUrl: SNAPSHOT.cloudBaseUrl,
    deviceId: SNAPSHOT.deviceId
  })
  assert.equal(JSON.stringify(store.snapshot()).includes(ACCESS_TOKEN), false)
  assert.equal(JSON.stringify(await settingsHost.read()).includes(ACCESS_TOKEN), false)

  await connection.releaseCloudIdentity()
  assert.equal(store.snapshot().user, undefined)
  assert.deepEqual(await settings.require(), {
    schemaVersion: 3,
    baseUrl: SNAPSHOT.cloudBaseUrl
  })
})

function leaseBoundCloudSession(): Readonly<{
  service: IdentityCloudSessionService
  isLeaseActive: () => boolean
  leaseCount: () => number
}> {
  let active = false
  let leases = 0
  return {
    service: Object.freeze({
      current: () => SNAPSHOT,
      subscribe: (listener) => {
        listener(SNAPSHOT)
        return () => undefined
      },
      withFreshAccessToken: async (operation) => {
        assert.equal(active, false)
        active = true
        leases += 1
        try {
          return await operation({ accessToken: ACCESS_TOKEN, snapshot: SNAPSHOT })
        } finally {
          active = false
        }
      }
    }),
    isLeaseActive: () => active,
    leaseCount: () => leases
  }
}

function cloudClient(isLeaseActive: () => boolean): CollaborationCloudClient {
  const device = deviceSchema.parse({
    schemaVersion: 1,
    type: 'device',
    deviceId: TEST_IDS.deviceId,
    userId: TEST_IDS.userId,
    installationId: TEST_IDS.installationId,
    displayName: 'Identity Desktop',
    platform: { os: 'macos', arch: 'arm64', appVersion: '0.1.0', osVersion: 'test' },
    publicKeyJwk: {
      kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig',
      kid: 'identity-device-test-key',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    },
    capabilitySummary: ['agent.execute'],
    status: 'active',
    revision: 1,
    createdAt: TEST_TIMESTAMP,
    updatedAt: TEST_TIMESTAMP
  })
  return {
    me: async (credential) => {
      assert.equal(isLeaseActive(), true)
      assert.equal(credential.value, ACCESS_TOKEN)
      return {
        schemaVersion: 1,
        type: 'me',
        userId: TEST_IDS.userId,
        displayName: 'Test User',
        status: 'active',
        oidcIdentityId: 'oid_Identity000001',
        issuer: 'https://login-test.sciforge.cn/realms/SciForge',
        revision: 1,
        createdAt: TEST_TIMESTAMP,
        updatedAt: TEST_TIMESTAMP
      }
    },
    listDevices: async (credential) => {
      assert.equal(isLeaseActive(), true)
      assert.equal(credential.value, ACCESS_TOKEN)
      return { devices: [device] }
    },
    execute: async (request, credential): Promise<RestResponse> => {
      if (request.type === 'endpoint.catalog.get') {
        return { protocolVersion: '1.0', type: 'endpoint.catalog', requestId: request.requestId, providers: [] }
      }
      assert.equal(request.type, 'participant.get')
      assert.equal(isLeaseActive(), true)
      assert.equal(credential?.value, ACCESS_TOKEN)
      return {
        protocolVersion: '1.0',
        type: 'participant.snapshot',
        requestId: request.requestId,
        user: userPrincipalFixture,
        participant: participantProfileFixture,
        humanEndpoints: [humanEndpointBindingFixture],
        agents: [agentNodeFixture]
      }
    },
    createDeviceEnrollment: async () => { throw new Error('not used') },
    createDevice: async () => { throw new Error('not used') },
    pullAgentInbox: async () => ({ messages: [], nextSequence: 1 }),
    observeAgentInbox: async function * () { yield* [] }
  }
}

class MemorySecretStore implements DomainMainPackageSecretStoreHost {
  private readonly values = new Map<string, string>()
  async has(key: string): Promise<boolean> { return this.values.has(key) }
  async read(key: string): Promise<string | null> { return this.values.get(key) ?? null }
  async write(key: string, value: string): Promise<void> { this.values.set(key, value) }
  async remove(key: string): Promise<void> { this.values.delete(key) }
  keys(): string[] { return [...this.values.keys()] }
}

class MemorySettingsHost implements DomainMainPackageSettingsHost {
  private revision = 0
  private value: DomainPackageJsonValue = null
  async read() { return { revision: this.revision, value: this.value } }
  async write(value: DomainPackageJsonValue, expectedRevision: number) {
    assert.equal(expectedRevision, this.revision)
    this.value = structuredClone(value)
    this.revision += 1
    return { revision: this.revision, value: this.value }
  }
  async clear(expectedRevision: number) {
    assert.equal(expectedRevision, this.revision)
    this.value = null
    this.revision += 1
    return { revision: this.revision, value: null }
  }
}

class MemoryBackend implements CollaborationStateBackend {
  private value: CollaborationLocalState = structuredClone(EMPTY_COLLABORATION_LOCAL_STATE)
  async read(): Promise<unknown> { return structuredClone(this.value) }
  async write(value: CollaborationLocalState): Promise<void> { this.value = structuredClone(value) }
}
