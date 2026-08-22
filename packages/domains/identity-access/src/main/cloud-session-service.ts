import type { CloudIdentitySnapshot } from '../contract.js'

export const IDENTITY_CLOUD_SESSION_SERVICE_ID = 'identity.cloud-session'
export const IDENTITY_CLOUD_SESSION_CONTRACT_VERSION = '1.0.0'
export const IDENTITY_CLOUD_SESSION_ALLOWED_CONSUMERS = Object.freeze([
  'sciforge.collaboration'
] as const)

export type IdentityCloudSessionSnapshot = Readonly<{
  cloudBaseUrl: string
  userId: string
  deviceId: string
  accessTokenExpiresAt: string
  authorityGeneration: number
}>

export type IdentityCloudSessionAccessLease = Readonly<{
  accessToken: string
  snapshot: IdentityCloudSessionSnapshot
}>

export type IdentityCloudSessionService = Readonly<{
  current(): IdentityCloudSessionSnapshot | null
  withFreshAccessToken<Result>(
    operation: (lease: IdentityCloudSessionAccessLease) => Result | Promise<Result>
  ): Promise<Result>
  /** Registers a listener and immediately calls it with the current snapshot or null. */
  subscribe(listener: (snapshot: IdentityCloudSessionSnapshot | null) => void): () => void
}>

export type IdentityCloudSessionRuntimePort = Readonly<{
  cloudBaseUrl(): string | null
  snapshot(): CloudIdentitySnapshot
  acquireFreshCloudSession(): Promise<Readonly<{
    accessToken: string
    snapshot: CloudIdentitySnapshot
  }>>
  subscribe(listener: () => void): () => void
}>

type ActiveAuthority = Readonly<{
  authorityKey: string
  principalKey: string
  snapshot: IdentityCloudSessionSnapshot
}>

const NO_OPERATION_FAILURE = Symbol('no-operation-failure')

/**
 * Owns the stable Host-registered facade while the package lifecycle attaches
 * and detaches the current Cloud runtime. The facade never exposes bearer
 * tokens through snapshots or subscriptions.
 */
export class IdentityCloudSessionServiceOwner {
  readonly service: IdentityCloudSessionService
  readonly #listeners = new Set<(snapshot: IdentityCloudSessionSnapshot | null) => void>()
  #runtime: IdentityCloudSessionRuntimePort | null = null
  #disposeRuntimeSubscription: (() => void) | null = null
  #authority: ActiveAuthority | null = null
  #generation = 0
  #closed = false

  constructor() {
    this.service = Object.freeze({
      current: () => this.current(),
      withFreshAccessToken: <Result>(
        operation: (lease: IdentityCloudSessionAccessLease) => Result | Promise<Result>
      ) => this.withFreshAccessToken(operation),
      subscribe: (listener) => this.subscribe(listener)
    })
  }

