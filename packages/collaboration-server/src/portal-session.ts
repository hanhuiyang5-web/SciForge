import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual
} from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

import type { AuthenticationService, UserActor } from './auth.js'
import type { OidcAccessTokenVerifier } from './oidc.js'

const LOGIN_COOKIE = '__Host-sciforge-portal-login'
const SESSION_COOKIE = '__Host-sciforge-portal'
const LOGIN_TTL_MS = 5 * 60_000
const SESSION_IDLE_TTL_MS = 30 * 60_000
const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60_000
const REFRESH_BEFORE_EXPIRY_SECONDS = 60
const REQUEST_TIMEOUT_MS = 5_000
const MAX_OIDC_RESPONSE_BYTES = 128 * 1024
const MAX_TOKEN_BYTES = 16 * 1024
const MAX_LOGIN_TRANSACTIONS = 256
const MAX_SESSIONS = 1_024
const MAX_SESSIONS_PER_IDENTITY = 4
const LOGIN_RATE_CAPACITY = 60
const LOGIN_RATE_REFILL_PER_SECOND = 1
const PER_SOURCE_LOGIN_CAPACITY = 8
const PER_SOURCE_LOGIN_REFILL_PER_SECOND = 0.2
const MAX_LOGIN_RATE_SOURCES = 1_024
const PRUNE_INTERVAL_MS = 30_000
const MAX_PENDING_REFRESH_REVOCATIONS = 128
const MAX_CONCURRENT_REFRESH_REVOCATIONS = 2

type PortalDiscovery = Readonly<{
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint: string
}>

type LoginTransaction = {
  state: string
  nonce: string
  codeVerifier: string
  createdAt: number
  sourceDigest: string
}

type LoginRateState = { tokens: number; updatedAt: number; lastSeenAt: number }

type TokenSet = {
  accessToken: string
  refreshToken: string
  idToken?: string
  expiresIn: number
}

type PortalSession = {
  actor: UserActor
  accessToken: string
  refreshToken: string
  csrfToken: string
  csrfDigest: Buffer
  createdAt: number
  lastSeenAt: number
  absoluteExpiresAt: number
  refreshPromise?: Promise<UserActor>
}

type RefreshTokenRevocation = Readonly<{
  refreshToken: string
  refreshingSession?: PortalSession
  refreshPromise?: Promise<UserActor>
}>

type SessionAdmission = Readonly<{
  sessionId: string
  csrfToken: string
  evictedRefreshTokens: readonly RefreshTokenRevocation[]
}>

export type PortalSessionManagerOptions = Readonly<{
  issuer: string
  clientId: string
  clientSecret: string
  publicOrigin: string
  redirectUri: string
  authentication: AuthenticationService
  verifier: OidcAccessTokenVerifier
  fetch?: typeof globalThis.fetch
  now?: () => Date
  randomBytes?: (length: number) => Buffer
}>

export type PortalSessionContext = Readonly<{
  actor: UserActor
  csrfToken?: string
  absoluteExpiresAt: string
  idleExpiresAt: string
}>

export type PortalLoginStart = Readonly<{
  location: string
  setCookie: string
}>

export type PortalLoginComplete = Readonly<{
  actor: UserActor
  csrfToken: string
  setCookies: readonly string[]
}>

export class PortalSessionError extends Error {
  constructor(
    readonly code:
      | 'portal_configuration_invalid'
      | 'portal_authentication_required'
      | 'portal_login_rejected'
      | 'portal_csrf_rejected'
      | 'portal_rate_limited'
      | 'portal_oidc_unavailable',
    message: string,
    readonly status: number,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'PortalSessionError'
  }
}

export class PortalSessionManager {
  readonly publicOrigin: string
  readonly redirectUri: string
  readonly clientId: string

