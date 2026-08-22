import { describe, expect, it, vi } from 'vitest'

import type { AuthenticationService, UserActor } from './auth.js'
import type { OidcAccessTokenVerifier } from './oidc.js'
import {
  PortalSessionError,
  PortalSessionManager
} from './portal-session.js'

const ORIGIN = 'https://cloud-test.sciforge.cn'
const ISSUER = 'https://login-test.sciforge.cn/realms/SciForge'
const REDIRECT = `${ORIGIN}/portal/auth/callback`
const NOW = new Date('2026-08-22T12:00:00.000Z')

type Fixture = ReturnType<typeof fixture>

type FixtureOptions = Readonly<{
  tokenStatus?: number
  authorizationCodeBarrierCount?: number
}>

function fixture(options: FixtureOptions = {}) {
  let current = NOW.getTime()
  let randomCall = 0
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
  const actor: UserActor = {
    kind: 'user',
    actorKey: 'oidc:identity-test',
    userId: 'usr_portalOwner0001',
    identityId: 'oid_portalIdentity01',
    issuer: ISSUER,
    subject: 'portal-subject',
    authTime: Math.floor(current / 1_000),
    expiresAt: Math.floor(current / 1_000) + 300,
    assurance: 'verified'
  }
  let authorizationCodeBarrierArrivals = 0
  let releaseAuthorizationCodeBarrier: (() => void) | undefined
  const authorizationCodeBarrier = options.authorizationCodeBarrierCount === undefined
    ? undefined
    : new Promise<void>((resolve) => { releaseAuthorizationCodeBarrier = resolve })
  const authentication = {
    resolveBearer: vi.fn(async (token: string | undefined) => {
      if (token !== 'access-token-value-000000000000000000000000' &&
          token !== 'refreshed-access-token-value-000000000000') throw new Error('bad token')
      return token.startsWith('refreshed')
        ? { ...actor, expiresAt: Math.floor(current / 1_000) + 300 }
        : { ...actor }
    }),
    assertCurrent: vi.fn(async () => undefined)
  } as unknown as AuthenticationService
  const verifier = {
    verifyIdToken: vi.fn(async (_token: string, input: { clientId: string; nonce: string }) => ({
      issuer: ISSUER,
      subject: actor.subject,
      audience: [input.clientId],
      issuedAt: Math.floor(current / 1_000),
      notBefore: Math.floor(current / 1_000),
      expiresAt: Math.floor(current / 1_000) + 300,
      authTime: Math.floor(current / 1_000),
      nonce: input.nonce
    }))
  } as unknown as OidcAccessTokenVerifier
  const fetchImplementation: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input)
    fetchCalls.push({ url, init })
    if (url.endsWith('/.well-known/openid-configuration')) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        revocation_endpoint: `${ISSUER}/protocol/openid-connect/revoke`,
        code_challenge_methods_supported: ['S256']
      })
    }
    if (url.endsWith('/token')) {
      if (options.tokenStatus !== undefined) {
        return json({ error: 'invalid_grant', error_description: 'private-marker-must-not-leak' }, options.tokenStatus)
      }
      const params = new URLSearchParams(String(init?.body ?? ''))
      if (params.get('grant_type') === 'refresh_token') {
        return json({
          token_type: 'Bearer',
          access_token: 'refreshed-access-token-value-000000000000',
          refresh_token: 'refreshed-refresh-token-value-000000000000',
          expires_in: 300
        })
      }
      if (authorizationCodeBarrier && options.authorizationCodeBarrierCount !== undefined) {
        authorizationCodeBarrierArrivals += 1
        if (authorizationCodeBarrierArrivals >= options.authorizationCodeBarrierCount) {
          releaseAuthorizationCodeBarrier?.()
        }
        await authorizationCodeBarrier
      }
      return json({
        token_type: 'Bearer',
        access_token: 'access-token-value-000000000000000000000000',
        refresh_token: 'refresh-token-value-0000000000000000000000',
        id_token: 'id-token-value-000000000000000000000000000',
        expires_in: 300
      })
    }
    if (url.endsWith('/revoke')) return new Response(null, { status: 204 })
    return new Response(null, { status: 404 })
  })
  const manager = new PortalSessionManager({
    issuer: ISSUER,
    clientId: 'sciforge-cloud-console',
    clientSecret: 's'.repeat(64),
    publicOrigin: ORIGIN,
    redirectUri: REDIRECT,
    authentication,
    verifier,
    fetch: fetchImplementation,
    now: () => new Date(current),
    randomBytes: (length) => {
      randomCall += 1
      return Buffer.alloc(length, randomCall)
    }
  })
  return {
    manager,
    actor,
    authentication,
    verifier,
    fetchCalls,
    setActor(next: UserActor) { Object.assign(actor, next) },
    advance(ms: number) { current += ms }
  }
}

