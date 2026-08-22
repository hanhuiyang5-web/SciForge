import {
  createHash,
  randomUUID
} from 'node:crypto'
import { z } from 'zod'
import {
  restRequestSchema,
  type AgentInboxMessage,
  type AgentNode,
  type HumanEndpointBinding,
  type ManagedProviderContainer,
  type ProviderLocator,
  type ParticipantProfile,
  type RestRequest,
  type RestResponse,
  type UserPrincipal
} from '@sciforge/collaboration-contracts'
import type {
  IdentityCloudSessionService,
  IdentityCloudSessionSnapshot
} from '@sciforge/domain-identity-access/main'
import type { DomainMainPackageSecretStoreHost } from '@sciforge/domain-sdk/package-storage'
import type {
  CollaborationAgentRegisterInput,
  CollaborationConnectionConnectInput,
  CollaborationEndpointChallengePollInput,
  CollaborationEndpointChallengeStartInput,
  CollaborationProviderOption
} from '../contract.js'
import { CloudProtocolError, collaborationRequestId, type CollaborationCloudClient } from './cloud-client.js'
import { DurableCloudOutbox } from './outbox.js'
import { CollaborationSettingsService } from './settings.js'
import { CollaborationLocalStore, EMPTY_COLLABORATION_LOCAL_STATE } from './store.js'

export const COLLABORATION_DEVICE_CREDENTIAL_KEY = 'device-credential' as const
const PAIRING_POLL_KEY = 'pairing-poll' as const
const WORKER_CAPABILITY = 'project.worker.v1' as const
const COORDINATOR_CAPABILITY = 'project.coordinator.v1' as const

class CapabilityProfileRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('Cloud returned the current capability profile revision.')
    this.name = 'CapabilityProfileRevisionConflictError'
  }
}

function capabilityProfileIdempotencyKey(profile: unknown, expectedRevision: number): string {
  return `idem_agent.capability_profile.${digest(JSON.stringify({ expectedRevision, profile })).slice(0, 48)}`
}

const pairingPollStateSchema = z.object({
  bindingRequestId: z.string().regex(/^zbr_[A-Za-z0-9](?:[A-Za-z0-9_]{10,62}[A-Za-z0-9])$/),
  expiresAt: z.iso.datetime({ offset: true })
}).strict()

export type CollaborationCloudIdentity = Readonly<{
  userId: string
  deviceId: string
}>

export type CollaborationConnectionState = Readonly<{
  state: 'unconfigured' | 'disconnected' | 'connecting' | 'connected' | 'recovering' | 'error'
  lastConnectedAt?: string
  lastError?: string
}>

export type CollaborationInboxHandler = Readonly<{
  handle(message: AgentInboxMessage): Promise<void>
}>

export type CollaborationConnectionOptions = Readonly<{
  store: CollaborationLocalStore
  settings: CollaborationSettingsService
  packageSecrets: DomainMainPackageSecretStoreHost
  cloudIdentitySession: IdentityCloudSessionService
  outbox: DurableCloudOutbox
  createCloudClient: (baseUrl: string) => CollaborationCloudClient
  inboxHandler: CollaborationInboxHandler
  sanitizeText?: (value: string) => string
  now?: () => Date
  bcCapabilitiesEnabled?: boolean
}>