  private readonly issuer: string
  private readonly clientSecret: string
  private readonly authentication: AuthenticationService
  private readonly verifier: OidcAccessTokenVerifier
  private readonly fetchImplementation: typeof globalThis.fetch
  private readonly now: () => Date
  private readonly randomBytes: (length: number) => Buffer
  private readonly loginTransactions = new Map<string, LoginTransaction>()
  private readonly loginTransactionCounts = new Map<string, number>()
  private readonly loginRates = new Map<string, LoginRateState>()
  private readonly sessions = new Map<string, PortalSession>()
  private readonly refreshRevocationQueue: RefreshTokenRevocation[] = []
  private discovery?: { value: PortalDiscovery; expiresAt: number }
  private loginRateTokens = LOGIN_RATE_CAPACITY
  private loginRateUpdatedAt = 0
  private nextPruneAt = 0
  private activeRefreshRevocations = 0

  constructor(options: PortalSessionManagerOptions) {
    this.issuer = exactHttpsUrl(options.issuer, 'OIDC issuer')
    this.publicOrigin = exactOrigin(options.publicOrigin)
    this.clientId = boundedIdentifier(options.clientId)
    if (typeof options.clientSecret !== 'string' || options.clientSecret.length < 32 ||
        options.clientSecret.length > 4_096 || hasAsciiControl(options.clientSecret)) {
      throw configurationError()
    }
    this.clientSecret = options.clientSecret
    this.redirectUri = exactHttpsUrl(options.redirectUri, 'Portal redirect URI')
    if (this.redirectUri !== `${this.publicOrigin}/portal/auth/callback`) throw configurationError()
    this.authentication = options.authentication
    this.verifier = options.verifier
    this.fetchImplementation = options.fetch ?? globalThis.fetch
    if (typeof this.fetchImplementation !== 'function') throw configurationError()
    this.now = options.now ?? (() => new Date())
    this.randomBytes = options.randomBytes ?? nodeRandomBytes
  }