describe('Portal OIDC BFF session manager', () => {
  it('performs confidential code plus PKCE login and keeps identity tokens out of browser state', async () => {
    const test = fixture()
    const login = await test.manager.beginLogin()
    const location = new URL(login.location)
    expect(location.origin).toBe('https://login-test.sciforge.cn')
    expect(location.searchParams.get('client_id')).toBe('sciforge-cloud-console')
    expect(location.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(login.setCookie).toMatch(/^__Host-sciforge-portal-login=/u)
    expect(login.setCookie).toContain('Secure; HttpOnly; SameSite=Lax')

    const callback = await complete(test, login)
    expect(callback.actor).toMatchObject({ userId: test.actor.userId, subject: test.actor.subject })
    expect(callback.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(callback.setCookies.join('\n')).toContain('__Host-sciforge-portal=')
    expect(callback.setCookies.join('\n')).toContain('Secure; HttpOnly; SameSite=Strict')
    expect(callback.setCookies.join('\n')).not.toMatch(/access-token|refresh-token|id-token|portal-subject/u)

    const tokenCall = test.fetchCalls.find((call) => call.url.endsWith('/token'))
    expect(tokenCall?.init?.headers).toMatchObject({
      'content-type': 'application/x-www-form-urlencoded'
    })
    const tokenParams = new URLSearchParams(String(tokenCall?.init?.body))
    expect(tokenParams.get('grant_type')).toBe('authorization_code')
    expect(tokenParams.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{86}$/u)
    expect(tokenParams.get('code_verifier')).not.toBe(location.searchParams.get('code_challenge'))
    expect(test.verifier.verifyIdToken).toHaveBeenCalledWith(expect.any(String), {
      clientId: 'sciforge-cloud-console',
      nonce: location.searchParams.get('nonce')
    })
  })

  it('returns a session-bound CSRF token and rejects wrong Origin or Fetch Metadata', async () => {
    const test = fixture()
    const login = await test.manager.beginLogin()
    const callback = await complete(test, login)
    const sessionCookie = cookiePair(callback.setCookies.find((value) => value.startsWith('__Host-sciforge-portal='))!)
    const context = await test.manager.authenticate(sessionCookie)
    expect(context.actor.userId).toBe(test.actor.userId)
    expect(context.csrfToken).toBe(callback.csrfToken)

    await expect(test.manager.authenticateWrite(writeHeaders(sessionCookie, callback.csrfToken))).resolves.toMatchObject({
      actor: { userId: test.actor.userId }
    })
    await expect(test.manager.authenticateWrite({
      ...writeHeaders(sessionCookie, callback.csrfToken),
      origin: 'https://attacker.invalid'
    })).rejects.toMatchObject({ code: 'portal_csrf_rejected', status: 403 })
    await expect(test.manager.authenticateWrite({
      ...writeHeaders(sessionCookie, callback.csrfToken),
      'sec-fetch-site': 'cross-site'
    })).rejects.toMatchObject({ code: 'portal_csrf_rejected', status: 403 })
    await expect(test.manager.authenticateWrite(writeHeaders(sessionCookie, 'A'.repeat(43)))).rejects.toMatchObject({
      code: 'portal_csrf_rejected', status: 403
    })
  })

  it('rejects callback replay, mismatched state, duplicate cookies, and unrecognized query fields', async () => {
    const test = fixture()
    const login = await test.manager.beginLogin()
    const location = new URL(login.location)
    const query = new URLSearchParams({ code: 'authorization-code', state: 'wrong-state' })
    await expect(test.manager.completeLogin(query, cookiePair(login.setCookie))).rejects.toMatchObject({
      code: 'portal_login_rejected'
    })
    await expect(test.manager.completeLogin(new URLSearchParams({
      code: 'authorization-code',
      state: location.searchParams.get('state')!
    }), cookiePair(login.setCookie))).rejects.toMatchObject({ code: 'portal_login_rejected' })

    const second = await test.manager.beginLogin()
    const secondLocation = new URL(second.location)
    await expect(test.manager.completeLogin(new URLSearchParams({
      code: 'authorization-code',
      state: secondLocation.searchParams.get('state')!,
      unexpected: 'value'
    }), cookiePair(second.setCookie))).rejects.toMatchObject({ code: 'portal_login_rejected' })

    const third = await test.manager.beginLogin()
    const thirdLocation = new URL(third.location)
    const pair = cookiePair(third.setCookie)
    await expect(test.manager.completeLogin(new URLSearchParams({
      code: 'authorization-code',
      state: thirdLocation.searchParams.get('state')!
    }), `${pair}; ${pair}`)).rejects.toMatchObject({ code: 'portal_authentication_required' })
  })

  it('enforces 30-minute idle and 8-hour absolute in-memory expiry', async () => {
    const idle = fixture()
    const idleLogin = await idle.manager.beginLogin()
    const idleComplete = await complete(idle, idleLogin)
    const idleCookie = cookiePair(idleComplete.setCookies.find((value) => value.startsWith('__Host-sciforge-portal='))!)
    idle.advance(30 * 60_000)
    await expect(idle.manager.authenticate(idleCookie)).rejects.toMatchObject({
      code: 'portal_authentication_required'
    })

    const absolute = fixture()
    const absoluteLogin = await absolute.manager.beginLogin()
    const absoluteComplete = await complete(absolute, absoluteLogin)
    const absoluteCookie = cookiePair(absoluteComplete.setCookies.find((value) => value.startsWith('__Host-sciforge-portal='))!)
    for (let elapsed = 20; elapsed < 8 * 60; elapsed += 20) {
      absolute.advance(20 * 60_000)
      await absolute.manager.authenticate(absoluteCookie)
    }
    absolute.advance(20 * 60_000)
    await expect(absolute.manager.authenticate(absoluteCookie)).rejects.toMatchObject({
      code: 'portal_authentication_required'
    })
  })

  it('does not let passive reconciliation extend idle while explicit session and write activity do', async () => {
    const passive = fixture()
    const passiveComplete = await complete(passive, await passive.manager.beginLogin())
    const passiveCookie = cookiePair(
      passiveComplete.setCookies.find((value) => value.startsWith('__Host-sciforge-portal='))!
    )
    passive.advance(20 * 60_000)
    await expect(passive.manager.authenticatePassive(passiveCookie)).resolves.toMatchObject({
      idleExpiresAt: '2026-08-22T12:30:00.000Z'
    })
    passive.advance(10 * 60_000)
    await expect(passive.manager.authenticatePassive(passiveCookie)).rejects.toMatchObject({
      code: 'portal_authentication_required'
    })

    const explicitSession = fixture()
    const explicitComplete = await complete(explicitSession, await explicitSession.manager.beginLogin())
    const explicitCookie = cookiePair(
      explicitComplete.setCookies.find((value) => value.startsWith('__Host-sciforge-portal='))!
    )
    explicitSession.advance(20 * 60_000)
    await expect(explicitSession.manager.authenticate(explicitCookie)).resolves.toMatchObject({
      idleExpiresAt: '2026-08-22T12:50:00.000Z'
    })
    explicitSession.advance(29 * 60_000)
    await expect(explicitSession.manager.authenticatePassive(explicitCookie)).resolves.toMatchObject({
      idleExpiresAt: '2026-08-22T12:50:00.000Z'
    })
    explicitSession.advance(60_000)
    await expect(explicitSession.manager.authenticatePassive(explicitCookie)).rejects.toMatchObject({
      code: 'portal_authentication_required'
    })

    const explicitWrite = fixture()
    const writeComplete = await complete(explicitWrite, await explicitWrite.manager.beginLogin())
    const writeCookie = cookiePair(
      writeComplete.setCookies.find((value) => value.startsWith('__Host-sciforge-portal='))!
    )
    explicitWrite.advance(20 * 60_000)
    await expect(explicitWrite.manager.authenticateWrite(
      writeHeaders(writeCookie, writeComplete.csrfToken)
    )).resolves.toMatchObject({ idleExpiresAt: '2026-08-22T12:50:00.000Z' })
    explicitWrite.advance(29 * 60_000)
    await expect(explicitWrite.manager.authenticatePassive(writeCookie)).resolves.toMatchObject({
      actor: { userId: explicitWrite.actor.userId }
    })
  })

  it('refreshes expiring access tokens with a principal fence and revokes refresh on logout', async () => {
    const test = fixture()
    const login = await test.manager.beginLogin()
    const callback = await complete(test, login)
    const sessionCookie = cookiePair(callback.setCookies.find((value) => value.startsWith('__Host-sciforge-portal='))!)
    test.advance(241_000)
    await test.manager.authenticate(sessionCookie)
    expect(test.authentication.resolveBearer).toHaveBeenLastCalledWith('refreshed-access-token-value-000000000000')
    expect(test.fetchCalls.filter((call) => call.url.endsWith('/token'))).toHaveLength(2)

    const cleared = await test.manager.logout(writeHeaders(sessionCookie, callback.csrfToken))
    expect(cleared).toEqual(expect.arrayContaining([
      expect.stringContaining('__Host-sciforge-portal=;'),
      expect.stringContaining('__Host-sciforge-portal-login=;')
    ]))
    await vi.waitFor(() => expect(test.fetchCalls.some((call) => call.url.endsWith('/revoke'))).toBe(true))
    await expect(test.manager.authenticate(sessionCookie)).rejects.toBeInstanceOf(PortalSessionError)
  })

  it('coalesces concurrent refreshes into one rotation and keeps the refreshed session current', async () => {
    const test = fixture()
    const login = await test.manager.beginLogin()
    const callback = await complete(test, login)
    const sessionCookie = cookiePair(callback.setCookies.find((value) => value.startsWith('__Host-sciforge-portal='))!)
    test.advance(241_000)

    const contexts = await Promise.all(Array.from({ length: 12 }, async () => test.manager.authenticate(sessionCookie)))
    expect(contexts.every((context) => context.actor.userId === test.actor.userId)).toBe(true)
    expect(test.fetchCalls.filter((call) => call.url.endsWith('/token'))).toHaveLength(2)
    expect(test.authentication.resolveBearer).toHaveBeenCalledTimes(2)
    await expect(test.manager.authenticate(sessionCookie)).resolves.toMatchObject({ actor: { userId: test.actor.userId } })
  })

  it('bounds anonymous login work per source before allocating more transactions', async () => {
    const test = fixture()
    let firstLogin: Awaited<ReturnType<PortalSessionManager['beginLogin']>> | undefined
    for (let index = 0; index < 8; index += 1) {
      const login = await test.manager.beginLogin('198.51.100.10')
      firstLogin ??= login
    }
    await expect(test.manager.beginLogin('198.51.100.10')).rejects.toMatchObject({
      code: 'portal_rate_limited', status: 429, retryable: true
    })
    expect(test.fetchCalls.filter((call) => call.url.endsWith('/.well-known/openid-configuration'))).toHaveLength(1)
    await expect(test.manager.beginLogin('198.51.100.11'))
      .resolves.toMatchObject({ location: expect.stringContaining('code_challenge=') })
    await complete(test, firstLogin!)
    test.advance(5_000)
    await expect(test.manager.beginLogin('198.51.100.10'))
      .resolves.toMatchObject({ location: expect.stringContaining('code_challenge=') })
  })

  it('caps sessions per OIDC identity and evicts only that identity oldest session', async () => {
    const test = fixture()
    const sessionCookies: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const callback = await complete(test, await test.manager.beginLogin('198.51.100.20'))
      sessionCookies.push(cookiePair(callback.setCookies.find((value) => value.startsWith('__Host-sciforge-portal='))!))
    }
    await expect(test.manager.authenticate(sessionCookies[0]!)).rejects.toMatchObject({
      code: 'portal_authentication_required'
    })
    await expect(test.manager.authenticate(sessionCookies[4]!)).resolves.toMatchObject({
      actor: { userId: test.actor.userId }
    })
    expect(test.fetchCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(1)
  })

  it('atomically caps one identity at four sessions across eight barrier-synchronized callbacks', async () => {
    const test = fixture({ authorizationCodeBarrierCount: 8 })
    const logins: Array<Awaited<ReturnType<PortalSessionManager['beginLogin']>>> = []
    for (let index = 0; index < 8; index += 1) {
      logins.push(await test.manager.beginLogin('198.51.100.30'))
    }

    const callbacks = await Promise.all(logins.map(async (login) => complete(test, login)))
    const live = await Promise.all(callbacks.map(async (callback) => {
      const sessionCookie = cookiePair(callback.setCookies.find((value) => value.startsWith('__Host-sciforge-portal='))!)
      return test.manager.authenticate(sessionCookie).then(() => true, () => false)
    }))

    expect(live.filter(Boolean)).toHaveLength(4)
    expect(sessionCount(test.manager)).toBe(4)
    await vi.waitFor(() => {
      expect(test.fetchCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(4)
    })
  })

  it('never exceeds the global session cap and reserves capacity fairly against one noisy identity', async () => {
    const test = fixture({ authorizationCodeBarrierCount: 8 })
    seedSessionsNearGlobalCap(test.manager, test.actor, 1_019)
    const sessionHighWater = trackSessionHighWater(test.manager)

    const noisyLogins: Array<Awaited<ReturnType<PortalSessionManager['beginLogin']>>> = []
    for (let index = 0; index < 8; index += 1) {
      noisyLogins.push(await test.manager.beginLogin('198.51.100.40'))
    }
    await Promise.all(noisyLogins.map(async (login) => complete(test, login)))
    expect(sessionCount(test.manager)).toBe(1_023)

    test.setActor({
      ...test.actor,
      actorKey: 'oidc:identity-other',
      userId: 'usr_portalOther00002',
      identityId: 'oid_portalOther0002',
      subject: 'portal-other-subject'
    })
    const other = await complete(test, await test.manager.beginLogin('198.51.100.41'))
    const otherCookie = cookiePair(other.setCookies.find((value) => value.startsWith('__Host-sciforge-portal='))!)
    await expect(test.manager.authenticate(otherCookie)).resolves.toMatchObject({
      actor: { userId: 'usr_portalOther00002' }
    })
    expect(sessionCount(test.manager)).toBe(1_024)

    test.setActor({
      ...test.actor,
      actorKey: 'oidc:identity-overflow',
      userId: 'usr_portalOverflow03',
      identityId: 'oid_portalOverflow03',
      subject: 'portal-overflow-subject'
    })
    await expect(complete(test, await test.manager.beginLogin('198.51.100.42'))).rejects.toMatchObject({
      code: 'portal_rate_limited', status: 429
    })
    expect(sessionCount(test.manager)).toBe(1_024)
    expect(sessionHighWater()).toBe(1_024)
  })

  it('fails closed on invalid public origin, callback, client secret, and duplicate session cookies', async () => {
    const test = fixture()
    const base = {
      issuer: ISSUER,
      clientId: 'sciforge-cloud-console',
      clientSecret: 's'.repeat(64),
      publicOrigin: ORIGIN,
      redirectUri: REDIRECT,
      authentication: test.authentication,
      verifier: test.verifier
    }
    expect(() => new PortalSessionManager({ ...base, publicOrigin: 'http://cloud-test.sciforge.cn' })).toThrowError(
      expect.objectContaining({ code: 'portal_configuration_invalid' })
    )
    expect(() => new PortalSessionManager({ ...base, redirectUri: `${ORIGIN}/other/callback` })).toThrowError(
      expect.objectContaining({ code: 'portal_configuration_invalid' })
    )
    expect(() => new PortalSessionManager({ ...base, clientSecret: ['too', 'short'].join('-') })).toThrowError(
      expect.objectContaining({ code: 'portal_configuration_invalid' })
    )

    const login = await test.manager.beginLogin()
    const callback = await complete(test, login)
    const pair = cookiePair(callback.setCookies.find((value) => value.startsWith('__Host-sciforge-portal='))!)
    await expect(test.manager.authenticate(`${pair}; ${pair}`)).rejects.toMatchObject({
      code: 'portal_authentication_required'
    })
  })

  it('maps an invalid authorization code to a bounded login rejection without echoing provider details', async () => {
    const test = fixture({ tokenStatus: 400 })
    const login = await test.manager.beginLogin()
    const result = test.manager.completeLogin(new URLSearchParams({
      code: 'authorization-code-value',
      state: new URL(login.location).searchParams.get('state')!,
      iss: ISSUER
    }), cookiePair(login.setCookie))
    await expect(result).rejects.toMatchObject({
      code: 'portal_login_rejected',
      status: 401,
      message: expect.not.stringContaining('private-marker')
    })
  })
})

async function complete(test: Fixture, login: Awaited<ReturnType<PortalSessionManager['beginLogin']>>) {
  const location = new URL(login.location)
  return test.manager.completeLogin(new URLSearchParams({
    code: 'authorization-code-value',
    state: location.searchParams.get('state')!,
    iss: ISSUER
  }), cookiePair(login.setCookie))
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0]
}

function writeHeaders(cookie: string, csrf: string) {
  return {
    cookie,
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'x-sciforge-csrf': csrf
  }
}

function json(value: unknown, status = 200): Response {
  const body = JSON.stringify(value)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body))
    }
  })
}