export class CollaborationConnection {
  private readonly now: () => Date
  private client: CollaborationCloudClient | null = null
  private connectionState: CollaborationConnectionState = { state: 'unconfigured' }
  private providerOptions: readonly CollaborationProviderOption[] = []
  private abortController: AbortController | null = null
  private pullTail: Promise<void> = Promise.resolve()
  private background: Promise<void>[] = []
  private bcCapabilitiesEnabled: boolean
  private capabilityTail: Promise<void> = Promise.resolve()
  private profileTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: CollaborationConnectionOptions) {
    this.now = options.now ?? (() => new Date())
    this.bcCapabilitiesEnabled = options.bcCapabilitiesEnabled ?? false
  }

  state(): CollaborationConnectionState {
    return this.connectionState
  }

  providers(): readonly CollaborationProviderOption[] {
    return this.providerOptions
  }

  cloudClient(): CollaborationCloudClient | null {
    return this.client
  }

  async executeAsUser(request: RestRequest) {
    const parsed = restRequestSchema.parse(request)
    return this.withFreshUserCredential((credential) => (
      this.requireClient().execute(parsed, credential)
    ))
  }

  async executeAsDevice(request: RestRequest) {
    return this.requireClient().execute(restRequestSchema.parse(request), await this.requireDeviceCredential())
  }

  setBCCapabilities(enabled: boolean): Promise<void> {
    this.bcCapabilitiesEnabled = enabled
    const advertise = async () => {
      if (!this.client || !await this.options.packageSecrets.has(COLLABORATION_DEVICE_CREDENTIAL_KEY)) return
      const localAgentId = await this.localAgentId()
      const active = this.options.store.snapshot().agents.some((agent) => (
        agent.agentId === localAgentId && agent.lifecycleStatus === 'active'
      ))
      if (!active) return
      try {
        const credential = await this.requireDeviceCredential()
        await this.heartbeat(
          credential,
          this.abortController ? 'online' : 'offline',
          enabled
        )
        await this.refreshCapabilityProfile(credential, true)
        if (this.abortController) {
          this.connectionState = {
            state: 'connected',
            lastConnectedAt: this.now().toISOString()
          }
        }
      } catch (error) {
        this.recordError(error, true)
        throw error
      }
    }
    this.capabilityTail = this.capabilityTail.then(advertise, advertise)
    return this.capabilityTail
  }

  wake(): void {
    this.options.outbox.wake()
    void this.capabilityTail.then(
      () => this.wakeInbox(),
      () => this.wakeInbox()
    )
  }

  async localAgentId(): Promise<string | undefined> {
    const configured = await this.options.settings.read()
    return configured.settings?.agentId
  }

  async authorityChanged(snapshot: IdentityCloudSessionSnapshot): Promise<boolean> {
    const configured = await this.options.settings.read()
    const userId = this.options.store.snapshot().user?.userId
    return Boolean(
      configured.settings && (
        configured.settings.baseUrl !== snapshot.cloudBaseUrl ||
        (configured.settings.deviceId && configured.settings.deviceId !== snapshot.deviceId) ||
        (userId && userId !== snapshot.userId)
      )
    )
  }

  async acceptAgentRevocation(agentId: string, occurredAt: string): Promise<void> {
    const localAgentId = await this.localAgentId()
    if (!localAgentId || localAgentId !== agentId) {
      throw new Error('Agent revocation does not target this installation.')
    }
    await this.options.packageSecrets.remove(COLLABORATION_DEVICE_CREDENTIAL_KEY)
    await this.options.settings.rememberAgent(undefined)
    const controller = this.abortController
    this.abortController = null
    controller?.abort()
    this.options.outbox.stop()
    await this.options.store.transact((draft) => {
      const agent = draft.agents.find((candidate) => candidate.agentId === agentId)
      if (!agent || agent.lifecycleStatus === 'revoked') return
      agent.lifecycleStatus = 'revoked'
      agent.connectionStatus = 'offline'
      agent.revokedAt = occurredAt
      agent.updatedAt = occurredAt
      agent.revision += 1
    })
    this.connectionState = {
      state: 'error',
      lastConnectedAt: this.connectionState.lastConnectedAt,
      lastError: 'This collaboration Agent registration was revoked.'
    }
  }

  async activate(): Promise<void> {
    const configured = await this.options.settings.read()
    if (!configured.settings) {
      this.connectionState = { state: 'unconfigured' }
      return
    }
    this.client = this.options.createCloudClient(configured.settings.baseUrl)
    await this.refreshProviderCatalog().catch((error) => this.recordError(error, false))
    const cachedUser = this.options.store.snapshot().user
    if (cachedUser && this.options.cloudIdentitySession.current()) {
      try {
        const snapshot = await this.refreshParticipant(cachedUser.userId)
        for (const endpoint of snapshot.humanEndpoints) {
          if (endpoint.status === 'active') {
            await this.refreshEndpointLocators(endpoint.humanEndpointId)
          }
        }
        if (this.providerOptions.some((provider) => provider.managedContainers)) {
          await this.refreshManagedContainers()
        }
      } catch (error) {
        // Cached collaboration state remains usable while offline. A later
        // explicit recovery/restart repeats this canonical cloud refresh.
        this.recordError(error, true)
      }
    }
    if (configured.settings.agentId && await this.options.packageSecrets.has(COLLABORATION_DEVICE_CREDENTIAL_KEY)) {
      // A configured desktop must still activate while the cloud is offline. The
      // durable inbox/outbox and projection recovery remain available, and the
      // explicit recover action retries the same canonical connection path.
      await this.connect().catch(() => undefined)
    } else {
      this.connectionState = { state: 'disconnected' }
    }
  }

  async dispose(): Promise<void> {
    await this.disconnect()
  }

  async configure(baseUrl: string): Promise<void> {
    await this.disconnect()
    const previous = await this.options.settings.read()
    const settings = await this.options.settings.configure(baseUrl)
    if (previous.settings && previous.settings.baseUrl !== settings.baseUrl) {
      await Promise.all([
        COLLABORATION_DEVICE_CREDENTIAL_KEY,
        PAIRING_POLL_KEY
      ].map((key) => this.options.packageSecrets.remove(key)))
      await this.resetCloudProjectionState()
    }
    this.client = this.options.createCloudClient(settings.baseUrl)
    this.connectionState = { state: 'disconnected' }
    await this.refreshProviderCatalog()
  }

  /** Main-process only. C owns Device enrollment; BC adopts only the validated ACTIVE Device. */
  async adoptCloudIdentity(
    snapshot: IdentityCloudSessionSnapshot
  ): Promise<CollaborationCloudIdentity> {
    const configured = await this.options.settings.require()
    const { me, device } = await this.withFreshUserCredential(async (credential, leasedSnapshot) => {
      if (
        leasedSnapshot.authorityGeneration !== snapshot.authorityGeneration ||
        leasedSnapshot.userId !== snapshot.userId ||
        leasedSnapshot.deviceId !== snapshot.deviceId ||
        leasedSnapshot.cloudBaseUrl !== snapshot.cloudBaseUrl
      ) {
        throw new Error('The Desktop Cloud authority changed before collaboration adoption.')
      }
      const me = await this.requireClient().me(credential)
      if (me.userId !== snapshot.userId) {
        throw new Error('The Desktop identity session does not match the Cloud Principal.')
      }
      const devices = await this.requireClient().listDevices(credential)
      const device = devices.devices.find((candidate) => candidate.deviceId === snapshot.deviceId)
      if (!device || device.userId !== me.userId || device.status !== 'active') {
        throw new Error('The Desktop identity session has no matching ACTIVE Cloud Device.')
      }
      return { me, device }
    })
    const accountChanged = this.options.store.snapshot().user?.userId !== undefined &&
      this.options.store.snapshot().user?.userId !== me.userId
    const deviceChanged = configured.deviceId !== undefined && configured.deviceId !== device.deviceId
    if (accountChanged || deviceChanged) {
      await this.disconnect()
      await this.options.packageSecrets.remove(COLLABORATION_DEVICE_CREDENTIAL_KEY)
      await this.resetCloudProjectionState()
    }
    await this.options.settings.bindDevice(device.deviceId)
    await this.refreshParticipant(me.userId)
    return { userId: me.userId, deviceId: device.deviceId }
  }

  async applyConnectionAction(input: CollaborationConnectionConnectInput): Promise<void> {
    if (input.action === 'disconnect') {
      const credential = await this.options.packageSecrets.read(COLLABORATION_DEVICE_CREDENTIAL_KEY)
      if (credential && this.client) {
        await this.heartbeat({ value: credential }, 'offline').catch((error) => {
          this.recordError(error, true)
        })
      }
      await this.disconnect()
      return
    }
    if (input.action === 'recover') {
      this.options.outbox.wake()
    }
    await this.connect()
  }

  async releaseCloudIdentity(): Promise<void> {
    const credential = await this.options.packageSecrets.read(COLLABORATION_DEVICE_CREDENTIAL_KEY)
    if (credential && this.client) {
      await this.heartbeat({ value: credential }, 'offline').catch(() => undefined)
    }
    await this.disconnect()
    await Promise.all([
      this.options.packageSecrets.remove(COLLABORATION_DEVICE_CREDENTIAL_KEY),
      this.options.packageSecrets.remove(PAIRING_POLL_KEY)
    ])
    await this.resetCloudProjectionState()
    if ((await this.options.settings.read()).settings) await this.options.settings.releaseIdentity()
  }

  reportSessionError(error: unknown): void {
    this.recordError(error, true)
  }

  async startChallenge(input: CollaborationEndpointChallengeStartInput): Promise<Readonly<{
    challengeId: string
    pairingCode: string
    expiresAt: string
    instruction: string
  }>> {
    const realmUrl = input.locator.realmUrl?.trim()
    if (!realmUrl) throw new Error('The selected provider requires a realmUrl locator value.')
    const request = restRequestSchema.parse({
      protocolVersion: '1.0',
      requestId: collaborationRequestId(),
      type: 'pairing.begin',
      idempotencyKey: `idem_pairing.begin.${digest([
        realmUrl,
        input.requestedDisplayName
      ].join('\u0000')).slice(0, 48)}`,
      realmUrl
    })
    const response = await this.executeAsUser(request)
    if (response.type === 'rest.error') throw new Error(response.error.message)
    if (response.type !== 'pairing.begun') {
      throw new Error(`Pairing begin returned unexpected ${response.type}.`)
    }
    const pairingCommand = `sciforge-pair ${response.bindingCode}`
    if (pairingCommand.length > 64) {
      throw new Error('Pairing service returned a command that exceeds the supported display length.')
    }
    await this.options.packageSecrets.write(PAIRING_POLL_KEY, JSON.stringify({
      bindingRequestId: response.bindingRequestId,
      expiresAt: response.expiresAt
    }))
    const providerLabel = this.providerOptions.find((provider) => (
      provider.providerKey === input.providerKey
    ))?.label ?? input.providerKey
    return {
      challengeId: response.bindingRequestId,
      pairingCode: pairingCommand,
      expiresAt: response.expiresAt,
      instruction: `Send this entire command unchanged in ${providerLabel}, in the designated pairing topic or any topic visible to its SciForge integration.`
    }
  }

  async pollChallenge(input: CollaborationEndpointChallengePollInput): Promise<
    | Readonly<{ status: 'pending'; expiresAt: string; retryAfterSeconds: number }>
    | Readonly<{ status: 'expired' }>
    | Readonly<{
        status: 'verified'
        userId: string
        humanEndpointId: string
        assurance: 'low' | 'verified' | 'strong'
      }>
  > {
    const rawSecret = await this.options.packageSecrets.read(PAIRING_POLL_KEY)
    if (!rawSecret) return { status: 'expired' }
    const poll = pairingPollStateSchema.parse(JSON.parse(rawSecret) as unknown)
    if (poll.bindingRequestId !== input.challengeId || Date.parse(poll.expiresAt) <= this.now().getTime()) {
      await this.options.packageSecrets.remove(PAIRING_POLL_KEY)
      return { status: 'expired' }
    }
    const response = await this.executeAsUser(restRequestSchema.parse({
      protocolVersion: '1.0',
      requestId: collaborationRequestId(),
      type: 'pairing.redeem',
      idempotencyKey: `idem_pairing.redeem.${digest(poll.bindingRequestId).slice(0, 48)}`,
      bindingRequestId: poll.bindingRequestId
    }))
    if (response.type === 'pairing.pending') {
      return {
        status: 'pending',
        expiresAt: poll.expiresAt,
        retryAfterSeconds: response.retryAfterSeconds
      }
    }
    if (response.type === 'rest.error' && response.error.code === 'expired') {
      await this.options.packageSecrets.remove(PAIRING_POLL_KEY)
      return { status: 'expired' }
    }
    if (response.type === 'rest.error') throw new Error(response.error.message)
    if (response.type !== 'pairing.bound') {
      throw new Error(`Pairing redeem returned unexpected ${response.type}.`)
    }
    await this.options.packageSecrets.remove(PAIRING_POLL_KEY)
    const snapshot = await this.refreshParticipant(response.identity.userId)
    await this.refreshEndpointLocators(response.identity.humanEndpointId)
    const endpoint = snapshot.humanEndpoints.find((item) => (
      item.humanEndpointId === response.identity.humanEndpointId
    ))
    return {
      status: 'verified',
      userId: response.identity.userId,
      humanEndpointId: response.identity.humanEndpointId,
      assurance: mapAssurance(endpoint?.assurance ?? 'verified')
    }
  }

  async registerAgent(input: CollaborationAgentRegisterInput): Promise<AgentNode> {
    return this.withFreshUserCredential((credential) => this.registerAgentWithCredential(input, credential))
  }

  private async registerAgentWithCredential(
    input: CollaborationAgentRegisterInput,
    credential: Readonly<{ value: string }>
  ): Promise<AgentNode> {
    const settings = await this.options.settings.require()
    const state = this.options.store.snapshot()
    if (!state.user) throw new Error('A cloud-authenticated Principal is required before registering this Agent.')
    if (!settings.deviceId) {
      throw new Error('C has no enrolled A Device. Bind the cloud Device before Agent registration.')
    }
    const registrationIntent = {
      deviceId: settings.deviceId,
      ownerUserId: state.user.userId,
      displayName: input.displayName.trim(),
      nodeType: input.nodeType,
      capabilities: this.desiredCapabilities(input.capabilities)
    }
    const existing = state.agents.find((agent) => (
      agent.deviceId === settings.deviceId &&
      agent.ownerUserId === state.user?.userId &&
      agent.lifecycleStatus === 'active'
    ))
    if (existing) {
      if (await this.options.packageSecrets.has(COLLABORATION_DEVICE_CREDENTIAL_KEY)) {
        await this.completeAgentRegistration(existing)
        return existing
      }
      return this.recoverAgentCredential(existing, credential)
    }

    const registrationRequest = restRequestSchema.parse({
      protocolVersion: '1.0',
      requestId: collaborationRequestId(),
      type: 'agent.register',
      idempotencyKey: `idem_agent.register.${digest(JSON.stringify(registrationIntent)).slice(0, 48)}`,
      ...registrationIntent
    })
    let response: RestResponse
    try {
      try {
        response = await this.requireClient().execute(registrationRequest, credential)
      } catch {
        response = await this.requireClient().execute(registrationRequest, credential)
      }
    } catch (registrationError) {
      const refreshed = await this.refreshParticipant(state.user.userId).catch(() => undefined)
      const registered = refreshed?.agents.find((agent) => (
        agent.deviceId === settings.deviceId &&
        agent.ownerUserId === state.user?.userId &&
        agent.lifecycleStatus === 'active'
      ))
      if (!registered) throw registrationError
      return this.recoverAgentCredential(registered, credential)
    }
    if (response.type === 'rest.error') {
      const refreshed = await this.refreshParticipant(state.user.userId).catch(() => undefined)
      const registered = refreshed?.agents.find((agent) => (
        agent.deviceId === settings.deviceId &&
        agent.ownerUserId === state.user?.userId &&
        agent.lifecycleStatus === 'active'
      ))
      if (registered) return this.recoverAgentCredential(registered, credential)
      throw new Error(response.error.message)
    }
    if (response.type !== 'agent.registered') {
      throw new Error(`Agent registration returned unexpected ${response.type}.`)
    }
    await this.options.packageSecrets.write(COLLABORATION_DEVICE_CREDENTIAL_KEY, response.deviceCredential)
    await this.completeAgentRegistration(response.agent)
    return response.agent
  }

  private async completeAgentRegistration(agent: AgentNode): Promise<void> {
    await this.options.settings.rememberAgent(agent.agentId)
    await this.options.store.transact((draft) => {
      draft.agents = replaceBy(draft.agents, agent, (item) => item.agentId)
    })
    // Registration can atomically promote the first Agent to participant
    // primary and advance the participant revision. Refresh with the existing
    // OIDC lease before connecting so renderer CAS inputs never expose the
    // pre-registration snapshot. The one-time Agent credential remains opaque
    // in the secret store until the Agent connection path reads it.
    await this.refreshParticipant(agent.ownerUserId)
    await this.connect()
  }

  private async recoverAgentCredential(
    initialAgent: AgentNode,
    credential: Readonly<{ value: string }>
  ): Promise<AgentNode> {
    let agent = initialAgent
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const request = restRequestSchema.parse({
        protocolVersion: '1.0',
        requestId: collaborationRequestId(),
        type: 'agent.rotate_credential',
        idempotencyKey: `idem_agent.rotate_credential.${digest([
          agent.agentId,
          String(agent.revision)
        ].join('\u0000')).slice(0, 48)}`,
        agentId: agent.agentId,
        expectedRevision: agent.revision
      })
      try {
        let response: RestResponse
        try {
          response = await this.requireClient().execute(request, credential)
        } catch {
          response = await this.requireClient().execute(request, credential)
        }
        if (response.type === 'rest.error') throw new Error(response.error.message)
        if (response.type !== 'agent.credential_rotated') {
          throw new Error(`Agent credential recovery returned unexpected ${response.type}.`)
        }
        await this.options.packageSecrets.write(
          COLLABORATION_DEVICE_CREDENTIAL_KEY,
          response.deviceCredential
        )
        await this.completeAgentRegistration(response.agent)
        return response.agent
      } catch (error) {
        lastError = error
        const refreshed = await this.refreshParticipant(agent.ownerUserId).catch(() => undefined)
        const current = refreshed?.agents.find((candidate) => (
          candidate.agentId === agent.agentId &&
          candidate.deviceId === agent.deviceId &&
          candidate.lifecycleStatus === 'active'
        ))
        if (!current || current.revision === agent.revision) break
        agent = current
      }
    }
    throw lastError
  }

  async selectPrimaryAgent(
    agentId: string,
    expectedParticipantRevision: number
  ): Promise<ParticipantProfile> {
    const state = this.options.store.snapshot()
    const user = state.user
    const participant = state.participant
    if (!user || !participant) throw new Error('Participant binding is incomplete.')
    const agent = state.agents.find((candidate) => candidate.agentId === agentId)
    if (!agent || agent.ownerUserId !== user.userId || agent.lifecycleStatus !== 'active') {
      throw new Error('Primary Agent must be an active Agent owned by the current user.')
    }
    if (participant.revision !== expectedParticipantRevision) {
      throw new Error('Participant revision is stale.')
    }
    const response = await this.executeAsUser(restRequestSchema.parse({
      protocolVersion: '1.0',
      requestId: collaborationRequestId(),
      type: 'participant.update_primary',
      idempotencyKey: `idem_participant.primary.${digest([
        participant.participantId,
        agentId,
        String(expectedParticipantRevision)
      ].join('\u0000')).slice(0, 48)}`,
      userId: user.userId,
      expectedRevision: expectedParticipantRevision,
      primaryHumanEndpointId: participant.primaryHumanEndpointId,
      primaryAgentId: agentId
    }))
    if (response.type === 'rest.error') throw new Error(response.error.message)
    if (response.type !== 'rest.entity' || response.entity.type !== 'participant_profile') {
      throw new Error(`Primary Agent update returned unexpected ${response.type}.`)
    }
    const participantEntity = response.entity
    await this.options.store.transact((draft) => { draft.participant = participantEntity })
    return participantEntity
  }

  async refreshParticipant(userId?: string): Promise<Readonly<{
    user: UserPrincipal
    participant: ParticipantProfile
    humanEndpoints: readonly HumanEndpointBinding[]
    agents: readonly AgentNode[]
  }>> {
    const targetUserId = userId ?? this.options.store.snapshot().user?.userId
    if (!targetUserId) throw new Error('No collaboration user is bound.')
    const response = await this.executeAsUser(restRequestSchema.parse({
      protocolVersion: '1.0',
      requestId: collaborationRequestId(),
      type: 'participant.get',
      userId: targetUserId
    }))
    if (response.type === 'rest.error') throw new Error(response.error.message)
    if (response.type !== 'participant.snapshot') {
      throw new Error(`Participant query returned unexpected ${response.type}.`)
    }
    await this.options.store.transact((draft) => {
      draft.user = response.user
      draft.participant = response.participant
      draft.endpoints = [...response.humanEndpoints]
      draft.agents = [...response.agents]
    })
    return response
  }

  async connect(): Promise<void> {
    if (this.abortController) return
    const client = this.requireClient()
    const credential = await this.requireDeviceCredential()
    this.connectionState = { state: 'connecting' }
    const controller = new AbortController()
    this.abortController = controller
    try {
      await this.heartbeat(credential, 'online')
      await this.refreshCapabilityProfile(credential)
      await this.pullInbox(credential)
      this.connectionState = {
        state: 'connected',
        lastConnectedAt: this.now().toISOString()
      }
      this.options.outbox.start()
      this.background = [
        this.pollLoop(credential, controller.signal),
        this.notificationLoop(client, credential, controller.signal)
      ]
    } catch (error) {
      this.abortController = null
      this.recordError(error, true)
      throw error
    }
  }

  async disconnect(): Promise<void> {
    const controller = this.abortController
    this.abortController = null
    if (controller) controller.abort()
    this.options.outbox.stop()
    await Promise.allSettled(this.background)
    this.background = []
    if (this.client) this.connectionState = { state: 'disconnected' }
  }

  private async refreshProviderCatalog(): Promise<void> {
    const response = await this.requireClient().execute(restRequestSchema.parse({
      protocolVersion: '1.0',
      requestId: collaborationRequestId(),
      type: 'endpoint.catalog.get'
    }))
    if (response.type === 'rest.error') throw new Error(response.error.message)
    if (response.type !== 'endpoint.catalog') {
      throw new Error(`Provider catalog returned unexpected ${response.type}.`)
    }
    this.providerOptions = response.providers.map((provider) => ({
      providerKey: provider.provider,
      label: provider.displayName,
      realmLabel: provider.onboarding.realmLabel,
      containerLabel: provider.onboarding.containerLabel,
      topicLabel: provider.onboarding.topicLabel,
      managedContainers: provider.capabilities.managedContainers === true,
      locatorFields: [{
        key: 'realmUrl',
        label: 'Organization / realm URL',
        required: true,
        placeholder: 'https://organization.example'
      }]
    }))
  }

  async refreshEndpointLocators(humanEndpointId: string): Promise<number> {
    const locators = await this.withFreshUserCredential(async (credential) => {
      const values: Array<{ humanEndpointId: string; locator: ProviderLocator }> = []
      let cursor: string | undefined
      let pageCount = 0
      do {
        const response = await this.requireClient().execute(restRequestSchema.parse({
          protocolVersion: '1.0',
          requestId: collaborationRequestId(),
          type: 'endpoint.locator.list',
          humanEndpointId,
          ...(cursor ? { cursor } : {}),
          limit: 500
        }), credential)
        if (response.type === 'rest.error') throw new Error(response.error.message)
        if (response.type !== 'endpoint.locator_page') {
          throw new Error(`Endpoint locator query returned unexpected ${response.type}.`)
        }
        values.push(...response.locators.map((locator) => ({ humanEndpointId, locator })))
        cursor = response.nextCursor
        pageCount += 1
        if (pageCount > 1_000) throw new Error('Endpoint locator pagination exceeded the safe page limit.')
      } while (cursor)
      return values
    })
    await this.options.store.transact((draft) => {
      draft.endpointLocators = [
        ...draft.endpointLocators.filter((item) => item.humanEndpointId !== humanEndpointId),
        ...locators
      ]
    })
    return locators.length
  }

  async refreshManagedContainers(): Promise<readonly ManagedProviderContainer[]> {
    const response = await this.executeAsUser(restRequestSchema.parse({
      protocolVersion: '1.0',
      requestId: collaborationRequestId(),
      type: 'managed_container.list'
    }))
    if (response.type === 'rest.error') throw new Error(response.error.message)
    if (response.type !== 'rest.collection' || response.items.some((item) => item.type !== 'managed_provider_container')) {
      throw new Error(`Managed Channel query returned unexpected ${response.type}.`)
    }
    const managedContainers = response.items.filter((item): item is ManagedProviderContainer => (
      item.type === 'managed_provider_container'
    ))
    await this.options.store.transact((draft) => { draft.managedContainers = managedContainers })
    return managedContainers
  }

  private async pollLoop(credential: Readonly<{ value: string }>, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await delay(15_000, signal).catch(() => undefined)
      if (signal.aborted) return
      try {
        await this.heartbeat(credential, 'online')
        await this.refreshCapabilityProfile(credential)
        await this.pullInbox(credential)
        this.connectionState = {
          state: 'connected',
          lastConnectedAt: this.now().toISOString()
        }
        this.options.outbox.start()
      } catch (error) {
        this.recordError(error, true)
      }
    }
  }

  private async heartbeat(
    credential: Readonly<{ value: string }>,
    connectionStatus: 'online' | 'offline',
    bcEnabled = this.bcCapabilitiesEnabled
  ): Promise<void> {
    const settings = await this.options.settings.require()
    const agent = this.options.store.snapshot().agents.find((candidate) => (
      candidate.agentId === settings.agentId
    ))
    if (!agent || agent.lifecycleStatus !== 'active') {
      throw new Error('This installation has no active collaboration Agent registration.')
    }
    const capabilities = this.desiredCapabilities(agent.capabilities, bcEnabled)
    const response = await this.requireClient().execute(restRequestSchema.parse({
      protocolVersion: '1.0',
      requestId: collaborationRequestId(),
      type: 'agent.heartbeat',
      idempotencyKey: `idem_agent.heartbeat.${digest([
        agent.agentId,
        String(agent.revision),
        connectionStatus,
        capabilities.join(',')
      ].join('\u0000')).slice(0, 48)}`,
      agentId: agent.agentId,
      expectedRevision: agent.revision,
      connectionStatus,
      capabilities
    }), credential)
    if (response.type === 'rest.error') throw new Error(response.error.message)
    if (
      response.type !== 'rest.entity' ||
      response.entity.type !== 'agent_node' ||
      response.entity.agentId !== agent.agentId ||
      response.entity.ownerUserId !== agent.ownerUserId
    ) {
      throw new Error(`Agent heartbeat returned an invalid response (${response.type}).`)
    }
    const updatedAgent = response.entity
    await this.options.store.transact((draft) => {
      draft.agents = replaceBy(draft.agents, updatedAgent, (item) => item.agentId)
    })
  }

  private async notificationLoop(
    client: CollaborationCloudClient,
    credential: Readonly<{ value: string }>,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const event of client.observeAgentInbox(credential, signal)) {
          if (event.type === 'inbox.available' && event.recipientType === 'agent') {
            await this.pullInbox(credential)
          }
          if (event.type === 'connection.error') throw new Error(event.error.message)
        }
        if (!signal.aborted) {
          this.connectionState = {
            state: 'recovering',
            lastConnectedAt: this.connectionState.lastConnectedAt,
            lastError: 'Collaboration event stream closed.'
          }
          await delay(5_000, signal).catch(() => undefined)
        }
      } catch (error) {
        if (signal.aborted) return
        this.connectionState = {
          state: 'recovering',
          lastConnectedAt: this.connectionState.lastConnectedAt,
          lastError: safeError(error, this.options.sanitizeText)
        }
        await delay(5_000, signal).catch(() => undefined)
      }
    }
  }

  private pullInbox(credential: Readonly<{ value: string }>): Promise<void> {
    const drain = async () => {
      const afterSequence = this.options.store.snapshot().lastInboxSequence
      const page = await this.requireClient().pullAgentInbox({
        afterSequence,
        limit: 100,
        credential
      })
      const sorted = [...page.messages].sort((left, right) => left.sequence - right.sequence)
      const localAgentId = (await this.options.settings.require()).agentId
      for (const message of sorted) {
        if (message.recipientType !== 'agent') continue
        if (!localAgentId || message.recipientAgentId !== localAgentId) {
          throw new Error('Cloud returned an inbox message for another Agent.')
        }
        if (message.sequence <= this.options.store.snapshot().lastInboxSequence) continue
        await this.options.inboxHandler.handle(message)
        await this.persistInboxAck(message)
      }
    }
    // A rejected event must stop this cursor advance, but it must not poison
    // the serialized pull tail forever. Explicit recovery can re-fetch the same
    // unacknowledged event after the authorization/binding issue is repaired.
    this.pullTail = this.pullTail.then(drain, drain)
    return this.pullTail
  }

  private async wakeInbox(): Promise<void> {
    if (!this.client) return
    const credential = await this.options.packageSecrets.read(COLLABORATION_DEVICE_CREDENTIAL_KEY)
    if (!credential) return
    await this.pullInbox({ value: credential }).catch((error) => this.recordError(error, true))
  }

  private desiredCapabilities(
    capabilities: readonly string[],
    bcEnabled = this.bcCapabilitiesEnabled
  ): string[] {
    const desired = new Set(capabilities.filter((capability) => (
      capability !== WORKER_CAPABILITY && capability !== COORDINATOR_CAPABILITY
    )))
    if (bcEnabled) {
      desired.add(WORKER_CAPABILITY)
      desired.add(COORDINATOR_CAPABILITY)
    }
    return [...desired].sort()
  }

  private refreshCapabilityProfile(
    credential: Readonly<{ value: string }>,
    force = false
  ): Promise<void> {
    const report = () => this.reportCapabilityProfile(credential, force)
    this.profileTail = this.profileTail.then(report, report)
    return this.profileTail
  }

  private async reportCapabilityProfile(
    credential: Readonly<{ value: string }>,
    force: boolean
  ): Promise<void> {
    let settings = await this.options.settings.require()
    if (settings.pendingCapabilityProfileReport) {
      await this.sendCapabilityProfileReport(settings.pendingCapabilityProfileReport, credential)
      if (!force) return
      settings = await this.options.settings.require()
    }
    const refreshBefore = this.now().getTime() + 30 * 60_000
    if (
      !force &&
      settings.capabilityProfileExpiresAt &&
      Date.parse(settings.capabilityProfileExpiresAt) > refreshBefore
    ) return
    const agent = this.options.store.snapshot().agents.find((candidate) => (
      candidate.agentId === settings.agentId && candidate.lifecycleStatus === 'active'
    ))
    if (!agent) throw new Error('Capability reporting requires the active local Agent.')
    const reportedAt = this.now().toISOString()
    const expiresAt = new Date(this.now().getTime() + 6 * 60 * 60_000).toISOString()
    const profile = {
      agentId: agent.agentId,
      ownerUserId: agent.ownerUserId,
      nodeType: agent.nodeType === 'server'
        ? 'institution_server' as const
        : 'personal_computer' as const,
      os: localOperatingSystem(),
      runtimeIds: ['sciforge.desktop'],
      capabilities: this.desiredCapabilities(agent.capabilities).map((capabilityId) => ({
        capabilityId,
        evidence: {
          level: 'configured' as const,
          checkedAt: reportedAt,
          summary: 'Enabled by the local SciForge package composition.'
        }
      })),
      gpu: [],
      vpnAccessIds: [],
      slurmClusterIds: [],
      accessibleResourceRefIds: [],
      resultReturnPolicy: {
        summary: true as const,
        evidenceRefs: true,
        resourceRefs: true,
        logSummary: true,
        fullFileRequiresConfirmation: true as const,
        fullLogRequiresConfirmation: true as const
      },
      reportedAt,
      expiresAt
    }
    const request = restRequestSchema.parse({
      protocolVersion: '1.0',
      requestId: collaborationRequestId(),
      type: 'agent.capability_profile.report',
      idempotencyKey: capabilityProfileIdempotencyKey(profile, settings.capabilityProfileRevision ?? 0),
      expectedProfileRevision: settings.capabilityProfileRevision ?? 0,
      profile
    })
    await this.options.settings.stageCapabilityProfileReport(request)
    try {
      await this.sendCapabilityProfileReport(request, credential)
    } catch (error) {
      const conflict = error instanceof CloudProtocolError &&
        error.code === 'revision_conflict' &&
        typeof error.currentRevision === 'number'
        ? new CapabilityProfileRevisionConflictError(error.currentRevision)
        : error
      if (!(conflict instanceof CapabilityProfileRevisionConflictError)) throw conflict
      const retryRequest = restRequestSchema.parse({
        ...request,
        requestId: collaborationRequestId(),
        idempotencyKey: capabilityProfileIdempotencyKey(profile, conflict.currentRevision),
        expectedProfileRevision: conflict.currentRevision
      })
      await this.options.settings.stageCapabilityProfileReport(retryRequest)
      await this.sendCapabilityProfileReport(retryRequest, credential)
    }
  }

  private async sendCapabilityProfileReport(
    rawRequest: unknown,
    credential: Readonly<{ value: string }>
  ): Promise<void> {
    const request = restRequestSchema.parse(rawRequest)
    if (request.type !== 'agent.capability_profile.report') {
      throw new Error('Pending C capability report has an invalid command type.')
    }
    const response = await this.requireClient().execute(request, credential)
    if (response.type === 'rest.error') {
      if (
        response.error.code === 'revision_conflict' &&
        typeof response.error.currentRevision === 'number' &&
        response.error.message.toLowerCase().includes('capability profile revision')
      ) {
        throw new CapabilityProfileRevisionConflictError(response.error.currentRevision)
      }
      throw new Error(response.error.message)
    }
    if (
      response.type !== 'rest.entity' ||
      response.entity.type !== 'agent_capability_profile' ||
      response.entity.agentId !== request.profile.agentId ||
      response.entity.ownerUserId !== request.profile.ownerUserId
    ) {
      throw new Error(`Capability report returned an invalid response (${response.type}).`)
    }
    await this.options.settings.completeCapabilityProfileReport(
      response.entity.revision,
      response.entity.expiresAt
    )
  }

  private async persistInboxAck(message: AgentInboxMessage): Promise<void> {
    const idempotencyKey = `idem_inbox.ack.${digest(message.inboxMessageId).slice(0, 48)}`
    const request = restRequestSchema.parse({
      protocolVersion: '1.0',
      requestId: collaborationRequestId(),
      type: 'inbox.ack',
      idempotencyKey,
      inboxMessageId: message.inboxMessageId,
      sequence: message.sequence
    })
    await this.options.store.transact((draft) => {
      if (message.sequence !== draft.lastInboxSequence + 1 && draft.lastInboxSequence !== 0) {
        throw new Error('Agent inbox sequence contains a gap.')
      }
      draft.lastInboxSequence = message.sequence
      if (draft.outbox.some((entry) => entry.idempotencyKey === idempotencyKey)) return
      const now = this.now().toISOString()
      draft.outbox.push({
        outboxId: `obx_${randomUUID().replaceAll('-', '')}`,
        idempotencyKey,
        kind: 'inbox.ack',
        body: request,
        state: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now
      })
    })
    this.options.outbox.wake()
  }

  private requireClient(): CollaborationCloudClient {
    if (!this.client) throw new Error('Collaboration service is not configured.')
    return this.client
  }

  private async resetCloudProjectionState(): Promise<void> {
    await this.options.store.transact((draft) => {
      const empty = structuredClone(EMPTY_COLLABORATION_LOCAL_STATE)
      draft.lastInboxSequence = empty.lastInboxSequence
      delete draft.user
      delete draft.participant
      draft.endpoints = empty.endpoints
      draft.endpointLocators = empty.endpointLocators
      draft.agents = empty.agents
      draft.projections = empty.projections
      draft.projects = empty.projects
      draft.tasks = empty.tasks
      draft.taskRuns = empty.taskRuns
      draft.queue = empty.queue
      draft.receipts = empty.receipts
      draft.outbox = empty.outbox
      draft.diagnostics = empty.diagnostics
    })
  }

  private withFreshUserCredential<Result>(
    operation: (
      credential: Readonly<{ value: string }>,
      snapshot: IdentityCloudSessionSnapshot
    ) => Result | Promise<Result>
  ): Promise<Result> {
    return this.options.cloudIdentitySession.withFreshAccessToken(({ accessToken, snapshot }) => (
      operation({ value: accessToken }, snapshot)
    ))
  }

  private async requireDeviceCredential(): Promise<Readonly<{ value: string }>> {
    const value = await this.options.packageSecrets.read(COLLABORATION_DEVICE_CREDENTIAL_KEY)
    if (!value) throw new Error('Agent credential is unavailable.')
    return { value }
  }

  private recordError(error: unknown, recoverable: boolean): void {
    const message = safeError(error, this.options.sanitizeText)
    this.connectionState = {
      state: 'error',
      lastConnectedAt: this.connectionState.lastConnectedAt,
      lastError: message
    }
    void this.options.store.transact((draft) => {
      draft.diagnostics = [...draft.diagnostics, {
        code: 'collaboration.connection_error',
        severity: 'error' as const,
        message,
        occurredAt: this.now().toISOString(),
        recoverable
      }].slice(-256)
    }).catch(() => undefined)
  }
}

function localOperatingSystem(): Readonly<{
  family: 'windows' | 'macos' | 'linux'
  architecture: 'x64' | 'arm64'
}> {
  return {
    family: process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'macos'
        : 'linux',
    architecture: process.arch === 'arm64' ? 'arm64' : 'x64'
  }
}

function mapAssurance(value: HumanEndpointBinding['assurance']): 'low' | 'verified' | 'strong' {
  if (value === 'strong') return 'strong'
  return value === 'verified' ? 'verified' : 'low'
}

function replaceBy<Value>(
  values: readonly Value[],
  replacement: Value,
  id: (value: Value) => string
): Value[] {
  return [...values.filter((value) => id(value) !== id(replacement)), replacement]
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timeout = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timeout)
      reject(signal.reason)
    }, { once: true })
  })
}

function safeError(error: unknown, sanitizeText?: (value: string) => string): string {
  const value = error instanceof Error ? error.message : 'Collaboration connection failed.'
  return (sanitizeText?.(value) ?? value)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu, '[REDACTED]')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu, '[REDACTED]')
    .slice(0, 4_000)
}

export function isIdempotentWriteRequest(request: RestRequest): request is RestRequest & { idempotencyKey: string } {
  return 'idempotencyKey' in request
}
