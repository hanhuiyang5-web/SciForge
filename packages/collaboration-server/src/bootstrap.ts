import { once } from 'node:events'
import type { Server } from 'node:http'

import {
  createCollaborationHttpServer,
  dispatchAuditedCollaborationCommand,
  type BindingConfirmAuthenticator,
  type CollaborationHttpOptions,
  type ProviderDirectory
} from './api.js'
import { AuthenticationService, StrictOidcUserResolver } from './auth.js'
import { toHumanNeeded, toProject, toProjectRecord, toTask } from './contracts.js'
import { IdentityService } from './identity-service.js'
import { isCollaborationDatabaseReady } from './migrations.js'
import { createOidcAccessTokenVerifier, type OidcAccessTokenVerifierOptions } from './oidc.js'
import { CollaborationPortal } from './portal.js'
import type { PortalAssetStore } from './portal-assets.js'
import { PortalSessionManager } from './portal-session.js'
import { PortalWebSocketHub } from './portal-websocket.js'
import { PostgresCollaborationRepository, type SqlPool } from './postgres.js'
import type { CollaborationProviderRuntime } from './provider-runtime.js'
import type { CollaborationRepository } from './repository.js'
import { CollaborationService, type InboxAvailabilityNotifier } from './service.js'
import { CollaborationWebSocketHub } from './websocket.js'

export type CollaborationServerRuntimeOptions = {
  pool: SqlPool
  host: string
  port: number
  basePath?: string
  allowedOrigins?: readonly string[]
  providers?: ProviderDirectory
  oidc?: OidcAccessTokenVerifierOptions
  authenticateZulipBindingConfirm?: BindingConfirmAuthenticator
  providerRuntimeFactory?: (context: Readonly<{
    repository: CollaborationRepository
    service: CollaborationService
    authentication: AuthenticationService
  }>) => Promise<CollaborationProviderRuntime>
  now?: () => Date
  portal?: Readonly<{
    assets: PortalAssetStore
    publicOrigin: string
    clientId: string
    clientSecret: string
    redirectUri: string
    testWorkerDirectoryEnabled: boolean
  }>
}

export type CollaborationServerRuntime = {
  readonly service: CollaborationService
  readonly identities: IdentityService
  readonly authentication: AuthenticationService
  readonly httpServer: Server
  start(): Promise<{ host: string; port: number }>
  stop(): Promise<void>
}

