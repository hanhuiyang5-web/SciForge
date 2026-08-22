import { describe, expect, it, vi } from 'vitest'
import type { CloudIdentitySnapshot } from '../contract.js'
import {
  IdentityCloudSessionServiceOwner,
  type IdentityCloudSessionRuntimePort
} from './cloud-session-service.js'

describe('IdentityCloudSessionService', () => {
  it('immediately subscribes with null and exposes only an ACTIVE Device snapshot', () => {
    const owner = new IdentityCloudSessionServiceOwner()
    const runtime = new RuntimeDouble(signedOutSnapshot())
    const observed: unknown[] = []
    const dispose = owner.service.subscribe((snapshot) => observed.push(snapshot))

    owner.attach(runtime)
    runtime.publish(activeSnapshot())

    expect(observed).toEqual([
      null,
      {
        cloudBaseUrl: 'https://cloud.example.test',
        userId: 'usr_CloudUser000001',
        deviceId: 'dev_CloudDevice0001',
        accessTokenExpiresAt: '2026-08-22T12:10:00.000Z',
        authorityGeneration: 1
      }
    ])
    expect(owner.service.current()).not.toHaveProperty('accessToken')
    dispose()
    owner.close()
  })

  it('does not rotate authority when the same OIDC subject receives a refreshed token', () => {
    const owner = new IdentityCloudSessionServiceOwner()
    const runtime = new RuntimeDouble(activeSnapshot())
    owner.attach(runtime)
    const observed: Array<ReturnType<typeof owner.service.current>> = []
    owner.service.subscribe((snapshot) => observed.push(snapshot))

    runtime.publish(activeSnapshot({ expiresAt: '2026-08-22T12:20:00.000Z' }))

    expect(observed).toHaveLength(2)
    expect(observed).not.toContain(null)
    expect(observed.map((snapshot) => snapshot?.authorityGeneration)).toEqual([1, 1])
    expect(observed.at(-1)?.accessTokenExpiresAt).toBe('2026-08-22T12:20:00.000Z')
  })

  it('provides a fresh token only inside the callback and preserves callback failures when authority is stable', async () => {
    const owner = new IdentityCloudSessionServiceOwner()
    const runtime = new RuntimeDouble(activeSnapshot())
    owner.attach(runtime)
    const operation = vi.fn(async (lease: {
      accessToken: string
      snapshot: Readonly<{ authorityGeneration: number }>
    }) => {
      expect(lease.accessToken).toBe('fresh-access-token')
      expect(lease.snapshot.authorityGeneration).toBe(1)
      expect(lease.snapshot).not.toHaveProperty('accessToken')
      return 'completed'
    })

    await expect(owner.service.withFreshAccessToken(operation)).resolves.toBe('completed')
    expect(runtime.acquireFreshCloudSession).toHaveBeenCalledOnce()
    const failure = new Error('consumer failed')
    await expect(owner.service.withFreshAccessToken(async () => {
      throw failure
    })).rejects.toBe(failure)
  })

  it.each(['resolve', 'reject'] as const)(
    'fences a callback that would %s after Device revocation',
    async (outcome) => {
      const owner = new IdentityCloudSessionServiceOwner()
      const runtime = new RuntimeDouble(activeSnapshot())
      owner.attach(runtime)
      const entered = deferred<void>()
      const release = deferred<void>()
      const operation = owner.service.withFreshAccessToken(async () => {
        entered.resolve()
        await release.promise
        if (outcome === 'reject') throw new Error('consumer failure must not bypass the fence')
        return 'unsafe-result'
      })

      await entered.promise
      runtime.publish(activeSnapshot({ deviceState: 'revoked' }))
      release.resolve()

      await expect(operation).rejects.toThrow('authority changed during the operation')
      expect(owner.service.current()).toBeNull()
    }
  )

  it.each([
    ['logout', signedOutSnapshot()],
    ['principal change', activeSnapshot({
      userId: 'usr_CloudUser000002',
      subject: 'keycloak-user-002',
      deviceId: 'dev_CloudDevice0002'
    })]
  ] as const)('fences an in-flight callback after %s', async (_transition, nextSnapshot) => {
    const owner = new IdentityCloudSessionServiceOwner()
    const runtime = new RuntimeDouble(activeSnapshot())
    owner.attach(runtime)
    const entered = deferred<void>()
    const release = deferred<void>()
    const operation = owner.service.withFreshAccessToken(async () => {
      entered.resolve()
      await release.promise
      return 'unsafe-result'
    })

    await entered.promise
    runtime.publish(nextSnapshot)
    release.resolve()

    await expect(operation).rejects.toThrow('authority changed during the operation')
  })

  it('rotates authority only for a real principal or ACTIVE Device change', () => {
    const owner = new IdentityCloudSessionServiceOwner()
    const runtime = new RuntimeDouble(activeSnapshot())
    owner.attach(runtime)
    expect(owner.service.current()?.authorityGeneration).toBe(1)

    runtime.publish(activeSnapshot({ deviceId: 'dev_CloudDevice0002' }))
    expect(owner.service.current()).toMatchObject({
      deviceId: 'dev_CloudDevice0002',
      authorityGeneration: 2
    })
    runtime.publish(activeSnapshot({
      userId: 'usr_CloudUser000002',
      subject: 'keycloak-user-002',
      deviceId: 'dev_CloudDevice0003'
    }))
    expect(owner.service.current()).toMatchObject({
      userId: 'usr_CloudUser000002',
      authorityGeneration: 3
    })
  })
})