  async beginLogin(sourceKey = 'local'): Promise<PortalLoginStart> {
    this.pruneExpiredIfDue()
    const sourceDigest = digestSourceKey(sourceKey)
    this.consumeLoginCapacity(sourceDigest)
    if (this.loginTransactions.size >= MAX_LOGIN_TRANSACTIONS) {
      this.pruneExpired(true)
      if (this.loginTransactions.size >= MAX_LOGIN_TRANSACTIONS) throw rateLimited()
    }
    if ((this.loginTransactionCounts.get(sourceDigest) ?? 0) >= PER_SOURCE_LOGIN_CAPACITY) throw rateLimited()
    const discovery = await this.loadDiscovery()
    const transactionId = this.randomValue(32)
    const state = this.randomValue(32)
    const nonce = this.randomValue(32)
    const codeVerifier = this.randomValue(64)
    const createdAt = this.nowMilliseconds()
    this.loginTransactions.set(digestKey(transactionId), { state, nonce, codeVerifier, createdAt, sourceDigest })
    this.loginTransactionCounts.set(sourceDigest, (this.loginTransactionCounts.get(sourceDigest) ?? 0) + 1)

    const authorization = new URL(discovery.authorizationEndpoint)
    authorization.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: 'openid profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(codeVerifier, 'ascii').digest('base64url'),
      code_challenge_method: 'S256'
    }).toString()
    return {
      location: authorization.toString(),
      setCookie: serializeCookie(LOGIN_COOKIE, transactionId, {
        maxAgeSeconds: Math.floor(LOGIN_TTL_MS / 1_000),
        sameSite: 'Lax'
      })
    }
  }

  async completeLogin(query: URLSearchParams, cookieHeader: string | undefined): Promise<PortalLoginComplete> {
    this.pruneExpiredIfDue()
    const cookies = parseCookies(cookieHeader)
    const transactionId = singleCookie(cookies, LOGIN_COOKIE)
    const transactionKey = transactionId ? digestKey(transactionId) : undefined
    const transaction = transactionKey ? this.loginTransactions.get(transactionKey) : undefined
    if (!transactionKey || !transaction || this.nowMilliseconds() - transaction.createdAt > LOGIN_TTL_MS) {
      if (transactionKey) this.deleteLoginTransaction(transactionKey)
      throw loginRejected()
    }
    this.deleteLoginTransaction(transactionKey)

    const allowedQueryKeys = new Set(['code', 'state', 'session_state', 'iss'])
    if ([...query.keys()].some((key) => !allowedQueryKeys.has(key)) || query.has('error')) throw loginRejected()
    const code = singleQueryValue(query, 'code', 2_048)
    const state = singleQueryValue(query, 'state', 256)
    const responseIssuer = query.has('iss') ? singleQueryValue(query, 'iss', 2_048) : undefined
    if (!safeEqual(state, transaction.state) || (responseIssuer !== undefined && responseIssuer !== this.issuer)) {
      throw loginRejected()
    }

    const discovery = await this.loadDiscovery()
    const tokenSet = await this.tokenRequest(discovery.tokenEndpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: transaction.codeVerifier
    }, true)
    if (!tokenSet.idToken) throw loginRejected()
    const [idToken, actor] = await Promise.all([
      this.verifier.verifyIdToken(tokenSet.idToken, { clientId: this.clientId, nonce: transaction.nonce }),
      this.authentication.resolveBearer(tokenSet.accessToken)
    ]).catch(() => { throw loginRejected() })
    if (actor.kind !== 'user' || actor.subject !== idToken.subject || actor.issuer !== idToken.issuer) throw loginRejected()

    const admission = this.admitSession(actor, tokenSet)
    if (!admission) {
      this.queueRefreshTokenRevocations([{ refreshToken: tokenSet.refreshToken }])
      throw rateLimited()
    }
    this.queueRefreshTokenRevocations(admission.evictedRefreshTokens)
    return {
      actor,
      csrfToken: admission.csrfToken,
      setCookies: [
        clearCookie(LOGIN_COOKIE, 'Lax'),
        serializeCookie(SESSION_COOKIE, admission.sessionId, {
          maxAgeSeconds: Math.floor(SESSION_ABSOLUTE_TTL_MS / 1_000),
          sameSite: 'Strict'
        })
      ]
    }
  }

  async authenticate(cookieHeader: string | undefined): Promise<PortalSessionContext> {
    return this.authenticateCookie(cookieHeader, true)
  }

  /**
   * Revalidates a cookie-backed session without treating server-driven polling or
   * reconciliation as browser activity. Passive callers can refresh the OIDC
   * access token and re-check the principal, but they never extend the local
   * 30-minute idle deadline.
   */
  async authenticatePassive(cookieHeader: string | undefined): Promise<PortalSessionContext> {
    return this.authenticateCookie(cookieHeader, false)
  }

  private async authenticateCookie(
    cookieHeader: string | undefined,
    touchIdleDeadline: boolean
  ): Promise<PortalSessionContext> {
    const cookies = parseCookies(cookieHeader)
    const sessionId = singleCookie(cookies, SESSION_COOKIE)
    const key = sessionId ? digestKey(sessionId) : undefined
    const session = key ? this.sessions.get(key) : undefined
    if (!key || !session || this.isSessionExpired(session)) {
      if (key) this.sessions.delete(key)
      throw authenticationRequired()
    }
    const actor = await this.currentActor(session).catch(() => {
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      throw authenticationRequired()
    })
    const current = this.nowMilliseconds()
    if (this.sessions.get(key) !== session || this.isSessionExpired(session, current)) {
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      throw authenticationRequired()
    }
    if (touchIdleDeadline) session.lastSeenAt = current
    return {
      actor,
      csrfToken: session.csrfToken,
      absoluteExpiresAt: new Date(session.absoluteExpiresAt).toISOString(),
      idleExpiresAt: new Date(Math.min(session.lastSeenAt + SESSION_IDLE_TTL_MS, session.absoluteExpiresAt)).toISOString()
    }
  }

  async authenticateWrite(headers: IncomingHttpHeaders): Promise<PortalSessionContext> {
    assertWriteRequestMetadata(headers, this.publicOrigin)
    const cookies = parseCookies(firstHeader(headers.cookie))
    const sessionId = singleCookie(cookies, SESSION_COOKIE)
    const key = sessionId ? digestKey(sessionId) : undefined
    const session = key ? this.sessions.get(key) : undefined
    if (!key || !session || this.isSessionExpired(session)) {
      if (key) this.sessions.delete(key)
      throw authenticationRequired()
    }
    const csrf = firstHeader(headers['x-sciforge-csrf'])
    if (!csrf || !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        !timingSafeEqual(session.csrfDigest, createHash('sha256').update(csrf, 'ascii').digest())) {
      throw new PortalSessionError('portal_csrf_rejected', 'The Portal request could not be verified.', 403)
    }
    const actor = await this.currentActor(session).catch(() => {
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      throw authenticationRequired()
    })
    const current = this.nowMilliseconds()
    if (this.sessions.get(key) !== session || this.isSessionExpired(session, current)) {
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      throw authenticationRequired()
    }
    session.lastSeenAt = current
    return {
      actor,
      absoluteExpiresAt: new Date(session.absoluteExpiresAt).toISOString(),
      idleExpiresAt: new Date(Math.min(session.lastSeenAt + SESSION_IDLE_TTL_MS, session.absoluteExpiresAt)).toISOString()
    }
  }

  sessionCsrf(cookieHeader: string | undefined, suppliedToken: string): void {
    const cookies = parseCookies(cookieHeader)
    const sessionId = singleCookie(cookies, SESSION_COOKIE)
    const session = sessionId ? this.sessions.get(digestKey(sessionId)) : undefined
    if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(suppliedToken) ||
        !timingSafeEqual(session.csrfDigest, createHash('sha256').update(suppliedToken, 'ascii').digest())) {
      throw new PortalSessionError('portal_csrf_rejected', 'The Portal request could not be verified.', 403)
    }
  }

  async logout(headers: IncomingHttpHeaders): Promise<readonly string[]> {
    assertWriteRequestMetadata(headers, this.publicOrigin)
    const cookies = parseCookies(firstHeader(headers.cookie))
    const sessionId = singleCookie(cookies, SESSION_COOKIE)
    const key = sessionId ? digestKey(sessionId) : undefined
    const session = key ? this.sessions.get(key) : undefined
    if (key && session) {
      const csrf = firstHeader(headers['x-sciforge-csrf'])
      if (!csrf || !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          !timingSafeEqual(session.csrfDigest, createHash('sha256').update(csrf, 'ascii').digest())) {
        throw new PortalSessionError('portal_csrf_rejected', 'The Portal request could not be verified.', 403)
      }
      this.sessions.delete(key)
      await session.refreshPromise?.catch(() => undefined)
      await this.revokeRefreshToken(session.refreshToken).catch(() => undefined)
    }
    return [clearCookie(SESSION_COOKIE, 'Strict'), clearCookie(LOGIN_COOKIE, 'Lax')]
  }

  close(): void {
    this.loginTransactions.clear()
    this.loginTransactionCounts.clear()
    this.loginRates.clear()
    this.sessions.clear()
    this.refreshRevocationQueue.length = 0
    this.discovery = undefined
    this.loginRateTokens = LOGIN_RATE_CAPACITY
    this.loginRateUpdatedAt = 0
    this.nextPruneAt = 0
  }

  private async currentActor(session: PortalSession): Promise<UserActor> {
    if (session.refreshPromise) return session.refreshPromise
    const nowSeconds = Math.floor(this.nowMilliseconds() / 1_000)
    if (session.actor.expiresAt !== undefined && session.actor.expiresAt - nowSeconds <= REFRESH_BEFORE_EXPIRY_SECONDS) {
      const promise = this.refreshSession(session)
      session.refreshPromise = promise
      void promise.finally(() => {
        if (session.refreshPromise === promise) delete session.refreshPromise
      }).catch(() => undefined)
      return promise
    }
    await this.authentication.assertCurrent(session.actor)
    return session.actor
  }

  private async refreshSession(session: PortalSession): Promise<UserActor> {
    const previous = session.actor
    const discovery = await this.loadDiscovery()
    const refreshed = await this.tokenRequest(discovery.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken
    }, false, session.refreshToken)
    const actor = await this.authentication.resolveBearer(refreshed.accessToken)
    if (actor.kind !== 'user' || actor.userId !== previous.userId ||
        actor.identityId !== previous.identityId || actor.issuer !== previous.issuer ||
        actor.subject !== previous.subject) {
      throw authenticationRequired()
    }
    session.actor = actor
    session.accessToken = refreshed.accessToken
    session.refreshToken = refreshed.refreshToken
    return actor
  }

  private async tokenRequest(
    endpoint: string,
    values: Record<string, string>,
    requireIdToken: boolean,
    existingRefreshToken?: string
  ): Promise<TokenSet> {
    const body = new URLSearchParams(values).toString()
    const value = await this.boundedJsonRequest(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`, 'utf8').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body,
      redirect: 'error',
      cache: 'no-store'
    }, requireIdToken ? loginRejected : authenticationRequired)
    if (!isRecord(value) || value.token_type !== 'Bearer' ||
        typeof value.access_token !== 'string' || !boundedToken(value.access_token) ||
        !((typeof value.refresh_token === 'string' && boundedToken(value.refresh_token)) ||
          (existingRefreshToken !== undefined && boundedToken(existingRefreshToken))) ||
        !Number.isSafeInteger(value.expires_in) || Number(value.expires_in) < 30 || Number(value.expires_in) > 86_400 ||
        (requireIdToken && (typeof value.id_token !== 'string' || !boundedToken(value.id_token)))) {
      throw requireIdToken ? loginRejected() : authenticationRequired()
    }
    return {
      accessToken: value.access_token,
      refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : String(existingRefreshToken),
      ...(typeof value.id_token === 'string' && boundedToken(value.id_token) ? { idToken: value.id_token } : {}),
      expiresIn: Number(value.expires_in)
    }
  }

  private async revokeRefreshToken(refreshToken: string): Promise<void> {
    const discovery = await this.loadDiscovery()
    const body = new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token' }).toString()
    const response = await this.boundedFetch(discovery.revocationEndpoint, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`, 'utf8').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body,
      redirect: 'error',
      cache: 'no-store'
    })
    if (response.status !== 200 && response.status !== 204) throw oidcUnavailable()
    await response.body?.cancel().catch(() => undefined)
  }

  private async loadDiscovery(): Promise<PortalDiscovery> {
    const current = this.nowMilliseconds()
    if (this.discovery && this.discovery.expiresAt > current) return this.discovery.value
    const discoveryUrl = `${this.issuer}${this.issuer.endsWith('/') ? '' : '/'}.well-known/openid-configuration`
    const raw = await this.boundedJsonRequest(discoveryUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store'
    })
    if (!isRecord(raw) || raw.issuer !== this.issuer ||
        typeof raw.authorization_endpoint !== 'string' || typeof raw.token_endpoint !== 'string' ||
        typeof raw.revocation_endpoint !== 'string' ||
        !Array.isArray(raw.code_challenge_methods_supported) ||
        !raw.code_challenge_methods_supported.includes('S256')) {
      throw oidcUnavailable()
    }
    const value: PortalDiscovery = Object.freeze({
      issuer: this.issuer,
      authorizationEndpoint: sameProviderUrl(raw.authorization_endpoint, this.issuer),
      tokenEndpoint: sameProviderUrl(raw.token_endpoint, this.issuer),
      revocationEndpoint: sameProviderUrl(raw.revocation_endpoint, this.issuer)
    })
    this.discovery = { value, expiresAt: current + 5 * 60_000 }
    return value
  }

  private async boundedFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await this.fetchImplementation(url, { ...init, signal: controller.signal })
    } catch {
      throw oidcUnavailable()
    } finally {
      clearTimeout(timer)
    }
  }

  private async boundedJsonRequest(
    url: string,
    init: RequestInit,
    nonSuccessError: () => PortalSessionError = oidcUnavailable
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetchImplementation(url, { ...init, signal: controller.signal })
      if (response.status !== 200) throw response.status >= 500 ? oidcUnavailable() : nonSuccessError()
      return await boundedJson(response)
    } catch (error) {
      if (error instanceof PortalSessionError) throw error
      throw oidcUnavailable()
    } finally {
      clearTimeout(timer)
    }
  }

  private pruneExpiredIfDue(): void {
    if (this.nowMilliseconds() >= this.nextPruneAt) this.pruneExpired(false)
  }

  private pruneExpired(force: boolean): void {
    const current = this.nowMilliseconds()
    if (!force && current < this.nextPruneAt) return
    this.nextPruneAt = current + PRUNE_INTERVAL_MS
    for (const [key, value] of this.loginTransactions) {
      if (current - value.createdAt > LOGIN_TTL_MS) this.deleteLoginTransaction(key)
    }
    for (const [key, value] of this.sessions) {
      if (this.isSessionExpired(value)) this.sessions.delete(key)
    }
    for (const [key, value] of this.loginRates) {
      if (current - value.lastSeenAt > LOGIN_TTL_MS * 2) this.loginRates.delete(key)
    }
  }

  private consumeLoginCapacity(sourceDigest: string): void {
    const current = this.nowMilliseconds()
    if (this.loginRateUpdatedAt === 0) this.loginRateUpdatedAt = current
    const elapsedSeconds = Math.max(0, (current - this.loginRateUpdatedAt) / 1_000)
    this.loginRateTokens = Math.min(
      LOGIN_RATE_CAPACITY,
      this.loginRateTokens + elapsedSeconds * LOGIN_RATE_REFILL_PER_SECOND
    )
    this.loginRateUpdatedAt = current
    if (this.loginRateTokens < 1) throw rateLimited()
    let source = this.loginRates.get(sourceDigest)
    if (!source) {
      if (this.loginRates.size >= MAX_LOGIN_RATE_SOURCES) throw rateLimited()
      source = { tokens: PER_SOURCE_LOGIN_CAPACITY, updatedAt: current, lastSeenAt: current }
      this.loginRates.set(sourceDigest, source)
    }
    const sourceElapsedSeconds = Math.max(0, (current - source.updatedAt) / 1_000)
    source.tokens = Math.min(
      PER_SOURCE_LOGIN_CAPACITY,
      source.tokens + sourceElapsedSeconds * PER_SOURCE_LOGIN_REFILL_PER_SECOND
    )
    source.updatedAt = current
    source.lastSeenAt = current
    if (source.tokens < 1) throw rateLimited()
    this.loginRateTokens -= 1
    source.tokens -= 1
  }

  private deleteLoginTransaction(key: string): void {
    const transaction = this.loginTransactions.get(key)
    if (!transaction) return
    this.loginTransactions.delete(key)
    const remaining = (this.loginTransactionCounts.get(transaction.sourceDigest) ?? 1) - 1
    if (remaining <= 0) this.loginTransactionCounts.delete(transaction.sourceDigest)
    else this.loginTransactionCounts.set(transaction.sourceDigest, remaining)
  }

  /**
   * This method intentionally contains no await. JavaScript run-to-completion makes
   * same-identity eviction, global-cap admission, and insertion one atomic step with
   * respect to concurrent OIDC callbacks.
   */
  private admitSession(actor: UserActor, tokenSet: TokenSet): SessionAdmission | undefined {
    this.pruneExpired(true)
    const matching = [...this.sessions.entries()]
      .filter(([, session]) => session.actor.identityId === actor.identityId && session.actor.userId === actor.userId)
      .sort((left, right) => left[1].createdAt - right[1].createdAt)
    const removeCount = Math.max(0, matching.length - MAX_SESSIONS_PER_IDENTITY + 1)
    const evictedRefreshTokens: RefreshTokenRevocation[] = []
    for (const [key, session] of matching.slice(0, removeCount)) {
      this.sessions.delete(key)
      evictedRefreshTokens.push({
        refreshToken: session.refreshToken,
        ...(session.refreshPromise
          ? { refreshingSession: session, refreshPromise: session.refreshPromise }
          : {})
      })
    }
    if (this.sessions.size >= MAX_SESSIONS) return undefined

    const sessionId = this.randomValue(32)
    const csrfToken = this.randomValue(32)
    const createdAt = this.nowMilliseconds()
    this.sessions.set(digestKey(sessionId), {
      actor,
      accessToken: tokenSet.accessToken,
      refreshToken: tokenSet.refreshToken,
      csrfToken,
      csrfDigest: createHash('sha256').update(csrfToken, 'ascii').digest(),
      createdAt,
      lastSeenAt: createdAt,
      absoluteExpiresAt: createdAt + SESSION_ABSOLUTE_TTL_MS
    })
    return { sessionId, csrfToken, evictedRefreshTokens }
  }

  private queueRefreshTokenRevocations(refreshTokens: readonly RefreshTokenRevocation[]): void {
    for (const refreshToken of refreshTokens) {
      if (this.activeRefreshRevocations + this.refreshRevocationQueue.length >= MAX_PENDING_REFRESH_REVOCATIONS) break
      this.refreshRevocationQueue.push(refreshToken)
    }
    this.drainRefreshTokenRevocations()
  }

  private drainRefreshTokenRevocations(): void {
    while (this.activeRefreshRevocations < MAX_CONCURRENT_REFRESH_REVOCATIONS) {
      const revocation = this.refreshRevocationQueue.shift()
      if (!revocation) return
      this.activeRefreshRevocations += 1
      void this.revokeQueuedRefreshToken(revocation)
        .catch(() => undefined)
        .finally(() => {
          this.activeRefreshRevocations -= 1
          this.drainRefreshTokenRevocations()
        })
    }
  }

  private async revokeQueuedRefreshToken(revocation: RefreshTokenRevocation): Promise<void> {
    await revocation.refreshPromise?.catch(() => undefined)
    await this.revokeRefreshToken(revocation.refreshingSession?.refreshToken ?? revocation.refreshToken)
  }

  private isSessionExpired(session: PortalSession, current = this.nowMilliseconds()): boolean {
    return current >= session.absoluteExpiresAt || current - session.lastSeenAt >= SESSION_IDLE_TTL_MS
  }

  private randomValue(bytes: number): string {
    const value = this.randomBytes(bytes)
    if (!Buffer.isBuffer(value) || value.byteLength !== bytes) throw configurationError()
    return value.toString('base64url')
  }

  private nowMilliseconds(): number {
    const value = this.now().getTime()
    if (!Number.isFinite(value)) throw configurationError()
    return value
  }
}