export function createCollaborationServerRuntime(options: CollaborationServerRuntimeOptions): CollaborationServerRuntime {
  if (options.providers && options.providerRuntimeFactory) {
    throw new Error('Configure either a provider directory or a provider runtime factory, not both.')
  }
  const repository = new PostgresCollaborationRepository(options.pool)
  const webSocketHub = new CollaborationWebSocketHub()
  const liveNotifiers: InboxAvailabilityNotifier[] = [webSocketHub]
  const notifier: InboxAvailabilityNotifier = {
    async notifyInboxAvailable(recipient, latestSequence) {
      await Promise.all(liveNotifiers.map(async (target) => {
        await target.notifyInboxAvailable(recipient, latestSequence)
      }))
    }
  }
  const service = new CollaborationService({ repository, notifier, now: options.now,
    testWorkerDirectoryEnabled: options.portal?.testWorkerDirectoryEnabled === true })
  const identities = new IdentityService({ repository, now: options.now })
  const oidcVerifier = options.oidc ? createOidcAccessTokenVerifier(options.oidc) : undefined
  const authentication = new AuthenticationService(repository, options.now,
    oidcVerifier ? new StrictOidcUserResolver(oidcVerifier, identities) : undefined)
  if (options.portal && !oidcVerifier) throw new Error('Portal runtime requires strict OIDC authentication.')
  const portalOidcVerifier = options.portal && options.oidc
    ? createOidcAccessTokenVerifier({
        ...options.oidc,
        allowedAuthorizedParties: [options.portal.clientId]
      })
    : undefined
  const portalAuthentication = portalOidcVerifier
    ? new AuthenticationService(repository, options.now,
        new StrictOidcUserResolver(portalOidcVerifier, identities))
    : undefined
  let providerRuntime: CollaborationProviderRuntime | undefined
  const providerDirectory: ProviderDirectory | undefined = options.providerRuntimeFactory
    ? {
        contracts: () => providerRuntime?.contracts() ?? [],
        listLocators: async (input) => {
          if (!providerRuntime) throw new Error('Provider runtime has not started.')
          return providerRuntime.listLocators(input)
        }
      }
    : options.providers
  let httpOptions: CollaborationHttpOptions
  const portalSessions = options.portal && portalOidcVerifier && portalAuthentication
    ? new PortalSessionManager({
        issuer: portalOidcVerifier.issuer,
        clientId: options.portal.clientId,
        clientSecret: options.portal.clientSecret,
        publicOrigin: options.portal.publicOrigin,
        redirectUri: options.portal.redirectUri,
        authentication: portalAuthentication,
        verifier: portalOidcVerifier,
        now: options.now
      })
    : undefined
  const portal = options.portal && portalSessions
    ? new CollaborationPortal({
        assets: options.portal.assets,
        sessions: portalSessions,
        dispatch: (command, actor) => dispatchAuditedCollaborationCommand(command, actor, httpOptions),
        readCoordination: async (actor, projectId, input) => {
          const view = await service.getPortalProjectCoordinationView(actor, projectId, input)
          return {
            schemaVersion: 1 as const,
            type: 'project_coordination_view' as const,
            projectId: view.project.projectId,
            projectRevision: view.project.revision,
            project: toProject(view.project, view.members),
            members: view.members.map((member) => ({
              userId: member.userId,
              displayName: member.displayName,
              role: member.role,
              active: member.active
            })),
            tasks: view.tasks.map(toTask),
            records: view.records.map(toProjectRecord),
            humanRequests: view.humanRequests.map(toHumanNeeded),
            pagination: view.pagination,
            readAt: view.readAt
          }
        },
        userSnapshot: async (actor) => {
          const user = await service.getUser(actor, actor.userId)
          return { userId: user.userId, displayName: user.displayName }
        }
      })
    : undefined
  const portalWebSocket = options.portal && portalSessions
    ? new PortalWebSocketHub({
        sessions: portalSessions,
        publicOrigin: options.portal.publicOrigin,
        readProject: (actor, projectId) => service.getPortalProjectWakeSnapshot(actor, projectId),
        now: options.now
      })
    : undefined
  if (portalWebSocket) liveNotifiers.push(portalWebSocket)
  httpOptions = { service, identities, authentication,
    readiness: () => isCollaborationDatabaseReady(options.pool), providers: providerDirectory,
    authenticateZulipBindingConfirm: options.authenticateZulipBindingConfirm,
    basePath: options.basePath, now: options.now, portal }
  const httpServer = createCollaborationHttpServer(httpOptions)
  webSocketHub.attach(httpServer, { authentication, basePath: options.basePath,
    allowedOrigins: options.allowedOrigins, now: options.now, portal: portalWebSocket })
  let started = false
  let stopped = false
  let starting: Promise<{ host: string; port: number }> | undefined
  return {
    service,
    identities,
    authentication,
    httpServer,
    async start() {
      if (stopped) throw new Error('Collaboration server runtime was already stopped.')
      starting ??= (async () => {
        if (options.providerRuntimeFactory && !providerRuntime) {
          providerRuntime = await options.providerRuntimeFactory({ repository, service, authentication })
          await providerRuntime.start()
        }
        if (!started) {
          httpServer.listen(options.port, options.host)
          await once(httpServer, 'listening')
          started = true
        }
        const address = httpServer.address()
        if (!address || typeof address === 'string') throw new Error('Collaboration server did not expose a TCP address.')
        return { host: options.host, port: address.port }
      })()
      return starting
    },
    async stop() {
      if (stopped) return
      stopped = true
      if (started) {
        const closed = once(httpServer, 'close')
        httpServer.close()
        await providerRuntime?.stop()
        await portalWebSocket?.close()
        await webSocketHub.close()
        await closed
      } else {
        await providerRuntime?.stop()
        await portalWebSocket?.close()
        await webSocketHub.close()
      }
      portalSessions?.close()
      await repository.close()
    }
  }
}