class RuntimeDouble implements IdentityCloudSessionRuntimePort {
  readonly acquireFreshCloudSession = vi.fn(async () => ({
    accessToken: 'fresh-access-token',
    snapshot: this.value
  }))
  readonly #listeners = new Set<() => void>()

  constructor(private value: CloudIdentitySnapshot) {}

  cloudBaseUrl(): string {
    return 'https://cloud.example.test'
  }

  snapshot(): CloudIdentitySnapshot {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  publish(snapshot: CloudIdentitySnapshot): void {
    this.value = snapshot
    for (const listener of this.#listeners) listener()
  }
}

function activeSnapshot(input: Readonly<{
  userId?: string
  subject?: string
  deviceId?: string
  expiresAt?: string
  deviceState?: 'active' | 'not-enrolled' | 'enrolling' | 'revoked'
}> = {}): CloudIdentitySnapshot {
  const deviceId = input.deviceId ?? 'dev_CloudDevice0001'
  const device = {
    deviceId,
    displayName: 'Worker Desktop',
    status: input.deviceState === 'revoked' ? 'revoked' as const : 'active' as const,
    platform: {
      os: 'macos' as const,
      arch: 'arm64' as const,
      appVersion: '1.0.0'
    }
  }
  const deviceStatus = input.deviceState === 'not-enrolled'
    ? { state: 'not-enrolled' as const }
    : input.deviceState === 'enrolling'
      ? { state: 'enrolling' as const }
      : input.deviceState === 'revoked'
        ? { state: 'revoked' as const, device }
        : { state: 'active' as const, device }
  return {
    identity: {
      state: 'signed-in',
      user: {
        userId: input.userId ?? 'usr_CloudUser000001',
        oidcIdentityId: 'oid_CloudIdentity001',
        issuer: 'https://login.example.test/realms/SciForge',
        subject: input.subject ?? 'keycloak-user-001',
        displayName: 'Cloud User'
      },
      accessTokenExpiresAt: input.expiresAt ?? '2026-08-22T12:10:00.000Z'
    },
    device: deviceStatus,
    devices: [device],
    revision: 'cloud-1'
  }
}

function signedOutSnapshot(): CloudIdentitySnapshot {
  return {
    identity: { state: 'signed-out' },
    device: { state: 'signed-out' },
    devices: [],
    revision: 'cloud-1'
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