export function portalSessionCookieNames(): Readonly<{ login: string; session: string }> {
  return Object.freeze({ login: LOGIN_COOKIE, session: SESSION_COOKIE })
}

export function assertWriteRequestMetadata(headers: IncomingHttpHeaders, publicOrigin: string): void {
  if (firstHeader(headers.origin) !== publicOrigin || firstHeader(headers['sec-fetch-site']) !== 'same-origin' ||
      firstHeader(headers['sec-fetch-mode']) !== 'cors' ||
      (headers['sec-fetch-dest'] !== undefined && firstHeader(headers['sec-fetch-dest']) !== 'empty')) {
    throw new PortalSessionError('portal_csrf_rejected', 'The Portal request origin could not be verified.', 403)
  }
}

function boundedToken(value: string): boolean {
  return value.length >= 16 && Buffer.byteLength(value, 'utf8') <= MAX_TOKEN_BYTES && !/\s/u.test(value)
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/json')) throw oidcUnavailable()
  const lengthHeader = response.headers.get('content-length')
  if (lengthHeader && (!/^\d{1,10}$/u.test(lengthHeader) || Number(lengthHeader) > MAX_OIDC_RESPONSE_BYTES)) {
    throw oidcUnavailable()
  }
  if (!response.body) throw oidcUnavailable()
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      length += chunk.byteLength
      if (length > MAX_OIDC_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw oidcUnavailable()
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)))
  } catch {
    throw oidcUnavailable()
  }
}