  attach(runtime: IdentityCloudSessionRuntimePort): void {
    if (this.#closed) throw new Error('Cloud session service is closed.')
    if (this.#runtime) throw new Error('Cloud session runtime is already attached.')
    this.#runtime = runtime
    try {
      this.#disposeRuntimeSubscription = runtime.subscribe(() => this.#reconcile())
      this.#reconcile()
    } catch (error) {
      this.#disposeRuntimeSubscription?.()
      this.#disposeRuntimeSubscription = null
      this.#runtime = null
      throw error
    }
  }

  detach(runtime: IdentityCloudSessionRuntimePort): void {
    if (this.#runtime !== runtime) return
    this.#disposeRuntimeSubscription?.()
    this.#disposeRuntimeSubscription = null
    this.#runtime = null
    this.#invalidateAuthority()
  }

  close(): void {
    if (this.#closed) return
    const runtime = this.#runtime
    if (runtime) this.detach(runtime)
    this.#closed = true
    this.#listeners.clear()
  }

  private current(): IdentityCloudSessionSnapshot | null {
    return this.#authority?.snapshot ?? null
  }

  private subscribe(
    listener: (snapshot: IdentityCloudSessionSnapshot | null) => void
  ): () => void {
    if (this.#closed) throw new Error('Cloud session service is closed.')
    this.#listeners.add(listener)
    try {
      listener(this.current())
    } catch (error) {
      this.#listeners.delete(listener)
      throw error
    }
    return () => this.#listeners.delete(listener)
  }

  private async withFreshAccessToken<Result>(
    operation: (lease: IdentityCloudSessionAccessLease) => Result | Promise<Result>
  ): Promise<Result> {
    if (typeof operation !== 'function') {
      throw new TypeError('Cloud session token operation must be a function.')
    }
    const runtime = this.#runtime
    if (!runtime || this.#closed) throw unavailableAuthorityError()

    const acquired = await runtime.acquireFreshCloudSession()
    if (this.#runtime !== runtime || this.#closed) throw changedAuthorityError()
    const acquiredAuthority = activeAuthorityFrom(runtime, acquired.snapshot, 0)
    if (!acquiredAuthority) throw unavailableAuthorityError()

    this.#reconcile()
    const before = this.#authority
    if (!before || before.authorityKey !== acquiredAuthority.authorityKey) {
      throw changedAuthorityError()
    }
    const authorityGeneration = before.snapshot.authorityGeneration
    const authorityKey = before.authorityKey
    const lease = Object.freeze({
      accessToken: acquired.accessToken,
      snapshot: before.snapshot
    })

    let result!: Result
    let operationFailure: unknown | typeof NO_OPERATION_FAILURE = NO_OPERATION_FAILURE
    try {
      result = await operation(lease)
    } catch (error) {
      operationFailure = error
    }

    if (this.#runtime === runtime && !this.#closed) this.#reconcile()
    const after = this.#authority
    if (
      this.#runtime !== runtime ||
      this.#closed ||
      !after ||
      after.authorityKey !== authorityKey ||
      after.snapshot.authorityGeneration !== authorityGeneration
    ) {
      throw changedAuthorityError()
    }
    if (operationFailure !== NO_OPERATION_FAILURE) throw operationFailure
    return result
  }

  #reconcile(): void {
    const runtime = this.#runtime
    if (!runtime || this.#closed) return
    const runtimeSnapshot = runtime.snapshot()
    const candidate = activeAuthorityFrom(runtime, runtimeSnapshot, this.#generation)
    if (candidate) {
      const current = this.#authority
      if (current?.authorityKey === candidate.authorityKey) {
        const snapshot = Object.freeze({
          ...candidate.snapshot,
          authorityGeneration: current.snapshot.authorityGeneration
        })
        if (samePublicSnapshot(current.snapshot, snapshot)) return
        this.#authority = Object.freeze({
          authorityKey: current.authorityKey,
          principalKey: current.principalKey,
          snapshot
        })
        this.#publish()
        return
      }
      this.#generation += 1
      this.#authority = Object.freeze({
        ...candidate,
        snapshot: Object.freeze({
          ...candidate.snapshot,
          authorityGeneration: this.#generation
        })
      })
      this.#publish()
      return
    }

    this.#invalidateAuthority()
  }

  #invalidateAuthority(): void {
    if (!this.#authority) return
    this.#generation += 1
    this.#authority = null
    this.#publish()
  }

  #publish(): void {
    const snapshot = this.current()
    for (const listener of this.#listeners) {
      try {
        listener(snapshot)
      } catch {
        // Trusted internal-service observers cannot interrupt an authority transition.
      }
    }
  }
}

function activeAuthorityFrom(
  runtime: IdentityCloudSessionRuntimePort,
  snapshot: CloudIdentitySnapshot,
  authorityGeneration: number
): ActiveAuthority | null {
  const cloudBaseUrl = runtime.cloudBaseUrl()
  if (
    !cloudBaseUrl ||
    snapshot.identity.state !== 'signed-in' ||
    snapshot.device.state !== 'active' ||
    snapshot.device.device.status !== 'active'
  ) {
    return null
  }
  const publicSnapshot = Object.freeze({
    cloudBaseUrl,
    userId: snapshot.identity.user.userId,
    deviceId: snapshot.device.device.deviceId,
    accessTokenExpiresAt: snapshot.identity.accessTokenExpiresAt,
    authorityGeneration
  })
  const currentPrincipalKey = principalKey(snapshot)
  return Object.freeze({
    principalKey: currentPrincipalKey,
    authorityKey: [
      cloudBaseUrl,
      currentPrincipalKey,
      publicSnapshot.deviceId
    ].join('\u0000'),
    snapshot: publicSnapshot
  })
}

function principalKey(snapshot: CloudIdentitySnapshot): string {
  if (snapshot.identity.state !== 'signed-in') return ''
  return [
    snapshot.identity.user.issuer,
    snapshot.identity.user.subject,
    snapshot.identity.user.userId
  ].join('\u0000')
}

function samePublicSnapshot(
  left: IdentityCloudSessionSnapshot,
  right: IdentityCloudSessionSnapshot
): boolean {
  return left.cloudBaseUrl === right.cloudBaseUrl &&
    left.userId === right.userId &&
    left.deviceId === right.deviceId &&
    left.accessTokenExpiresAt === right.accessTokenExpiresAt &&
    left.authorityGeneration === right.authorityGeneration
}

function unavailableAuthorityError(): Error {
  return new Error('An ACTIVE SciForge Cloud Desktop session is required.')
}

function changedAuthorityError(): Error {
  return new Error('SciForge Cloud authority changed during the operation.')
}
