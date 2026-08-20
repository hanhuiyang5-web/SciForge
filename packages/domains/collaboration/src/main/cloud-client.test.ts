import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type WebSocket from 'ws'
import { DEVICE_ENROLLMENT_SIGNING_TEST_VECTOR, TEST_IDS, TEST_TIMESTAMP } from '@sciforge/collaboration-contracts/testing'
import { HttpCollaborationCloudClient } from './cloud-client.js'

test('preserves a reverse-proxy base path for commands and WebSocket events', async () => {
  const urls: string[] = []
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    urls.push(String(input))
    const request = JSON.parse(String(init?.body)) as { type: string; requestId: string }
    const response = request.type === 'inbox.pull'
      ? {
          protocolVersion: '1.0',
          type: 'rest.inbox_page',
          requestId: request.requestId,
          messages: [],
          ackedSequence: 0,
          nextSequence: 1
        }
      : {
          protocolVersion: '1.0',
          type: 'endpoint.catalog',
          requestId: request.requestId,
          providers: []
        }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  let webSocketUrl = ''
  const client = new HttpCollaborationCloudClient({
    baseUrl: 'https://chat.sciforge.cn/collaboration',
    fetch: fetchImpl,
    webSocketFactory: (url) => {
      webSocketUrl = url
      return new FakeWebSocket() as unknown as WebSocket
    }
  })

  await client.execute({
    protocolVersion: '1.0',
    requestId: 'req_Request000001',
    type: 'endpoint.catalog.get'
  })
  await client.pullAgentInbox({
    afterSequence: 0,
    credential: { value: 'x'.repeat(32) }
  })
  assert.deepEqual(urls, [
    'https://chat.sciforge.cn/collaboration/v1/commands',
    'https://chat.sciforge.cn/collaboration/v1/commands'
  ])

  const controller = new AbortController()
  const iterator = client.observeAgentInbox(
    { value: 'x'.repeat(32) },
    controller.signal
  )[Symbol.asyncIterator]()
  const pending = iterator.next()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(webSocketUrl, 'wss://chat.sciforge.cn/collaboration/v1/events')
  controller.abort()
  await pending.catch(() => undefined)
})

test('uses the exact A R0.1 OIDC, Device enrollment, and Device registration HTTP contracts', async () => {
  const calls: Array<Readonly<{ url: string; authorization: string | null; idempotency: string | null }>> = []
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      authorization: headers.get('authorization'),
      idempotency: headers.get('idempotency-key')
    })
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    let response: unknown
    if (url.endsWith('/v1/me')) {
      response = {
        schemaVersion: 1, type: 'me', userId: TEST_IDS.userId, displayName: 'Test User',
        status: 'active', oidcIdentityId: 'oid_Identity000001', issuer: 'https://identity.example.test',
        revision: 1, createdAt: TEST_TIMESTAMP, updatedAt: TEST_TIMESTAMP
      }
    } else if (url.endsWith('/v1/device-enrollments')) {
      assert.equal(body?.installationId, TEST_IDS.installationId)
      response = {
        enrollmentId: DEVICE_ENROLLMENT_SIGNING_TEST_VECTOR.facts.enrollmentId,
        nonce: DEVICE_ENROLLMENT_SIGNING_TEST_VECTOR.facts.nonce,
        expiresAt: DEVICE_ENROLLMENT_SIGNING_TEST_VECTOR.facts.expiresAt
      }
    } else if (url.endsWith('/v1/me/devices')) {
      response = { devices: [] }
    } else {
      response = {
        device: {
          schemaVersion: 1, type: 'device', deviceId: TEST_IDS.deviceId, userId: TEST_IDS.userId,
          installationId: body?.installationId, displayName: body?.displayName, platform: body?.platform,
          publicKeyJwk: body?.publicKeyJwk, capabilitySummary: body?.capabilitySummary,
          status: 'active', revision: 1, createdAt: TEST_TIMESTAMP, updatedAt: TEST_TIMESTAMP
        }
      }
    }
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new HttpCollaborationCloudClient({
    baseUrl: 'https://chat.sciforge.cn/collaboration',
    fetch: fetchImpl
  })
  const credential = { value: 'x'.repeat(40) }
  await client.me(credential)
  const enrollment = await client.createDeviceEnrollment({
    installationId: TEST_IDS.installationId,
    idempotencyKey: 'idem_device.enrollment.test0001'
  }, credential)
  await client.createDevice({
    enrollmentId: enrollment.enrollmentId,
    nonce: enrollment.nonce,
    installationId: TEST_IDS.installationId,
    displayName: 'Test Device',
    platform: { os: 'macos', arch: 'arm64', appVersion: '1.0.0' },
    publicKeyJwk: DEVICE_ENROLLMENT_SIGNING_TEST_VECTOR.publicKeyJwk,
    capabilitySummary: ['agent.execute'],
    signature: DEVICE_ENROLLMENT_SIGNING_TEST_VECTOR.signature,
    idempotencyKey: 'idem_device.create.test0001'
  }, credential)
  await client.listDevices(credential)

  assert.deepEqual(calls, [
    {
      url: 'https://chat.sciforge.cn/collaboration/v1/me',
      authorization: `Bearer ${credential.value}`,
      idempotency: null
    },
    {
      url: 'https://chat.sciforge.cn/collaboration/v1/device-enrollments',
      authorization: `Bearer ${credential.value}`,
      idempotency: 'idem_device.enrollment.test0001'
    },
    {
      url: 'https://chat.sciforge.cn/collaboration/v1/devices',
      authorization: `Bearer ${credential.value}`,
      idempotency: 'idem_device.create.test0001'
    },
    {
      url: 'https://chat.sciforge.cn/collaboration/v1/me/devices',
      authorization: `Bearer ${credential.value}`,
      idempotency: null
    }
  ])
})

class FakeWebSocket extends EventEmitter {
  readyState = 0

  constructor() {
    super()
    queueMicrotask(() => {
      this.readyState = 1
      this.emit('open')
    })
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close')
  }
}