function exactOrigin(value: string): string {
  if (typeof value !== 'string' || value.length > 2_048 || value !== value.trim()) throw configurationError()
  let url: URL
  try { url = new URL(value) } catch { throw configurationError() }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.origin !== value || url.pathname !== '/') throw configurationError()
  return url.origin
}

function exactHttpsUrl(value: string, _label: string): string {
  if (typeof value !== 'string' || value.length > 2_048 || value !== value.trim()) throw configurationError()
  let url: URL
  try { url = new URL(value) } catch { throw configurationError() }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.toString() !== value) {
    throw configurationError()
  }
  return value
}

function sameProviderUrl(value: string, issuer: string): string {
  const verified = exactHttpsUrl(value, 'OIDC endpoint')
  const url = new URL(verified)
  if (url.origin !== new URL(issuer).origin) throw oidcUnavailable()
  return verified
}

function boundedIdentifier(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value)) throw configurationError()
  return value
}

function parseCookies(header: string | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>()
  if (!header) return result
  if (header.length > 8_192 || header.includes('\r') || header.includes('\n') || header.includes('\0')) {
    throw authenticationRequired()
  }
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=')
    if (index < 1) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || !/^[A-Za-z0-9_-]{1,256}$/u.test(value)) continue
    result.set(name, [...result.get(name) ?? [], value])
  }
  return result
}

