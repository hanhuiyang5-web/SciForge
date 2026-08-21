export type ActiveCloudIdentitySession = Readonly<{
  cloudBaseUrl: string
  accessToken: string
  userId: string
  deviceId: string
}>

export type CloudIdentitySessionListener = (
  session: ActiveCloudIdentitySession | null
) => void

export class CloudIdentitySessionBroker {
  #current: ActiveCloudIdentitySession | null = null
  readonly #listeners = new Set<CloudIdentitySessionListener>()

  current(): ActiveCloudIdentitySession | null {
    return this.#current
  }

  publish(session: ActiveCloudIdentitySession): void {
    const next = Object.freeze(validateSession(session))
    if (sameSession(this.#current, next)) return
    this.#current = next
    this.#notify()
  }

  clear(): void {
    if (!this.#current) return
    this.#current = null
    this.#notify()
  }

  subscribe(listener: CloudIdentitySessionListener): () => void {
    this.#listeners.add(listener)
    listener(this.#current)
    return () => this.#listeners.delete(listener)
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#current)
  }
}

export const cloudIdentitySessionBroker = new CloudIdentitySessionBroker()

function validateSession(session: ActiveCloudIdentitySession): ActiveCloudIdentitySession {
  const baseUrl = new URL(session.cloudBaseUrl.trim())
  const loopbackHttp = baseUrl.protocol === 'http:' && (
    baseUrl.hostname === '127.0.0.1' || baseUrl.hostname === 'localhost' || baseUrl.hostname === '::1'
  )
  if ((baseUrl.protocol !== 'https:' && !loopbackHttp) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new TypeError('SciForge Cloud base URL must use HTTPS, except for loopback development.')
  }
  if (!session.accessToken || /\s/u.test(session.accessToken)) {
    throw new TypeError('OIDC access token is invalid.')
  }
  if (!/^usr_[A-Za-z0-9](?:[A-Za-z0-9_]{10,62}[A-Za-z0-9])$/u.test(session.userId)) {
    throw new TypeError('Cloud user ID is invalid.')
  }
  if (!/^dev_[A-Za-z0-9](?:[A-Za-z0-9_]{10,62}[A-Za-z0-9])$/u.test(session.deviceId)) {
    throw new TypeError('Cloud Device ID is invalid.')
  }
  return {
    cloudBaseUrl: baseUrl.toString().replace(/\/+$/u, ''),
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId
  }
}

function sameSession(
  left: ActiveCloudIdentitySession | null,
  right: ActiveCloudIdentitySession
): boolean {
  return left?.cloudBaseUrl === right.cloudBaseUrl &&
    left.accessToken === right.accessToken &&
    left.userId === right.userId &&
    left.deviceId === right.deviceId
}