function sessionCount(manager: PortalSessionManager): number {
  return (manager as unknown as { sessions: Map<string, unknown> }).sessions.size
}

function trackSessionHighWater(manager: PortalSessionManager): () => number {
  const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions
  const set = sessions.set.bind(sessions)
  let highWater = sessions.size
  sessions.set = (key, value) => {
    const result = set(key, value)
    highWater = Math.max(highWater, sessions.size)
    return result
  }
  return () => highWater
}

function seedSessionsNearGlobalCap(manager: PortalSessionManager, actor: UserActor, count: number): void {
  const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions
  for (let index = 0; index < count; index += 1) {
    sessions.set(`seed-${index}`, {
      actor: {
        ...actor,
        actorKey: `oidc:seed-${index}`,
        userId: `usr_seed_${index}`,
        identityId: `oid_seed_${index}`,
        subject: `seed-subject-${index}`
      },
      accessToken: `seed-access-${index}`,
      refreshToken: `seed-refresh-${index}`,
      csrfToken: 'A'.repeat(43),
      csrfDigest: Buffer.alloc(32),
      createdAt: NOW.getTime(),
      lastSeenAt: NOW.getTime(),
      absoluteExpiresAt: NOW.getTime() + 8 * 60 * 60_000
    })
  }
}