function singleCookie(cookies: Map<string, string[]>, name: string): string | undefined {
  const values = cookies.get(name)
  if (!values) return undefined
  if (values.length !== 1) throw authenticationRequired()
  return values[0]
}

function singleQueryValue(query: URLSearchParams, name: string, maximumLength: number): string {
  const values = query.getAll(name)
  const value = values[0]
  if (values.length !== 1 || !value || value.length > maximumLength || hasAsciiControl(value)) {
    throw loginRejected()
  }
  return value
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; sameSite: 'Strict' | 'Lax' }
): string {
  return `${name}=${value}; Path=/; Max-Age=${options.maxAgeSeconds}; Secure; HttpOnly; SameSite=${options.sameSite}`
}

function clearCookie(name: string, sameSite: 'Strict' | 'Lax'): string {
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=${sameSite}`
}

function digestKey(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('hex')
}

function digestSourceKey(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || hasAsciiControl(value)) {
    throw rateLimited()
  }
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest()
  const rightDigest = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configurationError(): PortalSessionError {
  return new PortalSessionError('portal_configuration_invalid', 'The Portal session configuration is invalid.', 500)
}

function authenticationRequired(): PortalSessionError {
  return new PortalSessionError('portal_authentication_required', 'Portal authentication is required.', 401)
}

function loginRejected(): PortalSessionError {
  return new PortalSessionError('portal_login_rejected', 'The Portal login response could not be verified.', 401)
}

function rateLimited(): PortalSessionError {
  return new PortalSessionError('portal_rate_limited', 'The Portal login capacity is temporarily exhausted.', 429, true)
}

function oidcUnavailable(): PortalSessionError {
  return new PortalSessionError('portal_oidc_unavailable', 'The Portal identity provider is unavailable.', 503, true)
}
