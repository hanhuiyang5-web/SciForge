import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

import {
  deserializePortableResourceReferenceCarrier,
  serializePortableResourceReferenceCarrier
} from '@sciforge/collaboration-contracts'

import { CollaborationServiceError } from './errors.js'
import { newId, safeAuditMetadata } from './crypto.js'
import type {
  InboxRecipient,
  StoredAgent,
  StoredAgentCapabilityProfile,
  StoredActionConfirmation,
  StoredAuditEvent,
  StoredChallenge,
  StoredCredential,
  StoredDevice,
  StoredDeviceEnrollment,
  StoredEndpoint,
  StoredExternalIdentity,
  StoredInboxCursor,
  StoredInboxMessage,
  StoredParticipant,
  StoredProject,
  StoredProjectContentSpaceBinding,
  StoredProjectEndpointBinding,
  StoredProjectInput,
  StoredProjectMember,
  StoredProjectRecord,
  StoredResourceRef,
  StoredProjection,
  StoredReceipt,
  StoredTask,
  StoredUser,
  StoredOidcIdentity,
  StoredZulipBindingRequest,
  StoredHumanRequest,
  StoredHumanAnswer,
  StoredManagedContainer,
  StoredManagedContainerJob,
  WorkerDirectoryEntryView
} from './model.js'
import type {
  ActiveProjectMembershipCount,
  CollaborationReadRepository,
  CollaborationRepository,
  CollaborationTransaction,
  PortalProjectWakeWatermarks,
  ProjectCoordinationMaterializationBytes,
  ProjectCoordinationMaterializationCounts,
  ProjectMemberRemovalBlockers,
  ProjectSummaryPage,
  ProjectSummaryPageQuery,
  WorkerDirectoryPageQuery,
  WorkerDirectoryRepositoryPage
} from './repository.js'

type SqlRow = Record<string, unknown>
type QueryResult<T extends SqlRow = SqlRow> = { rows: T[]; rowCount: number | null }

export interface SqlConnection {
  query<T extends SqlRow = SqlRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>
  release(): void
}

export interface SqlPool {
  query<T extends SqlRow = SqlRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>
  connect(): Promise<SqlConnection>
  end(): Promise<void>
}

export type PostgresRepositoryOptions = {
  connectionString: string
  maxConnections?: number
  statementTimeoutMs?: number
  onPoolDiagnostic?: (diagnostic: PostgresPoolDiagnostic) => void
}

export type PostgresPoolDiagnostic = {
  event: 'postgres.pool.idle_client_error'
  postgresCode: string | 'unknown'
  retryable: boolean
}

export function createPostgresPool(options: PostgresRepositoryOptions): SqlPool {
  const require = createRequire(import.meta.url)
  type EventedSqlPool = SqlPool & {
    on(event: 'error', listener: (error: unknown) => void): EventedSqlPool
  }
  const postgres = require('pg') as {
    Pool: new (config: Record<string, unknown>) => EventedSqlPool
  }
  const pool = new postgres.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    application_name: 'sciforge-collaboration-server'
  })
  pool.on('error', (error) => {
    const diagnostic = createPostgresPoolDiagnostic(error)
    try {
      options.onPoolDiagnostic?.(diagnostic)
    } catch {
      // Diagnostics must never turn a recoverable idle-client failure into a process failure.
    }
  })
  return pool
}

export function formatPostgresPoolDiagnostic(
  diagnostic: PostgresPoolDiagnostic,
  occurredAt: Date = new Date()
): string {
  const postgresCode = isPostgresSqlState(diagnostic.postgresCode) ? diagnostic.postgresCode : 'unknown'
  return `${JSON.stringify({
    occurredAt: occurredAt.toISOString(),
    level: 'error',
    component: 'postgres',
    event: 'postgres.pool.idle_client_error',
    postgresCode,
    retryable: isRetryablePostgresPoolError(postgresCode)
  })}\n`
}

function createPostgresPoolDiagnostic(error: unknown): PostgresPoolDiagnostic {
  const postgresCode = postgresSqlState(error)
  return {
    event: 'postgres.pool.idle_client_error',
    postgresCode,
    retryable: isRetryablePostgresPoolError(postgresCode)
  }
}

function postgresSqlState(error: unknown): string | 'unknown' {
  try {
    if (typeof error !== 'object' || error === null) return 'unknown'
    const code = Reflect.get(error, 'code')
    return isPostgresSqlState(code) ? code : 'unknown'
  } catch {
    return 'unknown'
  }
}

function isPostgresSqlState(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Z]{5}$/u.test(value)
}

function isRetryablePostgresPoolError(postgresCode: string | 'unknown'): boolean {
  return postgresCode.startsWith('08') || postgresCode === '57P01' || postgresCode === '57P02' || postgresCode === '57P03'
}

export class PostgresCollaborationRepository implements CollaborationRepository {
  constructor(private readonly pool: SqlPool) {}

  async transaction<T>(work: (tx: CollaborationTransaction) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect()
    try {
      await connection.query('BEGIN')
      const result = await work(new PostgresTransaction(connection))
      await connection.query('COMMIT')
      return result
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined)
      throw translateDatabaseError(error)
    } finally {
      connection.release()
    }
  }

  async readSnapshot<T>(work: (repository: CollaborationReadRepository) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect()
    try {
      await connection.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const result = await work(new PostgresReadRepository(connection))
      await connection.query('COMMIT')
      return result
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined)
      throw translateDatabaseError(error)
    } finally {
      connection.release()
    }
  }

  async pruneExpired(now: string): Promise<{
    inboxMessages: number
    receipts: number
    challenges: number
    humanRequests: number
  }> {
    return this.transaction(async (tx) => {
      const sql = (tx as PostgresTransaction).sql
      await sql.query(
        `UPDATE sciforge_collaboration.device_enrollments
         SET status='expired',revision=revision+1,updated_at=$1
         WHERE status='pending' AND expires_at<=$1`,
        [now]
      )
      await sql.query(
        `UPDATE sciforge_collaboration.zulip_binding_requests
         SET status='expired',revision=revision+1,updated_at=$1
         WHERE status='pending' AND expires_at<=$1`,
        [now]
      )
      const humanRequests = await sql.query(
        `UPDATE sciforge_collaboration.human_requests
         SET status='expired',revision=revision+1,updated_at=$1
         WHERE status='pending' AND expires_at<=$1`,
        [now]
      )
      await sql.query(
        `UPDATE sciforge_collaboration.action_confirmations
         SET status='superseded',updated_at=$1
         WHERE status='approved' AND expires_at<=$1`,
        [now]
      )
      await sql.query(
        `UPDATE sciforge_collaboration.inbox_messages AS message
         SET disposition='superseded',superseded_at=$1
         FROM sciforge_collaboration.inbox_cursors AS cursor
         WHERE message.recipient_kind=cursor.recipient_kind
           AND message.recipient_id=cursor.recipient_id
           AND message.sequence>cursor.acked_sequence
           AND message.expires_at<=$1
           AND message.disposition='active'`,
        [now]
      )
      const inbox = await sql.query(
        `DELETE FROM sciforge_collaboration.inbox_messages AS message
         USING sciforge_collaboration.inbox_cursors AS cursor
         WHERE message.recipient_kind=cursor.recipient_kind
           AND message.recipient_id=cursor.recipient_id
           AND message.sequence<=cursor.acked_sequence
           AND message.expires_at<=$1`,
        [now]
      )
      const receipts = await sql.query(
        `DELETE FROM sciforge_collaboration.receipts WHERE expires_at < $1`,
        [now]
      )
      const challenges = await sql.query(
        `DELETE FROM sciforge_collaboration.human_endpoint_challenges
         WHERE expires_at < $1`,
        [now]
      )
      return {
        inboxMessages: inbox.rowCount ?? 0,
        receipts: receipts.rowCount ?? 0,
        challenges: challenges.rowCount ?? 0,
        humanRequests: humanRequests.rowCount ?? 0
      }
    })
  }

  close(): Promise<void> {
    return this.pool.end()
  }

  private read(): PostgresReadRepository {
    return new PostgresReadRepository(this.pool)
  }

  getUser(userId: string): Promise<StoredUser | null> { return this.read().getUser(userId) }
  getOidcIdentity(identityId: string): Promise<StoredOidcIdentity | null> {
    return this.read().getOidcIdentity(identityId)
  }
  getOidcIdentityByIssuerSubject(issuer: string, subject: string): Promise<StoredOidcIdentity | null> {
    return this.read().getOidcIdentityByIssuerSubject(issuer, subject)
  }
  hasActiveOidcIdentityForUser(userId: string, issuer: string): Promise<boolean> {
    return this.read().hasActiveOidcIdentityForUser(userId, issuer)
  }
  getDeviceEnrollment(enrollmentId: string): Promise<StoredDeviceEnrollment | null> {
    return this.read().getDeviceEnrollment(enrollmentId)
  }
  getDevice(deviceId: string): Promise<StoredDevice | null> { return this.read().getDevice(deviceId) }
  getDeviceByInstallation(installationId: string): Promise<StoredDevice | null> {
    return this.read().getDeviceByInstallation(installationId)
  }
  listDevicesForUser(userId: string): Promise<StoredDevice[]> { return this.read().listDevicesForUser(userId) }
  getZulipBindingRequest(bindingRequestId: string): Promise<StoredZulipBindingRequest | null> {
    return this.read().getZulipBindingRequest(bindingRequestId)
  }
  getZulipBindingRequestByCodeDigest(codeDigest: string): Promise<StoredZulipBindingRequest | null> {
    return this.read().getZulipBindingRequestByCodeDigest(codeDigest)
  }
  getZulipBindingRequestByProviderEvent(providerEventId: string): Promise<StoredZulipBindingRequest | null> {
    return this.read().getZulipBindingRequestByProviderEvent(providerEventId)
  }
  getExternalIdentity(externalIdentityId: string): Promise<StoredExternalIdentity | null> {
    return this.read().getExternalIdentity(externalIdentityId)
  }
  getExternalIdentityByProviderIdentity(realmId: string, zulipUserId: string): Promise<StoredExternalIdentity | null> {
    return this.read().getExternalIdentityByProviderIdentity(realmId, zulipUserId)
  }
  listExternalIdentitiesForUser(userId: string): Promise<StoredExternalIdentity[]> {
    return this.read().listExternalIdentitiesForUser(userId)
  }
  getEndpoint(id: string): Promise<StoredEndpoint | null> { return this.read().getEndpoint(id) }
  getEndpointByProviderIdentity(provider: string, realmId: string, providerUserId: string): Promise<StoredEndpoint | null> {
    return this.read().getEndpointByProviderIdentity(provider, realmId, providerUserId)
  }
  getAgent(agentId: string): Promise<StoredAgent | null> { return this.read().getAgent(agentId) }
  getAgentByInstallation(id: string): Promise<StoredAgent | null> { return this.read().getAgentByInstallation(id) }
  getParticipant(userId: string): Promise<StoredParticipant | null> { return this.read().getParticipant(userId) }
  listEndpointsForUser(userId: string): Promise<StoredEndpoint[]> { return this.read().listEndpointsForUser(userId) }
  listAgentsForUser(userId: string): Promise<StoredAgent[]> { return this.read().listAgentsForUser(userId) }
  listUsableOwnedAgentsBounded(userId: string, limit: number): Promise<StoredAgent[]> {
    return this.read().listUsableOwnedAgentsBounded(userId, limit)
  }
  listAllAgents(): Promise<StoredAgent[]> { return this.read().listAllAgents() }
  listAgentsForDevice(deviceId: string): Promise<StoredAgent[]> { return this.read().listAgentsForDevice(deviceId) }
  getAgentCapabilityProfile(agentId: string): Promise<StoredAgentCapabilityProfile | null> {
    return this.read().getAgentCapabilityProfile(agentId)
  }
  getProjection(id: string): Promise<StoredProjection | null> { return this.read().getProjection(id) }
  getProjectionByLocator(provider: string, realmId: string, containerId: string, topicId: string): Promise<StoredProjection | null> {
    return this.read().getProjectionByLocator(provider, realmId, containerId, topicId)
  }
  listProjectionsForOwner(userId: string): Promise<StoredProjection[]> { return this.read().listProjectionsForOwner(userId) }
  getManagedContainer(id: string): Promise<StoredManagedContainer | null> { return this.read().getManagedContainer(id) }
  getManagedContainerForOwner(ownerUserId: string, provider: string, realmId: string): Promise<StoredManagedContainer | null> {
    return this.read().getManagedContainerForOwner(ownerUserId, provider, realmId)
  }
  listManagedContainersForOwner(ownerUserId: string): Promise<StoredManagedContainer[]> {
    return this.read().listManagedContainersForOwner(ownerUserId)
  }
  getProjectEndpointBinding(projectId: string): Promise<StoredProjectEndpointBinding | null> { return this.read().getProjectEndpointBinding(projectId) }
  getProjectEndpointBindingById(id: string): Promise<StoredProjectEndpointBinding | null> {
    return this.read().getProjectEndpointBindingById(id)
  }
  getProjectBindingByLocator(provider: string, realmId: string, containerId: string, topicId: string): Promise<StoredProjectEndpointBinding | null> {
    return this.read().getProjectBindingByLocator(provider, realmId, containerId, topicId)
  }
  getProjectContentSpaceBinding(projectId: string): Promise<StoredProjectContentSpaceBinding | null> {
    return this.read().getProjectContentSpaceBinding(projectId)
  }
  getActiveProjectContentSpaceBindingByRootReferenceDigest(
    rootReferenceDigest: string
  ): Promise<StoredProjectContentSpaceBinding | null> {
    return this.read().getActiveProjectContentSpaceBindingByRootReferenceDigest(rootReferenceDigest)
  }
  getProjectInputByProviderMessage(endpointId: string, messageId: string): Promise<StoredProjectInput | null> {
    return this.read().getProjectInputByProviderMessage(endpointId, messageId)
  }
  getHumanRequest(id: string): Promise<StoredHumanRequest | null> { return this.read().getHumanRequest(id) }
  getHumanAnswerForRequest(id: string): Promise<StoredHumanAnswer | null> { return this.read().getHumanAnswerForRequest(id) }
  listHumanRequestsForProject(projectId: string): Promise<StoredHumanRequest[]> {
    return this.read().listHumanRequestsForProject(projectId)
  }
  listHumanAnswersForProject(projectId: string): Promise<StoredHumanAnswer[]> {
    return this.read().listHumanAnswersForProject(projectId)
  }
  getProject(projectId: string): Promise<StoredProject | null> { return this.read().getProject(projectId) }
  listProjectsForUser(userId: string): Promise<StoredProject[]> { return this.read().listProjectsForUser(userId) }
  listProjectSummaryPageForUser(input: ProjectSummaryPageQuery): Promise<ProjectSummaryPage> {
    return this.read().listProjectSummaryPageForUser(input)
  }
  listActiveProjectsForCoordinator(agentId: string): Promise<StoredProject[]> {
    return this.read().listActiveProjectsForCoordinator(agentId)
  }
  getProjectMember(projectId: string, userId: string): Promise<StoredProjectMember | null> {
    return this.read().getProjectMember(projectId, userId)
  }
  listProjectMembers(projectId: string): Promise<StoredProjectMember[]> { return this.read().listProjectMembers(projectId) }
  listProjectMembersByUserIds(projectId: string, userIds: readonly string[]): Promise<StoredProjectMember[]> {
    return this.read().listProjectMembersByUserIds(projectId, userIds)
  }
  listActiveProjectMembersBounded(projectId: string, limit: number): Promise<StoredProjectMember[]> {
    return this.read().listActiveProjectMembersBounded(projectId, limit)
  }
  countActiveProjectMembers(projectId: string): Promise<number> {
    return this.read().countActiveProjectMembers(projectId)
  }
  getProjectMemberRemovalBlockers(
    projectId: string,
    userIds: readonly string[],
    now: string
  ): Promise<ProjectMemberRemovalBlockers> {
    return this.read().getProjectMemberRemovalBlockers(projectId, userIds, now)
  }
  listActiveProjectMemberViewsBounded(
    projectId: string,
    limit: number
  ): Promise<Array<StoredProjectMember & { displayName: string }>> {
    return this.read().listActiveProjectMemberViewsBounded(projectId, limit)
  }
  getProjectCoordinationMaterializationCounts(
    projectId: string
  ): Promise<ProjectCoordinationMaterializationCounts> {
    return this.read().getProjectCoordinationMaterializationCounts(projectId)
  }
  getProjectCoordinationMaterializationBytes(
    projectId: string
  ): Promise<ProjectCoordinationMaterializationBytes> {
    return this.read().getProjectCoordinationMaterializationBytes(projectId)
  }
  countProjectRecords(projectId: string): Promise<number> {
    return this.read().countProjectRecords(projectId)
  }
  countProjectHumanRequests(projectId: string): Promise<number> {
    return this.read().countProjectHumanRequests(projectId)
  }
  countProjectTasks(projectId: string, round?: number): Promise<number> { return this.read().countProjectTasks(projectId, round) }
  countOpenProjectTasks(projectId: string): Promise<number> { return this.read().countOpenProjectTasks(projectId) }
  countOpenProjectFileTasks(projectId: string): Promise<number> {
    return this.read().countOpenProjectFileTasks(projectId)
  }
  listOpenTasksForAgent(agentId: string): Promise<StoredTask[]> { return this.read().listOpenTasksForAgent(agentId) }
  getTask(taskId: string): Promise<StoredTask | null> { return this.read().getTask(taskId) }
  listProjectTasks(projectId: string): Promise<StoredTask[]> { return this.read().listProjectTasks(projectId) }
  listProjectTasksBounded(projectId: string, afterTaskId: string | undefined, limit: number): Promise<StoredTask[]> {
    return this.read().listProjectTasksBounded(projectId, afterTaskId, limit)
  }
  getProjectRecord(id: string): Promise<StoredProjectRecord | null> { return this.read().getProjectRecord(id) }
  getTaskResultForExecution(taskId: string, executionId: string): Promise<StoredProjectRecord | null> {
    return this.read().getTaskResultForExecution(taskId, executionId)
  }
  listProjectRecords(projectId: string, acceptedOnly: boolean): Promise<StoredProjectRecord[]> {
    return this.read().listProjectRecords(projectId, acceptedOnly)
  }
  listProjectRecordsBounded(
    projectId: string,
    afterProjectRecordId: string | undefined,
    limit: number
  ): Promise<StoredProjectRecord[]> {
    return this.read().listProjectRecordsBounded(projectId, afterProjectRecordId, limit)
  }
  listTargetHumanRequestsForProjectBounded(
    projectId: string,
    targetUserId: string,
    afterHumanRequestId: string | undefined,
    limit: number
  ): Promise<StoredHumanRequest[]> {
    return this.read().listTargetHumanRequestsForProjectBounded(projectId, targetUserId, afterHumanRequestId, limit)
  }
  getPortalProjectWakeWatermarks(projectId: string, targetUserId: string): Promise<PortalProjectWakeWatermarks> {
    return this.read().getPortalProjectWakeWatermarks(projectId, targetUserId)
  }
  getWorkerDirectoryPage(input: WorkerDirectoryPageQuery): Promise<WorkerDirectoryRepositoryPage> {
    return this.read().getWorkerDirectoryPage(input)
  }
  getResourceRef(id: string): Promise<StoredResourceRef | null> { return this.read().getResourceRef(id) }
  getCredential(id: string): Promise<StoredCredential | null> { return this.read().getCredential(id) }
  getCredentialByDigest(digest: string): Promise<StoredCredential | null> { return this.read().getCredentialByDigest(digest) }
  getReceipt(actorKey: string, key: string): Promise<StoredReceipt | null> { return this.read().getReceipt(actorKey, key) }
  getReceiptById(receiptId: string): Promise<StoredReceipt | null> { return this.read().getReceiptById(receiptId) }
  getInboxCursor(recipient: InboxRecipient): Promise<StoredInboxCursor | null> { return this.read().getInboxCursor(recipient) }
  getInboxMessage(recipient: InboxRecipient, sequence: number): Promise<StoredInboxMessage | null> {
    return this.read().getInboxMessage(recipient, sequence)
  }
  getInboxMessageById(recipient: InboxRecipient, messageId: string): Promise<StoredInboxMessage | null> {
    return this.read().getInboxMessageById(recipient, messageId)
  }
  pullInbox(recipient: InboxRecipient, after: number, limit: number, now: string): Promise<StoredInboxMessage[]> {
    return this.read().pullInbox(recipient, after, limit, now)
  }
  getActionConfirmation(confirmationId: string): Promise<StoredActionConfirmation | null> {
    return this.read().getActionConfirmation(confirmationId)
  }

  async claimManagedContainerJobs(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    limit: number
  ): Promise<StoredManagedContainerJob[]> {
    return this.transaction(async (tx) => {
      const sql = (tx as PostgresTransaction).sql
      const result = await sql.query(
        `WITH candidates AS (
           SELECT job_id
           FROM sciforge_collaboration.managed_provider_container_jobs
           WHERE state IN ('queued', 'retry_wait', 'running')
             AND next_attempt_at <= $2
             AND (state <> 'running' OR lease_expires_at <= $2)
           ORDER BY next_attempt_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT $4
         )
         UPDATE sciforge_collaboration.managed_provider_container_jobs AS jobs
         SET state = 'running', lease_owner = $1, lease_expires_at = $3,
             attempt_count = jobs.attempt_count + 1, updated_at = $2
         FROM candidates
         WHERE jobs.job_id = candidates.job_id
         RETURNING jobs.*`,
        [workerId, now, leaseExpiresAt, limit]
      )
      return result.rows.map(mapManagedContainerJob)
    })
  }

  async completeManagedContainerJob(input: {
    jobId: string
    workerId: string
    expectedAttemptCount: number
    container: StoredManagedContainer
    expectedContainerRevision: number
    completedAt: string
  }): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.updateManagedContainer(input.container, input.expectedContainerRevision)
      const sql = (tx as PostgresTransaction).sql
      const result = await sql.query(
        `UPDATE sciforge_collaboration.managed_provider_container_jobs
         SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
             safe_error_code = NULL, updated_at = $3
         WHERE job_id = $1 AND state = 'running' AND lease_owner = $2 AND attempt_count = $4`,
        [input.jobId, input.workerId, input.completedAt, input.expectedAttemptCount]
      )
      if (result.rowCount !== 1) throw new CollaborationServiceError('revision_conflict', 'Managed container job lease was lost.')
      await tx.insertAudit({
        auditEventId: newId('audit'), actorKind: 'system', action: 'managed_container.job.succeeded',
        resourceKind: 'managed_provider_container', resourceId: input.container.managedContainerId,
        outcome: 'accepted', metadata: safeAuditMetadata({ jobId: input.jobId }), createdAt: input.completedAt
      })
    })
  }

  async failManagedContainerJob(input: {
    jobId: string
    workerId: string
    expectedAttemptCount: number
    safeErrorCode: string
    retryAt?: string
    failedAt: string
    container?: StoredManagedContainer
    expectedContainerRevision?: number
  }): Promise<void> {
    await this.transaction(async (tx) => {
      if (input.container && input.expectedContainerRevision !== undefined) {
        await tx.updateManagedContainer(input.container, input.expectedContainerRevision)
      }
      const sql = (tx as PostgresTransaction).sql
      const result = await sql.query(
        `UPDATE sciforge_collaboration.managed_provider_container_jobs
         SET state = $3, next_attempt_at = COALESCE($4, next_attempt_at),
             lease_owner = NULL, lease_expires_at = NULL, safe_error_code = $5, updated_at = $6
         WHERE job_id = $1 AND state = 'running' AND lease_owner = $2 AND attempt_count = $7`,
        [input.jobId, input.workerId, input.retryAt ? 'retry_wait' : 'failed', input.retryAt ?? null,
          input.safeErrorCode, input.failedAt, input.expectedAttemptCount]
      )
      if (result.rowCount !== 1) throw new CollaborationServiceError('revision_conflict', 'Managed container job lease was lost.')
      await tx.insertAudit({
        auditEventId: newId('audit'), actorKind: 'system', action: input.retryAt
          ? 'managed_container.job.retry_scheduled'
          : 'managed_container.job.failed',
        resourceKind: 'managed_provider_container', resourceId: input.container?.managedContainerId,
        outcome: input.retryAt ? 'accepted' : 'rejected',
        metadata: safeAuditMetadata({ jobId: input.jobId, errorCode: input.safeErrorCode }),
        createdAt: input.failedAt
      })
    })
  }
}

class PostgresReadRepository implements CollaborationReadRepository {
  constructor(readonly sql: Pick<SqlPool, 'query'> | Pick<SqlConnection, 'query'>) {}

  async getUser(userId: string): Promise<StoredUser | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.user_principals WHERE user_id = $1`, [userId])
    return result.rows[0] ? mapUser(result.rows[0]) : null
  }

  async getOidcIdentity(identityId: string): Promise<StoredOidcIdentity | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.oidc_identities WHERE identity_id=$1`,
      [identityId]
    )
    return result.rows[0] ? mapOidcIdentity(result.rows[0]) : null
  }

  async getOidcIdentityByIssuerSubject(issuer: string, subject: string): Promise<StoredOidcIdentity | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.oidc_identities WHERE issuer=$1 AND subject=$2`,
      [issuer, subject]
    )
    return result.rows[0] ? mapOidcIdentity(result.rows[0]) : null
  }

  async hasActiveOidcIdentityForUser(userId: string, issuer: string): Promise<boolean> {
    const result = await this.sql.query<{ present: unknown }>(
      `SELECT EXISTS(
         SELECT 1 FROM sciforge_collaboration.oidc_identities
         WHERE user_id=$1 AND issuer=$2 AND status='active'
       ) AS present`,
      [userId, issuer]
    )
    return result.rows[0]?.present === true
  }

  async getDeviceEnrollment(enrollmentId: string): Promise<StoredDeviceEnrollment | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.device_enrollments WHERE enrollment_id=$1`,
      [enrollmentId]
    )
    return result.rows[0] ? mapDeviceEnrollment(result.rows[0]) : null
  }

  async getDevice(deviceId: string): Promise<StoredDevice | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.devices WHERE device_id=$1`, [deviceId])
    return result.rows[0] ? mapDevice(result.rows[0]) : null
  }

  async getDeviceByInstallation(installationId: string): Promise<StoredDevice | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.devices WHERE installation_id=$1`,
      [installationId]
    )
    return result.rows[0] ? mapDevice(result.rows[0]) : null
  }

  async listDevicesForUser(userId: string): Promise<StoredDevice[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.devices WHERE user_id=$1 ORDER BY created_at,device_id`,
      [userId]
    )
    return result.rows.map(mapDevice)
  }

  async getZulipBindingRequest(bindingRequestId: string): Promise<StoredZulipBindingRequest | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.zulip_binding_requests WHERE binding_request_id=$1`,
      [bindingRequestId]
    )
    return result.rows[0] ? mapZulipBindingRequest(result.rows[0]) : null
  }

  async getZulipBindingRequestByCodeDigest(codeDigest: string): Promise<StoredZulipBindingRequest | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.zulip_binding_requests WHERE code_digest=$1`,
      [Buffer.from(codeDigest, 'hex')]
    )
    return result.rows[0] ? mapZulipBindingRequest(result.rows[0]) : null
  }

  async getZulipBindingRequestByProviderEvent(providerEventId: string): Promise<StoredZulipBindingRequest | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.zulip_binding_requests WHERE provider_event_id=$1`,
      [providerEventId]
    )
    return result.rows[0] ? mapZulipBindingRequest(result.rows[0]) : null
  }

  async getExternalIdentity(externalIdentityId: string): Promise<StoredExternalIdentity | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.human_endpoint_bindings WHERE external_identity_id=$1`,
      [externalIdentityId]
    )
    return result.rows[0] ? mapExternalIdentity(result.rows[0]) : null
  }

  async getExternalIdentityByProviderIdentity(
    realmId: string,
    zulipUserId: string
  ): Promise<StoredExternalIdentity | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.human_endpoint_bindings
       WHERE provider='zulip' AND realm_id=$1 AND provider_user_id=$2
         AND external_identity_id IS NOT NULL AND status='active'`,
      [realmId, zulipUserId]
    )
    return result.rows[0] ? mapExternalIdentity(result.rows[0]) : null
  }

  async listExternalIdentitiesForUser(userId: string): Promise<StoredExternalIdentity[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.human_endpoint_bindings
       WHERE user_id=$1 AND provider='zulip' AND external_identity_id IS NOT NULL
       ORDER BY created_at,external_identity_id`,
      [userId]
    )
    return result.rows.map(mapExternalIdentity)
  }

  async getEndpoint(humanEndpointId: string): Promise<StoredEndpoint | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.human_endpoint_bindings WHERE human_endpoint_id = $1`, [humanEndpointId])
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null
  }

  async getEndpointByProviderIdentity(provider: string, realmId: string, providerUserId: string): Promise<StoredEndpoint | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.human_endpoint_bindings
       WHERE provider = $1 AND realm_id = $2 AND provider_user_id = $3 AND status='active'`,
      [provider, realmId, providerUserId]
    )
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null
  }

  async getAgent(agentId: string): Promise<StoredAgent | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.agent_nodes WHERE agent_id = $1`, [agentId])
    return result.rows[0] ? mapAgent(result.rows[0]) : null
  }

  async getAgentByInstallation(installationId: string): Promise<StoredAgent | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.agent_nodes WHERE installation_id = $1`, [installationId])
    return result.rows[0] ? mapAgent(result.rows[0]) : null
  }

  async getParticipant(userId: string): Promise<StoredParticipant | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.participant_profiles WHERE user_id = $1`, [userId])
    return result.rows[0] ? mapParticipant(result.rows[0]) : null
  }

  async listEndpointsForUser(userId: string): Promise<StoredEndpoint[]> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.human_endpoint_bindings WHERE user_id=$1 ORDER BY verified_at,human_endpoint_id`, [userId])
    return result.rows.map(mapEndpoint)
  }

  async listAgentsForUser(userId: string): Promise<StoredAgent[]> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.agent_nodes WHERE owner_user_id=$1 ORDER BY updated_at,agent_id`, [userId])
    return result.rows.map(mapAgent)
  }

  async listUsableOwnedAgentsBounded(userId: string, limit: number): Promise<StoredAgent[]> {
    const result = await this.sql.query(
      `SELECT agent.*
       FROM sciforge_collaboration.agent_nodes AS agent
       INNER JOIN sciforge_collaboration.user_principals AS owner
         ON owner.user_id=agent.owner_user_id AND owner.status='active'
       INNER JOIN sciforge_collaboration.devices AS device
         ON device.device_id=agent.device_id AND device.user_id=agent.owner_user_id AND device.status='active'
       WHERE agent.owner_user_id=$1 AND agent.status='active'
         AND agent.node_type IN ('desktop','server')
       ORDER BY agent.agent_id
       LIMIT $2`,
      [userId, boundedReadLimit(limit)]
    )
    return result.rows.map(mapAgent)
  }

  async listAllAgents(): Promise<StoredAgent[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.agent_nodes ORDER BY owner_user_id,agent_id`
    )
    return result.rows.map(mapAgent)
  }

  async listAgentsForDevice(deviceId: string): Promise<StoredAgent[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.agent_nodes WHERE device_id=$1 ORDER BY updated_at,agent_id`,
      [deviceId]
    )
    return result.rows.map(mapAgent)
  }

  async getAgentCapabilityProfile(agentId: string): Promise<StoredAgentCapabilityProfile | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.agent_capability_profiles WHERE agent_id=$1`,
      [agentId]
    )
    return result.rows[0] ? mapAgentCapabilityProfile(result.rows[0]) : null
  }

  async getProjection(projectionId: string): Promise<StoredProjection | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.remote_session_projections WHERE projection_id=$1`, [projectionId])
    return result.rows[0] ? mapProjection(result.rows[0]) : null
  }

  async getProjectionByLocator(provider: string, realmId: string, containerId: string, topicId: string): Promise<StoredProjection | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.remote_session_projections
       WHERE locator->>'provider'=$1 AND locator->>'realmId'=$2 AND locator->>'containerId'=$3 AND locator->>'topicId'=$4`,
      [provider, realmId, containerId, topicId]
    )
    return result.rows[0] ? mapProjection(result.rows[0]) : null
  }

  async listProjectionsForOwner(userId: string): Promise<StoredProjection[]> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.remote_session_projections WHERE owner_user_id=$1 ORDER BY created_at,projection_id`, [userId])
    return result.rows.map(mapProjection)
  }

  async getManagedContainer(managedContainerId: string): Promise<StoredManagedContainer | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.managed_provider_containers WHERE managed_container_id=$1`,
      [managedContainerId]
    )
    return result.rows[0] ? mapManagedContainer(result.rows[0]) : null
  }

  async getManagedContainerForOwner(
    ownerUserId: string,
    provider: string,
    realmId: string
  ): Promise<StoredManagedContainer | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.managed_provider_containers
       WHERE owner_user_id=$1 AND provider=$2 AND realm_id=$3`,
      [ownerUserId, provider, realmId]
    )
    return result.rows[0] ? mapManagedContainer(result.rows[0]) : null
  }

  async listManagedContainersForOwner(ownerUserId: string): Promise<StoredManagedContainer[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.managed_provider_containers
       WHERE owner_user_id=$1 ORDER BY created_at,managed_container_id`,
      [ownerUserId]
    )
    return result.rows.map(mapManagedContainer)
  }

  async getProjectBindingByLocator(provider: string, realmId: string, containerId: string, topicId: string): Promise<StoredProjectEndpointBinding | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_endpoint_bindings
       WHERE locator->>'provider'=$1 AND locator->>'realmId'=$2 AND locator->>'containerId'=$3 AND locator->>'topicId'=$4`,
      [provider, realmId, containerId, topicId]
    )
    return result.rows[0] ? mapProjectBinding(result.rows[0]) : null
  }

  async getProjectEndpointBinding(projectId: string): Promise<StoredProjectEndpointBinding | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.project_endpoint_bindings WHERE project_id=$1`, [projectId])
    return result.rows[0] ? mapProjectBinding(result.rows[0]) : null
  }

  async getProjectEndpointBindingById(projectEndpointBindingId: string): Promise<StoredProjectEndpointBinding | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_endpoint_bindings WHERE project_endpoint_binding_id=$1`,
      [projectEndpointBindingId]
    )
    return result.rows[0] ? mapProjectBinding(result.rows[0]) : null
  }

  async getProjectContentSpaceBinding(projectId: string): Promise<StoredProjectContentSpaceBinding | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_content_space_bindings WHERE project_id=$1`,
      [projectId]
    )
    return result.rows[0] ? mapProjectContentSpaceBinding(result.rows[0]) : null
  }

  async getActiveProjectContentSpaceBindingByRootReferenceDigest(
    rootReferenceDigest: string
  ): Promise<StoredProjectContentSpaceBinding | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_content_space_bindings
       WHERE root_reference_digest=$1 AND status='active'`,
      [Buffer.from(rootReferenceDigest, 'hex')]
    )
    return result.rows[0] ? mapProjectContentSpaceBinding(result.rows[0]) : null
  }

  async getProjectInputByProviderMessage(endpointId: string, providerMessageId: string): Promise<StoredProjectInput | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_inputs WHERE source_human_endpoint_id=$1 AND provider_message_id=$2`,
      [endpointId, providerMessageId]
    )
    return result.rows[0] ? mapProjectInput(result.rows[0]) : null
  }

  async getHumanRequest(humanRequestId: string): Promise<StoredHumanRequest | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.human_requests WHERE human_request_id=$1`, [humanRequestId])
    return result.rows[0] ? mapHumanRequest(result.rows[0]) : null
  }

  async getHumanAnswerForRequest(humanRequestId: string): Promise<StoredHumanAnswer | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.human_answers WHERE human_request_id=$1`, [humanRequestId])
    return result.rows[0] ? mapHumanAnswer(result.rows[0]) : null
  }

  async listHumanRequestsForProject(projectId: string): Promise<StoredHumanRequest[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.human_requests
       WHERE project_id=$1 ORDER BY created_at,human_request_id`,
      [projectId]
    )
    return result.rows.map(mapHumanRequest)
  }

  async listHumanAnswersForProject(projectId: string): Promise<StoredHumanAnswer[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.human_answers
       WHERE project_id=$1 ORDER BY created_at,human_answer_id`,
      [projectId]
    )
    return result.rows.map(mapHumanAnswer)
  }

  async getProject(projectId: string): Promise<StoredProject | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.projects WHERE project_id = $1`, [projectId])
    return result.rows[0] ? mapProject(result.rows[0]) : null
  }

  async listProjectsForUser(userId: string): Promise<StoredProject[]> {
    const result = await this.sql.query(
      `SELECT project.*
       FROM sciforge_collaboration.projects AS project
       INNER JOIN sciforge_collaboration.project_members AS member
         ON member.project_id=project.project_id
       WHERE member.user_id=$1 AND member.active=true
       ORDER BY project.updated_at DESC,project.project_id`,
      [userId]
    )
    return result.rows.map(mapProject)
  }

  async listProjectSummaryPageForUser(input: ProjectSummaryPageQuery): Promise<ProjectSummaryPage> {
    const limit = boundedPageSize(input.limit)
    const result = await this.sql.query(
      `WITH project_page AS (
         SELECT project.*,member.role AS portal_role
         FROM sciforge_collaboration.projects AS project
         INNER JOIN sciforge_collaboration.project_members AS member
           ON member.project_id=project.project_id
          AND member.user_id=$1
          AND member.active=true
         WHERE ($2::text[] IS NULL OR project.status=ANY($2::text[]))
           AND ($3::timestamptz IS NULL OR project.updated_at < $3::timestamptz
             OR (project.updated_at = $3::timestamptz AND project.project_id > $4))
         ORDER BY project.updated_at DESC,project.project_id ASC
         LIMIT $5
       )
       SELECT project_page.*,
         member_counts.portal_member_count,
         record_counts.portal_pending_result_count,
         task_counts.portal_task_offered,task_counts.portal_task_accepted,
         task_counts.portal_task_rejected,task_counts.portal_task_running,
         task_counts.portal_task_needs_human,task_counts.portal_task_succeeded,
         task_counts.portal_task_failed,task_counts.portal_task_cancelled
       FROM project_page
       CROSS JOIN LATERAL (
         SELECT count(*) AS portal_member_count
         FROM sciforge_collaboration.project_members AS project_member
         WHERE project_member.project_id=project_page.project_id AND project_member.active=true
       ) AS member_counts
       CROSS JOIN LATERAL (
         SELECT count(*) AS portal_pending_result_count
         FROM sciforge_collaboration.project_records AS project_record
         WHERE project_record.project_id=project_page.project_id
           AND project_record.kind='task_result' AND project_record.status='candidate'
       ) AS record_counts
       CROSS JOIN LATERAL (
         SELECT
           count(*) FILTER (WHERE task.status='offered') AS portal_task_offered,
           count(*) FILTER (WHERE task.status='accepted') AS portal_task_accepted,
           count(*) FILTER (WHERE task.status='rejected') AS portal_task_rejected,
           count(*) FILTER (WHERE task.status='in_progress') AS portal_task_running,
           count(*) FILTER (WHERE task.status='needs_human') AS portal_task_needs_human,
           count(*) FILTER (WHERE task.status='completed') AS portal_task_succeeded,
           count(*) FILTER (WHERE task.status='failed') AS portal_task_failed,
           count(*) FILTER (WHERE task.status='cancelled') AS portal_task_cancelled
         FROM sciforge_collaboration.tasks AS task
         WHERE task.project_id=project_page.project_id
       ) AS task_counts
       ORDER BY project_page.updated_at DESC,project_page.project_id ASC`,
      [
        input.userId,
        input.statuses ?? null,
        input.after?.updatedAt ?? null,
        input.after?.projectId ?? null,
        limit + 1
      ]
    )
    const rows = result.rows.slice(0, limit)
    return {
      items: rows.map((row) => {
        const project = mapProject(row)
        return {
          projectId: project.projectId,
          displayName: project.displayName,
          goal: project.goal,
          status: project.status === 'failed' ? 'cancelled' : project.status,
          role: string(row, 'portal_role') as StoredProjectMember['role'],
          memberCount: number(row.portal_member_count),
          taskCounts: {
            offered: number(row.portal_task_offered),
            accepted: number(row.portal_task_accepted),
            rejected: number(row.portal_task_rejected),
            running: number(row.portal_task_running),
            needsHuman: number(row.portal_task_needs_human),
            succeeded: number(row.portal_task_succeeded),
            failed: number(row.portal_task_failed),
            cancelled: number(row.portal_task_cancelled)
          },
          pendingResultCount: number(row.portal_pending_result_count),
          revision: project.revision,
          updatedAt: project.updatedAt
        }
      }),
      hasMore: result.rows.length > limit
    }
  }

  async listActiveProjectsForCoordinator(agentId: string): Promise<StoredProject[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.projects
       WHERE coordinator_agent_id=$1 AND status='active' ORDER BY created_at,project_id`, [agentId]
    )
    return result.rows.map(mapProject)
  }

  async getProjectMember(projectId: string, userId: string): Promise<StoredProjectMember | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_members WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId]
    )
    return result.rows[0] ? mapMember(result.rows[0]) : null
  }

  async listProjectMembers(projectId: string): Promise<StoredProjectMember[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_members WHERE project_id = $1 ORDER BY created_at, user_id`,
      [projectId]
    )
    return result.rows.map(mapMember)
  }

  async listProjectMembersByUserIds(projectId: string, userIds: readonly string[]): Promise<StoredProjectMember[]> {
    if (userIds.length === 0) return []
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_members
       WHERE project_id=$1 AND user_id=ANY($2::text[])
       ORDER BY user_id`,
      [projectId, [...userIds]]
    )
    return result.rows.map(mapMember)
  }

  async listActiveProjectMembersBounded(projectId: string, limit: number): Promise<StoredProjectMember[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_members
       WHERE project_id=$1 AND active=true
       ORDER BY user_id
       LIMIT $2`,
      [projectId, boundedReadLimit(limit)]
    )
    return result.rows.map(mapMember)
  }

  async countActiveProjectMembers(projectId: string): Promise<number> {
    const result = await this.sql.query<{ count: unknown }>(
      `SELECT count(*) AS count FROM sciforge_collaboration.project_members
       WHERE project_id=$1 AND active=true`,
      [projectId]
    )
    return number(result.rows[0]?.count)
  }

  async countProjectRecords(projectId: string): Promise<number> {
    const result = await this.sql.query<{ count: unknown }>(
      `SELECT count(*) AS count
       FROM sciforge_collaboration.project_records
       WHERE project_id=$1`,
      [projectId]
    )
    return number(result.rows[0]?.count)
  }

  async countProjectHumanRequests(projectId: string): Promise<number> {
    const result = await this.sql.query<{ count: unknown }>(
      `SELECT count(*) AS count
       FROM sciforge_collaboration.human_requests
       WHERE project_id=$1`,
      [projectId]
    )
    return number(result.rows[0]?.count)
  }

  async getProjectMemberRemovalBlockers(
    projectId: string,
    userIds: readonly string[],
    now: string
  ): Promise<ProjectMemberRemovalBlockers> {
    if (userIds.length === 0) return { openTaskUserIds: [], pendingHumanRequestUserIds: [] }
    const result = await this.sql.query<{ blocker_kind: unknown; user_id: unknown }>(
      `WITH blockers AS (
         SELECT DISTINCT 'open_task'::text AS blocker_kind,task.assignee_user_id AS user_id
         FROM sciforge_collaboration.tasks AS task
         WHERE task.project_id=$1
           AND task.assignee_user_id=ANY($2::text[])
           AND task.status IN ('offered','accepted','in_progress','needs_human')
         UNION ALL
         SELECT DISTINCT 'pending_human'::text AS blocker_kind,request.target_user_id AS user_id
         FROM sciforge_collaboration.human_requests AS request
         WHERE request.project_id=$1
           AND request.target_user_id=ANY($2::text[])
           AND request.status='pending'
           AND request.expires_at>$3::timestamptz
       )
       SELECT blocker_kind,user_id FROM blockers ORDER BY blocker_kind,user_id`,
      [projectId, [...userIds], now]
    )
    const openTaskUserIds: string[] = []
    const pendingHumanRequestUserIds: string[] = []
    for (const row of result.rows) {
      const destination = string(row, 'blocker_kind') === 'open_task'
        ? openTaskUserIds
        : pendingHumanRequestUserIds
      destination.push(string(row, 'user_id'))
    }
    return { openTaskUserIds, pendingHumanRequestUserIds }
  }

  async listActiveProjectMemberViewsBounded(
    projectId: string,
    limit: number
  ): Promise<Array<StoredProjectMember & { displayName: string }>> {
    const result = await this.sql.query(
      `SELECT member.*,principal.display_name AS portal_display_name
       FROM sciforge_collaboration.project_members AS member
       INNER JOIN sciforge_collaboration.user_principals AS principal ON principal.user_id=member.user_id
       WHERE member.project_id = $1 AND member.active=true
       ORDER BY member.user_id
       LIMIT $2`,
      [projectId, boundedReadLimit(limit)]
    )
    return result.rows.map((row) => ({ ...mapMember(row), displayName: string(row, 'portal_display_name') }))
  }

  async getProjectCoordinationMaterializationCounts(
    projectId: string
  ): Promise<ProjectCoordinationMaterializationCounts> {
    const result = await this.sql.query<{
      active_member_rows: unknown
      task_rows: unknown
      record_rows: unknown
      human_request_rows: unknown
      human_answer_rows: unknown
    }>(
      `WITH active_member_count AS (
         SELECT count(*)::text AS row_count
         FROM sciforge_collaboration.project_members
         WHERE project_id=$1 AND active=true
       ), task_count AS (
         SELECT count(*)::text AS row_count
         FROM sciforge_collaboration.tasks WHERE project_id=$1
       ), record_count AS (
         SELECT count(*)::text AS row_count
         FROM sciforge_collaboration.project_records WHERE project_id=$1
       ), human_request_count AS (
         SELECT count(*)::text AS row_count
         FROM sciforge_collaboration.human_requests WHERE project_id=$1
       ), human_answer_count AS (
         SELECT count(*)::text AS row_count
         FROM sciforge_collaboration.human_answers WHERE project_id=$1
       )
       SELECT
         active_member_count.row_count AS active_member_rows,
         task_count.row_count AS task_rows,
         record_count.row_count AS record_rows,
         human_request_count.row_count AS human_request_rows,
         human_answer_count.row_count AS human_answer_rows
       FROM active_member_count,task_count,record_count,human_request_count,human_answer_count`,
      [projectId]
    )
    const row = result.rows[0]
    if (!row) throw new Error('Repository coordination materialization count preflight returned no row.')
    return {
      activeMembers: nonNegativeIntegerText(row.active_member_rows),
      tasks: nonNegativeIntegerText(row.task_rows),
      records: nonNegativeIntegerText(row.record_rows),
      humanRequests: nonNegativeIntegerText(row.human_request_rows),
      humanAnswers: nonNegativeIntegerText(row.human_answer_rows)
    }
  }

  async getProjectCoordinationMaterializationBytes(
    projectId: string
  ): Promise<ProjectCoordinationMaterializationBytes> {
    const result = await this.sql.query<{
      active_member_bytes: unknown
      task_bytes: unknown
      record_bytes: unknown
      human_request_bytes: unknown
      human_answer_bytes: unknown
    }>(
      `WITH active_member_bytes AS (
         SELECT COALESCE(sum(octet_length(to_jsonb(member_view)::text)),0)::text AS serialized_bytes
         FROM (
           SELECT member.*,principal.display_name AS portal_display_name
           FROM sciforge_collaboration.project_members AS member
           INNER JOIN sciforge_collaboration.user_principals AS principal
             ON principal.user_id=member.user_id
           WHERE member.project_id=$1 AND member.active=true
         ) AS member_view
       ), task_bytes AS (
         SELECT COALESCE(sum(octet_length(to_jsonb(task_row)::text)),0)::text AS serialized_bytes
         FROM sciforge_collaboration.tasks AS task_row WHERE task_row.project_id=$1
       ), record_bytes AS (
         SELECT COALESCE(sum(octet_length(to_jsonb(record_row)::text)),0)::text AS serialized_bytes
         FROM sciforge_collaboration.project_records AS record_row WHERE record_row.project_id=$1
       ), human_request_bytes AS (
         SELECT COALESCE(sum(octet_length(to_jsonb(request_row)::text)),0)::text AS serialized_bytes
         FROM sciforge_collaboration.human_requests AS request_row WHERE request_row.project_id=$1
       ), human_answer_bytes AS (
         SELECT COALESCE(sum(octet_length(to_jsonb(answer_row)::text)),0)::text AS serialized_bytes
         FROM sciforge_collaboration.human_answers AS answer_row WHERE answer_row.project_id=$1
       )
       SELECT
         active_member_bytes.serialized_bytes AS active_member_bytes,
         task_bytes.serialized_bytes AS task_bytes,
         record_bytes.serialized_bytes AS record_bytes,
         human_request_bytes.serialized_bytes AS human_request_bytes,
         human_answer_bytes.serialized_bytes AS human_answer_bytes
       FROM active_member_bytes,task_bytes,record_bytes,human_request_bytes,human_answer_bytes`,
      [projectId]
    )
    const row = result.rows[0]
    if (!row) throw new Error('Repository coordination materialization byte preflight returned no row.')
    return {
      activeMembers: nonNegativeIntegerText(row.active_member_bytes),
      tasks: nonNegativeIntegerText(row.task_bytes),
      records: nonNegativeIntegerText(row.record_bytes),
      humanRequests: nonNegativeIntegerText(row.human_request_bytes),
      humanAnswers: nonNegativeIntegerText(row.human_answer_bytes)
    }
  }

  async countProjectTasks(projectId: string, coordinationRound?: number): Promise<number> {
    const result = await this.sql.query<{ count: unknown }>(
      coordinationRound === undefined
        ? `SELECT count(*) AS count FROM sciforge_collaboration.tasks WHERE project_id = $1`
        : `SELECT count(*) AS count FROM sciforge_collaboration.tasks WHERE project_id = $1 AND coordination_round = $2`,
      coordinationRound === undefined ? [projectId] : [projectId, coordinationRound]
    )
    return number(result.rows[0]?.count)
  }

  async countOpenProjectTasks(projectId: string): Promise<number> {
    const result = await this.sql.query<{ count: unknown }>(
      `SELECT count(*) AS count FROM sciforge_collaboration.tasks
       WHERE project_id = $1 AND status IN ('offered','accepted','in_progress','needs_human')`,
      [projectId]
    )
    return number(result.rows[0]?.count)
  }

  async countOpenProjectFileTasks(projectId: string): Promise<number> {
    const result = await this.sql.query<{ count: unknown }>(
      `SELECT count(*) AS count FROM sciforge_collaboration.tasks
       WHERE project_id = $1 AND file_intent IS NOT NULL
         AND status IN ('offered','accepted','in_progress','needs_human')`,
      [projectId]
    )
    return number(result.rows[0]?.count)
  }

  async getTask(taskId: string): Promise<StoredTask | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.tasks WHERE task_id = $1`, [taskId])
    return result.rows[0] ? mapTask(result.rows[0]) : null
  }

  async listOpenTasksForAgent(agentId: string): Promise<StoredTask[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.tasks
       WHERE assignee_agent_id=$1 AND status IN ('offered','accepted','in_progress','needs_human')
       ORDER BY created_at,task_id`,
      [agentId]
    )
    return result.rows.map(mapTask)
  }

  async listProjectTasks(projectId: string): Promise<StoredTask[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.tasks
       WHERE project_id=$1 ORDER BY created_at,task_id`,
      [projectId]
    )
    return result.rows.map(mapTask)
  }

  async listProjectTasksBounded(
    projectId: string,
    afterTaskId: string | undefined,
    limit: number
  ): Promise<StoredTask[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.tasks
       WHERE project_id=$1 AND ($2::text IS NULL OR task_id > $2)
       ORDER BY task_id
       LIMIT $3`,
      [projectId, afterTaskId ?? null, boundedReadLimit(limit)]
    )
    return result.rows.map(mapTask)
  }

  async getProjectRecord(projectRecordId: string): Promise<StoredProjectRecord | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.project_records WHERE project_record_id = $1`, [projectRecordId])
    return result.rows[0] ? mapRecord(result.rows[0]) : null
  }

  async getTaskResultForExecution(taskId: string, executionId: string): Promise<StoredProjectRecord | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_records
       WHERE kind='task_result' AND status<>'superseded'
         AND source_task_id=$1 AND source_execution_id=$2
       ORDER BY CASE status WHEN 'accepted' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
                updated_at DESC,project_record_id ASC
       LIMIT 1`,
      [taskId, executionId]
    )
    return result.rows[0] ? mapRecord(result.rows[0]) : null
  }

  async listProjectRecords(projectId: string, acceptedOnly: boolean): Promise<StoredProjectRecord[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_records
       WHERE project_id = $1 AND ($2::boolean = false OR status = 'accepted')
       ORDER BY created_at, project_record_id`,
      [projectId, acceptedOnly]
    )
    return result.rows.map(mapRecord)
  }

  async listProjectRecordsBounded(
    projectId: string,
    afterProjectRecordId: string | undefined,
    limit: number
  ): Promise<StoredProjectRecord[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_records
       WHERE project_id=$1 AND ($2::text IS NULL OR project_record_id > $2)
       ORDER BY project_record_id
       LIMIT $3`,
      [projectId, afterProjectRecordId ?? null, boundedReadLimit(limit)]
    )
    return result.rows.map(mapRecord)
  }

  async listTargetHumanRequestsForProjectBounded(
    projectId: string,
    targetUserId: string,
    afterHumanRequestId: string | undefined,
    limit: number
  ): Promise<StoredHumanRequest[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.human_requests
       WHERE project_id=$1 AND target_user_id=$2
         AND ($3::text IS NULL OR human_request_id > $3)
       ORDER BY human_request_id
       LIMIT $4`,
      [projectId, targetUserId, afterHumanRequestId ?? null, boundedReadLimit(limit)]
    )
    return result.rows.map(mapHumanRequest)
  }

  async getPortalProjectWakeWatermarks(
    projectId: string,
    targetUserId: string
  ): Promise<PortalProjectWakeWatermarks> {
    const result = await this.sql.query<{
      task_count: unknown
      task_revision_sum: unknown
      record_count: unknown
      record_revision_sum: unknown
      human_request_count: unknown
      human_request_revision_sum: unknown
    }>(
      `WITH task_watermark AS (
         SELECT count(*)::text AS task_count,
           COALESCE(sum(revision),0)::text AS task_revision_sum
         FROM sciforge_collaboration.tasks
         WHERE project_id=$1
       ), record_watermark AS (
         SELECT count(*)::text AS record_count,
           COALESCE(sum(revision),0)::text AS record_revision_sum
         FROM sciforge_collaboration.project_records
         WHERE project_id=$1
       ), human_watermark AS (
         SELECT count(*)::text AS human_request_count,
           COALESCE(sum(revision),0)::text AS human_request_revision_sum
         FROM sciforge_collaboration.human_requests
         WHERE project_id=$1 AND target_user_id=$2
       )
       SELECT * FROM task_watermark
       CROSS JOIN record_watermark
       CROSS JOIN human_watermark`,
      [projectId, targetUserId]
    )
    const row = result.rows[0]
    if (!row) throw new Error('Portal Project watermark query returned no row.')
    return {
      taskCount: nonNegativeIntegerText(row.task_count),
      taskRevisionSum: nonNegativeIntegerText(row.task_revision_sum),
      recordCount: nonNegativeIntegerText(row.record_count),
      recordRevisionSum: nonNegativeIntegerText(row.record_revision_sum),
      humanRequestCount: nonNegativeIntegerText(row.human_request_count),
      humanRequestRevisionSum: nonNegativeIntegerText(row.human_request_revision_sum)
    }
  }

  async getWorkerDirectoryPage(input: WorkerDirectoryPageQuery): Promise<WorkerDirectoryRepositoryPage> {
    const limit = boundedPageSize(input.limit)
    const eligibility = `
      FROM sciforge_collaboration.agent_nodes AS agent
      INNER JOIN sciforge_collaboration.user_principals AS owner
        ON owner.user_id=agent.owner_user_id AND owner.status='active'
      INNER JOIN sciforge_collaboration.devices AS device
        ON device.device_id=agent.device_id AND device.user_id=agent.owner_user_id AND device.status='active'
      INNER JOIN sciforge_collaboration.agent_capability_profiles AS profile
        ON profile.agent_id=agent.agent_id AND profile.owner_user_id=agent.owner_user_id
      WHERE agent.status='active'
        AND agent.node_type IN ('desktop','server')
        AND agent.last_seen_at IS NOT NULL
        AND profile.expires_at > $2::timestamptz
        AND EXISTS (
          SELECT 1 FROM sciforge_collaboration.oidc_identities AS identity
          WHERE identity.user_id=agent.owner_user_id AND identity.issuer=$1 AND identity.status='active'
        )`
    const statsResult = await this.sql.query(
      `WITH eligible AS (
         SELECT agent.node_type,
           (agent.connection_status='online'
             AND agent.last_seen_at >= $2::timestamptz - interval '60 seconds'
             AND agent.last_seen_at <= $2::timestamptz + interval '60 seconds') AS portal_online,
           EXISTS (
             SELECT 1 FROM sciforge_collaboration.tasks AS task
             WHERE task.assignee_agent_id=agent.agent_id
               AND task.status IN ('accepted','in_progress','needs_human')
           ) AS portal_busy
         ${eligibility}
       )
       SELECT count(*) AS total,
         count(*) FILTER (WHERE portal_online AND NOT portal_busy) AS online,
         count(*) FILTER (WHERE portal_online AND portal_busy) AS busy,
         count(*) FILTER (WHERE NOT portal_online) AS offline,
         count(*) FILTER (WHERE node_type='desktop') AS desktop,
         count(*) FILTER (WHERE node_type='server') AS server
       FROM eligible`,
      [input.issuer, input.readAt]
    )
    const pageResult = await this.sql.query(
      `SELECT agent.owner_user_id,agent.agent_id,agent.display_name,agent.node_type,
         profile.os_family,profile.os_architecture,profile.runtime_ids,profile.capabilities,profile.gpu,
         agent.last_seen_at,profile.expires_at AS profile_expires_at,agent.revision,
         CASE WHEN agent.connection_status='online'
               AND agent.last_seen_at >= $2::timestamptz - interval '60 seconds'
               AND agent.last_seen_at <= $2::timestamptz + interval '60 seconds'
           THEN CASE WHEN EXISTS (
             SELECT 1 FROM sciforge_collaboration.tasks AS task
             WHERE task.assignee_agent_id=agent.agent_id
               AND task.status IN ('accepted','in_progress','needs_human')
           ) THEN 'busy' ELSE 'online' END
           ELSE 'offline'
         END AS portal_status
       ${eligibility}
         AND ($3::text IS NULL OR agent.agent_id > $3)
       ORDER BY agent.agent_id ASC
       LIMIT $4`,
      [input.issuer, input.readAt, input.afterAgentId ?? null, limit + 1]
    )
    const statsRow = statsResult.rows[0] ?? {}
    return {
      stats: {
        total: number(statsRow.total),
        online: number(statsRow.online),
        busy: number(statsRow.busy),
        offline: number(statsRow.offline),
        desktop: number(statsRow.desktop),
        server: number(statsRow.server)
      },
      items: pageResult.rows.slice(0, limit).map(mapWorkerDirectoryEntry),
      hasMore: pageResult.rows.length > limit
    }
  }

  async getResourceRef(resourceRefId: string): Promise<StoredResourceRef | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.resource_refs WHERE resource_ref_id = $1`,
      [resourceRefId]
    )
    return result.rows[0] ? mapResourceRef(result.rows[0]) : null
  }

  async getCredential(credentialId: string): Promise<StoredCredential | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.credentials WHERE credential_id = $1`,
      [credentialId]
    )
    return result.rows[0] ? mapCredential(result.rows[0]) : null
  }

  async getCredentialByDigest(tokenDigest: string): Promise<StoredCredential | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.credentials WHERE token_digest = $1`, [Buffer.from(tokenDigest, 'hex')])
    return result.rows[0] ? mapCredential(result.rows[0]) : null
  }

  async getReceipt(actorKey: string, idempotencyKey: string): Promise<StoredReceipt | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.receipts WHERE actor_key = $1 AND idempotency_key = $2`,
      [actorKey, idempotencyKey]
    )
    return result.rows[0] ? mapReceipt(result.rows[0]) : null
  }

  async getReceiptById(receiptId: string): Promise<StoredReceipt | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.receipts WHERE receipt_id = $1`, [receiptId]
    )
    return result.rows[0] ? mapReceipt(result.rows[0]) : null
  }

  async getInboxCursor(recipient: InboxRecipient): Promise<StoredInboxCursor | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.inbox_cursors WHERE recipient_kind = $1 AND recipient_id = $2`,
      [recipient.kind, recipient.id]
    )
    return result.rows[0] ? mapCursor(result.rows[0]) : null
  }

  async getInboxMessage(recipient: InboxRecipient, sequence: number): Promise<StoredInboxMessage | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.inbox_messages
       WHERE recipient_kind=$1 AND recipient_id=$2 AND sequence=$3`,
      [recipient.kind, recipient.id, sequence]
    )
    return result.rows[0] ? mapInbox(result.rows[0]) : null
  }

  async getInboxMessageById(recipient: InboxRecipient, messageId: string): Promise<StoredInboxMessage | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.inbox_messages
       WHERE recipient_kind=$1 AND recipient_id=$2 AND message_id=$3`,
      [recipient.kind, recipient.id, messageId]
    )
    return result.rows[0] ? mapInbox(result.rows[0]) : null
  }

  async pullInbox(recipient: InboxRecipient, afterSequence: number, limit: number, now: string): Promise<StoredInboxMessage[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.inbox_messages
       WHERE recipient_kind = $1 AND recipient_id = $2 AND sequence > $3
         AND (expires_at > $4 OR disposition = 'superseded')
       ORDER BY sequence ASC LIMIT $5`,
      [recipient.kind, recipient.id, afterSequence, now, limit]
    )
    return result.rows.map(mapInbox)
  }

  async getActionConfirmation(confirmationId: string): Promise<StoredActionConfirmation | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.action_confirmations WHERE confirmation_id=$1`,
      [confirmationId]
    )
    return result.rows[0] ? mapActionConfirmation(result.rows[0]) : null
  }
}

class PostgresTransaction extends PostgresReadRepository implements CollaborationTransaction {
  declare readonly sql: SqlConnection

  constructor(connection: SqlConnection) {
    super(connection)
    this.sql = connection
  }

  async lockIdempotency(actorKey: string, idempotencyKey: string): Promise<void> {
    // PostgreSQL text values cannot contain NUL. JSON encodes this composite key
    // unambiguously without introducing a byte that the wire protocol rejects.
    const lockScope = JSON.stringify([actorKey, idempotencyKey])
    await this.sql.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [lockScope])
  }

  async lockOidcIdentity(issuer: string, subject: string): Promise<void> {
    await this.sql.query(
      `SELECT pg_advisory_xact_lock($1::bigint)`,
      [advisoryLockKey(['oidc-identity', issuer, subject])]
    )
  }

  async lockZulipBindingIdentity(userId: string, realmId: string, zulipUserId: string): Promise<void> {
    const keys = [...new Set([
      advisoryLockKey(['zulip-user-realm', userId, realmId]),
      advisoryLockKey(['zulip-provider-identity', realmId, zulipUserId])
    ])].sort(compareSignedIntegerStrings)
    for (const key of keys) {
      await this.sql.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [key])
    }
  }

  async lockProjectMembershipUsers(userIds: readonly string[]): Promise<void> {
    for (const userId of [...new Set(userIds)].sort(compareStableStrings)) {
      await this.sql.query(
        `SELECT pg_advisory_xact_lock($1::bigint)`,
        [advisoryLockKey(['project-membership-user', userId])]
      )
    }
  }

  async countActiveProjectMembershipsByUserIds(
    userIds: readonly string[]
  ): Promise<ActiveProjectMembershipCount[]> {
    const stableUserIds = [...new Set(userIds)].sort(compareStableStrings)
    if (stableUserIds.length === 0) return []
    const result = await this.sql.query<{ user_id: unknown; count: unknown }>(
      `SELECT user_id,count(*) AS count
       FROM sciforge_collaboration.project_members
       WHERE active=true AND user_id=ANY($1::text[])
       GROUP BY user_id
       ORDER BY user_id`,
      [stableUserIds]
    )
    return result.rows.map((row) => ({
      userId: string(row, 'user_id'),
      count: number(row.count)
    }))
  }

  async getUserForUpdate(userId: string): Promise<StoredUser | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.user_principals WHERE user_id = $1 FOR UPDATE`,
      [userId]
    )
    return result.rows[0] ? mapUser(result.rows[0]) : null
  }

  async getOidcIdentityForUpdate(identityId: string): Promise<StoredOidcIdentity | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.oidc_identities WHERE identity_id=$1 FOR UPDATE`,
      [identityId]
    )
    return result.rows[0] ? mapOidcIdentity(result.rows[0]) : null
  }

  async getOidcIdentityByIssuerSubjectForUpdate(
    issuer: string,
    subject: string
  ): Promise<StoredOidcIdentity | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.oidc_identities
       WHERE issuer=$1 AND subject=$2 FOR UPDATE`,
      [issuer, subject]
    )
    return result.rows[0] ? mapOidcIdentity(result.rows[0]) : null
  }

  async getDeviceEnrollmentForUpdate(enrollmentId: string): Promise<StoredDeviceEnrollment | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.device_enrollments WHERE enrollment_id=$1 FOR UPDATE`,
      [enrollmentId]
    )
    return result.rows[0] ? mapDeviceEnrollment(result.rows[0]) : null
  }

  async getDeviceForUpdate(deviceId: string): Promise<StoredDevice | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.devices WHERE device_id=$1 FOR UPDATE`,
      [deviceId]
    )
    return result.rows[0] ? mapDevice(result.rows[0]) : null
  }

  async getCredentialForUpdate(credentialId: string): Promise<StoredCredential | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.credentials WHERE credential_id=$1 FOR UPDATE`,
      [credentialId]
    )
    return result.rows[0] ? mapCredential(result.rows[0]) : null
  }

  async getZulipBindingRequestForUpdate(
    bindingRequestId: string
  ): Promise<StoredZulipBindingRequest | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.zulip_binding_requests
       WHERE binding_request_id=$1 FOR UPDATE`,
      [bindingRequestId]
    )
    return result.rows[0] ? mapZulipBindingRequest(result.rows[0]) : null
  }

  async getZulipBindingRequestByCodeDigestForUpdate(
    codeDigest: string
  ): Promise<StoredZulipBindingRequest | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.zulip_binding_requests
       WHERE code_digest=$1 FOR UPDATE`,
      [Buffer.from(codeDigest, 'hex')]
    )
    return result.rows[0] ? mapZulipBindingRequest(result.rows[0]) : null
  }

  async getExternalIdentityForUpdate(externalIdentityId: string): Promise<StoredExternalIdentity | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.human_endpoint_bindings
       WHERE external_identity_id=$1 FOR UPDATE`,
      [externalIdentityId]
    )
    return result.rows[0] ? mapExternalIdentity(result.rows[0]) : null
  }

  async getProjectForUpdate(projectId: string): Promise<StoredProject | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.projects WHERE project_id = $1 FOR UPDATE`,
      [projectId]
    )
    return result.rows[0] ? mapProject(result.rows[0]) : null
  }

  async getProjectContentSpaceBindingForUpdate(
    projectId: string
  ): Promise<StoredProjectContentSpaceBinding | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_content_space_bindings
       WHERE project_id=$1 FOR UPDATE`,
      [projectId]
    )
    return result.rows[0] ? mapProjectContentSpaceBinding(result.rows[0]) : null
  }

  async getResourceRefForUpdate(resourceRefId: string): Promise<StoredResourceRef | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.resource_refs WHERE resource_ref_id=$1 FOR UPDATE`,
      [resourceRefId]
    )
    return result.rows[0] ? mapResourceRef(result.rows[0]) : null
  }

  async getAgentForUpdate(agentId: string): Promise<StoredAgent | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.agent_nodes WHERE agent_id = $1 FOR UPDATE`,
      [agentId]
    )
    return result.rows[0] ? mapAgent(result.rows[0]) : null
  }

  async getTaskForUpdate(taskId: string): Promise<StoredTask | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.tasks WHERE task_id = $1 FOR UPDATE`,
      [taskId]
    )
    return result.rows[0] ? mapTask(result.rows[0]) : null
  }

  async getTaskResultForExecutionForUpdate(taskId: string, executionId: string): Promise<StoredProjectRecord | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.project_records
       WHERE kind='task_result' AND status<>'superseded'
         AND source_task_id=$1 AND source_execution_id=$2
       ORDER BY CASE status WHEN 'accepted' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
                updated_at DESC,project_record_id ASC
       LIMIT 1
       FOR UPDATE`,
      [taskId, executionId]
    )
    return result.rows[0] ? mapRecord(result.rows[0]) : null
  }

  async getHumanRequestForUpdate(humanRequestId: string): Promise<StoredHumanRequest | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.human_requests
       WHERE human_request_id=$1 FOR UPDATE`,
      [humanRequestId]
    )
    return result.rows[0] ? mapHumanRequest(result.rows[0]) : null
  }

  async getActionConfirmationForUpdate(confirmationId: string): Promise<StoredActionConfirmation | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.action_confirmations
       WHERE confirmation_id=$1 FOR UPDATE`,
      [confirmationId]
    )
    return result.rows[0] ? mapActionConfirmation(result.rows[0]) : null
  }

  async listApprovedActionConfirmationsForProjectForUpdate(projectId: string): Promise<StoredActionConfirmation[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.action_confirmations
       WHERE project_id=$1 AND status='approved'
       ORDER BY confirmation_id FOR UPDATE`,
      [projectId]
    )
    return result.rows.map(mapActionConfirmation)
  }

  async listPendingHumanRequestsForTaskForUpdate(taskId: string): Promise<StoredHumanRequest[]> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.human_requests
       WHERE task_id=$1 AND status='pending'
       ORDER BY created_at,human_request_id FOR UPDATE`,
      [taskId]
    )
    return result.rows.map(mapHumanRequest)
  }

  async insertUser(user: StoredUser): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.user_principals
       (user_id, display_name, status, revision, created_at, updated_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [user.userId, user.displayName, user.status, user.revision, user.createdAt, user.updatedAt, user.revokedAt ?? null]
    )
  }

  async updateUser(user: StoredUser, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.user_principals
       SET display_name=$2,status=$3,revision=$4,updated_at=$5,revoked_at=$6
       WHERE user_id=$1 AND revision=$7`,
      [user.userId, user.displayName, user.status, user.revision, user.updatedAt, user.revokedAt ?? null, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async insertOidcIdentity(identity: StoredOidcIdentity): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.oidc_identities
       (identity_id,user_id,issuer,subject,email_at_link_time,status,revision,created_at,updated_at,revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [identity.identityId, identity.userId, identity.issuer, identity.subject, identity.emailAtLinkTime ?? null,
        identity.status, identity.revision, identity.createdAt, identity.updatedAt, identity.revokedAt ?? null]
    )
  }

  async updateOidcIdentity(identity: StoredOidcIdentity, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.oidc_identities
       SET status=$2,revision=$3,updated_at=$4,revoked_at=$5
       WHERE identity_id=$1 AND revision=$6`,
      [identity.identityId, identity.status, identity.revision, identity.updatedAt, identity.revokedAt ?? null,
        expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async insertDeviceEnrollment(enrollment: StoredDeviceEnrollment): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.device_enrollments
       (enrollment_id,user_id,installation_id,nonce_digest,status,revision,expires_at,consumed_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [enrollment.enrollmentId, enrollment.userId, enrollment.installationId,
        Buffer.from(enrollment.nonceDigest, 'hex'), enrollment.status, enrollment.revision, enrollment.expiresAt,
        enrollment.consumedAt ?? null, enrollment.createdAt, enrollment.updatedAt]
    )
  }

  async consumeDeviceEnrollment(
    enrollmentId: string,
    consumedAt: string,
    expectedRevision: number
  ): Promise<boolean> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.device_enrollments
       SET status='consumed',consumed_at=$2,revision=revision+1,updated_at=$2
       WHERE enrollment_id=$1 AND status='pending' AND revision=$3 AND expires_at>$2`,
      [enrollmentId, consumedAt, expectedRevision]
    )
    return result.rowCount === 1
  }

  async insertDevice(device: StoredDevice): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.devices
       (device_id,user_id,installation_id,display_name,platform,public_key_jwk,capability_summary,status,
        revision,created_at,updated_at,revoked_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12)`,
      [device.deviceId, device.userId, device.installationId, device.displayName, JSON.stringify(device.platform),
        JSON.stringify(device.publicKeyJwk), JSON.stringify(device.capabilitySummary), device.status, device.revision,
        device.createdAt, device.updatedAt, device.revokedAt ?? null]
    )
  }

  async updateDevice(device: StoredDevice, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.devices
       SET display_name=$2,platform=$3::jsonb,public_key_jwk=$4::jsonb,capability_summary=$5::jsonb,
           status=$6,revision=$7,updated_at=$8,revoked_at=$9
       WHERE device_id=$1 AND user_id=$10 AND revision=$11`,
      [device.deviceId, device.displayName, JSON.stringify(device.platform), JSON.stringify(device.publicKeyJwk),
        JSON.stringify(device.capabilitySummary), device.status, device.revision, device.updatedAt,
        device.revokedAt ?? null, device.userId, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async insertZulipBindingRequest(request: StoredZulipBindingRequest): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.zulip_binding_requests
       (binding_request_id,user_id,realm_url,code_digest,status,revision,expires_at,confirmed_at,
        external_identity_id,service_actor_id,provider_event_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [request.bindingRequestId, request.userId, request.realmUrl, Buffer.from(request.codeDigest, 'hex'),
        request.status, request.revision, request.expiresAt, request.confirmedAt ?? null,
        request.externalIdentityId ?? null, request.serviceActorId ?? null, request.providerEventId ?? null,
        request.createdAt, request.updatedAt]
    )
  }

  async updateZulipBindingRequest(request: StoredZulipBindingRequest, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.zulip_binding_requests
       SET status=$2,revision=$3,confirmed_at=$4,external_identity_id=$5,service_actor_id=$6,
           provider_event_id=$7,updated_at=$8
       WHERE binding_request_id=$1 AND revision=$9`,
      [request.bindingRequestId, request.status, request.revision, request.confirmedAt ?? null,
        request.externalIdentityId ?? null, request.serviceActorId ?? null, request.providerEventId ?? null,
        request.updatedAt, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async expirePendingZulipBindingRequests(userId: string, realmUrl: string, expiredAt: string): Promise<number> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.zulip_binding_requests
       SET status='expired',revision=revision+1,updated_at=$3
       WHERE user_id=$1 AND realm_url=$2 AND status='pending'`,
      [userId, realmUrl, expiredAt]
    )
    return result.rowCount ?? 0
  }

  async insertExternalIdentity(identity: StoredExternalIdentity): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.human_endpoint_bindings
       (human_endpoint_id,external_identity_id,user_id,provider,realm_url,realm_id,provider_user_id,display_name,
        assurance,status,revision,verified_at,created_at,updated_at,revoked_at)
       VALUES ($1,$2,$3,'zulip',$4,$5,$6,NULL,'verified',$7,$8,$9,$10,$11,$12)`,
      [identity.humanEndpointId, identity.externalIdentityId, identity.userId, identity.realmUrl, identity.realmId,
        identity.zulipUserId, identity.status, identity.revision, identity.verifiedAt, identity.createdAt,
        identity.updatedAt, identity.revokedAt ?? null]
    )
  }

  async updateExternalIdentity(identity: StoredExternalIdentity, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.human_endpoint_bindings
       SET status=$2,revision=$3,updated_at=$4,revoked_at=$5
       WHERE external_identity_id=$1 AND user_id=$6 AND provider='zulip' AND revision=$7`,
      [identity.externalIdentityId, identity.status, identity.revision, identity.updatedAt,
        identity.revokedAt ?? null, identity.userId, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async insertChallenge(challenge: StoredChallenge): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.human_endpoint_challenges
       (challenge_id,requested_user_id,provider,realm_id,expected_provider_user_id,challenge_digest,poll_secret_digest,
        requested_display_name,expires_at,verified_user_id,verified_endpoint_id,verified_at,consumed_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [challenge.challengeId, challenge.requestedUserId ?? null, challenge.provider, challenge.realmId,
        challenge.expectedProviderUserId ?? null,
        Buffer.from(challenge.challengeDigest, 'hex'), Buffer.from(challenge.pollSecretDigest, 'hex'),
        challenge.requestedDisplayName, challenge.expiresAt, challenge.verifiedUserId ?? null,
        challenge.verifiedEndpointId ?? null, challenge.verifiedAt ?? null, challenge.consumedAt ?? null, challenge.createdAt]
    )
  }

  async getChallenge(challengeId: string): Promise<StoredChallenge | null> {
    const result = await this.sql.query(`SELECT * FROM sciforge_collaboration.human_endpoint_challenges WHERE challenge_id=$1 FOR UPDATE`, [challengeId])
    return result.rows[0] ? mapChallenge(result.rows[0]) : null
  }

  async getChallengeByCodeDigest(challengeDigest: string): Promise<StoredChallenge | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.human_endpoint_challenges WHERE challenge_digest=$1 FOR UPDATE`,
      [Buffer.from(challengeDigest, 'hex')]
    )
    return result.rows[0] ? mapChallenge(result.rows[0]) : null
  }

  async getChallengeByPollDigest(pollSecretDigest: string): Promise<StoredChallenge | null> {
    const result = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.human_endpoint_challenges WHERE poll_secret_digest=$1 FOR UPDATE`,
      [Buffer.from(pollSecretDigest, 'hex')]
    )
    return result.rows[0] ? mapChallenge(result.rows[0]) : null
  }

  async verifyChallenge(challengeId: string, userId: string, endpointId: string, verifiedAt: string): Promise<boolean> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.human_endpoint_challenges
       SET verified_user_id=$2, verified_endpoint_id=$3, verified_at=$4
       WHERE challenge_id=$1 AND verified_at IS NULL AND consumed_at IS NULL`,
      [challengeId, userId, endpointId, verifiedAt]
    )
    return result.rowCount === 1
  }

  async consumeChallenge(challengeId: string, consumedAt: string): Promise<boolean> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.human_endpoint_challenges SET consumed_at=$2
       WHERE challenge_id=$1 AND verified_at IS NOT NULL AND consumed_at IS NULL`,
      [challengeId, consumedAt]
    )
    return result.rowCount === 1
  }

  async insertEndpoint(endpoint: StoredEndpoint): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.human_endpoint_bindings
       (human_endpoint_id,user_id,provider,realm_id,provider_user_id,display_name,assurance,status,revision,verified_at,updated_at,revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [endpoint.humanEndpointId, endpoint.userId, endpoint.provider, endpoint.realmId, endpoint.providerUserId,
        endpoint.displayName ?? null, endpoint.assurance, endpoint.status, endpoint.revision, endpoint.verifiedAt,
        endpoint.updatedAt, endpoint.revokedAt ?? null]
    )
  }

  async updateEndpoint(endpoint: StoredEndpoint, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.human_endpoint_bindings
       SET user_id=$2,display_name=$3,assurance=$4,status=$5,revision=$6,verified_at=$7,updated_at=$8,revoked_at=$9
       WHERE human_endpoint_id=$1 AND revision=$10 AND external_identity_id IS NULL`,
      [endpoint.humanEndpointId, endpoint.userId, endpoint.displayName ?? null, endpoint.assurance, endpoint.status,
        endpoint.revision, endpoint.verifiedAt, endpoint.updatedAt, endpoint.revokedAt ?? null, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async transferEndpointOwnership(input: {
    humanEndpointId: string
    sourceUserId: string
    targetUserId: string
    expectedRevision: number
    updatedAt: string
  }): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.human_endpoint_bindings
       SET user_id=$2,revision=revision+1,updated_at=$3
       WHERE human_endpoint_id=$1 AND user_id=$4 AND revision=$5`,
      [input.humanEndpointId, input.targetUserId, input.updatedAt, input.sourceUserId, input.expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async insertAgent(agent: StoredAgent): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.agent_nodes
       (agent_id,installation_id,device_id,owner_user_id,display_name,node_type,capabilities,status,connection_status,
        credential_generation,revision,last_seen_at,updated_at,revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)`,
      [agent.agentId, agent.installationId ?? null, agent.deviceId ?? null, agent.ownerUserId, agent.displayName,
        agent.nodeType, JSON.stringify(agent.capabilities), agent.status, agent.connectionStatus,
        agent.credentialGeneration, agent.revision, agent.lastSeenAt ?? null, agent.updatedAt, agent.revokedAt ?? null]
    )
  }

  async updateAgent(agent: StoredAgent, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.agent_nodes
       SET device_id=$2,owner_user_id=$3,display_name=$4,node_type=$5,capabilities=$6::jsonb,status=$7,
           connection_status=$8,credential_generation=$9,revision=$10,last_seen_at=$11,updated_at=$12,revoked_at=$13
       WHERE agent_id=$1 AND revision=$14`,
      [agent.agentId, agent.deviceId ?? null, agent.ownerUserId, agent.displayName, agent.nodeType,
        JSON.stringify(agent.capabilities), agent.status, agent.connectionStatus, agent.credentialGeneration,
        agent.revision, agent.lastSeenAt ?? null, agent.updatedAt, agent.revokedAt ?? null, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async upsertAgentCapabilityProfile(
    profile: StoredAgentCapabilityProfile,
    expectedRevision: number | null
  ): Promise<void> {
    const values = [
      profile.agentId,
      profile.ownerUserId,
      profile.nodeType,
      profile.osFamily,
      profile.osArchitecture,
      profile.osVersion ?? null,
      JSON.stringify(profile.runtimeIds),
      JSON.stringify(profile.capabilities),
      JSON.stringify(profile.gpu),
      JSON.stringify(profile.vpnAccessIds),
      JSON.stringify(profile.slurmClusterIds),
      JSON.stringify(profile.accessibleResourceRefIds),
      JSON.stringify(profile.resultReturnPolicy),
      profile.reportedAt,
      profile.expiresAt,
      profile.revision,
      profile.createdAt,
      profile.updatedAt
    ] as const
    if (expectedRevision === null) {
      await this.sql.query(
        `INSERT INTO sciforge_collaboration.agent_capability_profiles
         (agent_id,owner_user_id,node_type,os_family,os_architecture,os_version,runtime_ids,capabilities,gpu,
          vpn_access_ids,slurm_cluster_ids,accessible_resource_ref_ids,result_return_policy,reported_at,expires_at,
          revision,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,
          $13::jsonb,$14,$15,$16,$17,$18)`,
        values
      )
      return
    }
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.agent_capability_profiles
       SET owner_user_id=$2,node_type=$3,os_family=$4,os_architecture=$5,os_version=$6,runtime_ids=$7::jsonb,
           capabilities=$8::jsonb,gpu=$9::jsonb,vpn_access_ids=$10::jsonb,slurm_cluster_ids=$11::jsonb,
           accessible_resource_ref_ids=$12::jsonb,result_return_policy=$13::jsonb,reported_at=$14,expires_at=$15,
           revision=$16,created_at=$17,updated_at=$18
       WHERE agent_id=$1 AND revision=$19`,
      [...values, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async deleteAgentCapabilityProfile(agentId: string): Promise<void> {
    await this.sql.query(
      `DELETE FROM sciforge_collaboration.agent_capability_profiles
       WHERE agent_id=$1`,
      [agentId]
    )
  }

  async insertCredential(credential: StoredCredential): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.credentials
       (credential_id,kind,subject_user_id,subject_agent_id,token_digest,assurance,generation,created_at,expires_at,revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [credential.credentialId, credential.kind, credential.subjectUserId, credential.subjectAgentId ?? null,
        Buffer.from(credential.tokenDigest, 'hex'), credential.assurance, credential.generation, credential.createdAt,
        credential.expiresAt ?? null, credential.revokedAt ?? null]
    )
  }

  async revokeCredential(credentialId: string, revokedAt: string): Promise<boolean> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.credentials
       SET revoked_at=$2
       WHERE credential_id=$1 AND revoked_at IS NULL`,
      [credentialId, revokedAt]
    )
    return result.rowCount === 1
  }

  async revokeCredentials(kind: StoredCredential['kind'], subjectId: string, revokedAt: string): Promise<number> {
    const result = await this.sql.query(
      kind === 'user'
        ? `UPDATE sciforge_collaboration.credentials SET revoked_at=$3 WHERE kind=$1 AND subject_user_id=$2 AND revoked_at IS NULL`
        : `UPDATE sciforge_collaboration.credentials SET revoked_at=$3 WHERE kind=$1 AND subject_agent_id=$2 AND revoked_at IS NULL`,
      [kind, subjectId, revokedAt]
    )
    return result.rowCount ?? 0
  }

  async revokeAgentCredentialsForDevice(deviceId: string, revokedAt: string): Promise<number> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.credentials AS credential
       SET revoked_at=$2
       FROM sciforge_collaboration.agent_nodes AS agent
       WHERE agent.device_id=$1
         AND credential.kind='agent_device'
         AND credential.subject_agent_id=agent.agent_id
         AND credential.revoked_at IS NULL`,
      [deviceId, revokedAt]
    )
    return result.rowCount ?? 0
  }

  async upsertParticipant(participant: StoredParticipant, expectedRevision: number | null): Promise<void> {
    if (expectedRevision === null) {
      await this.sql.query(
        `INSERT INTO sciforge_collaboration.participant_profiles
         (user_id,primary_human_endpoint_id,primary_agent_id,status,revision,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [participant.userId, participant.primaryHumanEndpointId ?? null, participant.primaryAgentId ?? null,
          participant.status, participant.revision, participant.updatedAt]
      )
      return
    }
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.participant_profiles
       SET primary_human_endpoint_id=$2,primary_agent_id=$3,status=$4,revision=$5,updated_at=$6
       WHERE user_id=$1 AND revision=$7`,
      [participant.userId, participant.primaryHumanEndpointId ?? null, participant.primaryAgentId ?? null,
        participant.status, participant.revision, participant.updatedAt, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async insertProjection(projection: StoredProjection): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.remote_session_projections
       (projection_id,owner_user_id,agent_id,human_endpoint_id,locator,locator_revision,display_name,status,
        allowed_sender_user_ids,last_error_code,revision,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
      [projection.projectionId, projection.ownerUserId, projection.agentId, projection.humanEndpointId,
        JSON.stringify(projection.locator), projection.locatorRevision, projection.displayName, projection.status,
        JSON.stringify(projection.allowedSenderUserIds), projection.lastErrorCode ?? null, projection.revision,
        projection.createdAt, projection.updatedAt]
    )
  }

  async updateProjection(projection: StoredProjection, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.remote_session_projections
       SET locator=$2::jsonb,locator_revision=$3,display_name=$4,status=$5,allowed_sender_user_ids=$6::jsonb,
           last_error_code=$7,revision=$8,updated_at=$9
       WHERE projection_id=$1 AND revision=$10`,
      [projection.projectionId, JSON.stringify(projection.locator), projection.locatorRevision, projection.displayName,
        projection.status, JSON.stringify(projection.allowedSenderUserIds), projection.lastErrorCode ?? null,
        projection.revision, projection.updatedAt, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async insertManagedContainer(container: StoredManagedContainer): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.managed_provider_containers
       (managed_container_id,owner_user_id,human_endpoint_id,provider,realm_id,owner_provider_user_id,
        stable_key,display_name,external_container_id,policy,observed_checks,status,last_verified_at,safe_error_code,revision,
        created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17)`,
      [container.managedContainerId, container.ownerUserId, container.humanEndpointId, container.provider,
        container.realmId, container.ownerProviderUserId, container.stableKey, container.displayName,
        container.externalContainerId ?? null, JSON.stringify(container.policy),
        container.observedChecks ? JSON.stringify(container.observedChecks) : null, container.status,
        container.lastVerifiedAt ?? null, container.safeErrorCode ?? null, container.revision,
        container.createdAt, container.updatedAt]
    )
  }

  async updateManagedContainer(container: StoredManagedContainer, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.managed_provider_containers
       SET human_endpoint_id=$2,owner_provider_user_id=$3,display_name=$4,external_container_id=$5,
           policy=$6::jsonb,observed_checks=$7::jsonb,status=$8,last_verified_at=$9,safe_error_code=$10,
           revision=$11,updated_at=$12
       WHERE managed_container_id=$1 AND revision=$13`,
      [container.managedContainerId, container.humanEndpointId, container.ownerProviderUserId,
        container.displayName, container.externalContainerId ?? null, JSON.stringify(container.policy),
        container.observedChecks ? JSON.stringify(container.observedChecks) : null,
        container.status, container.lastVerifiedAt ?? null, container.safeErrorCode ?? null,
        container.revision, container.updatedAt, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async insertManagedContainerJob(job: StoredManagedContainerJob): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.managed_provider_container_jobs
       (job_id,managed_container_id,operation,desired_revision,state,attempt_count,next_attempt_at,
        lease_owner,lease_expires_at,safe_error_code,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [job.jobId, job.managedContainerId, job.operation, job.desiredRevision, job.state,
        job.attemptCount, job.nextAttemptAt, job.leaseOwner ?? null, job.leaseExpiresAt ?? null,
        job.safeErrorCode ?? null, job.createdAt, job.updatedAt]
    )
  }

  async upsertProjectEndpointBinding(binding: StoredProjectEndpointBinding, expectedRevision: number | null): Promise<void> {
    if (expectedRevision === null) {
      await this.sql.query(
        `INSERT INTO sciforge_collaboration.project_endpoint_bindings
         (project_endpoint_binding_id,project_id,locator,locator_revision,status,last_error_code,revision,created_at,updated_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)`,
        [binding.projectEndpointBindingId, binding.projectId, JSON.stringify(binding.locator), binding.locatorRevision,
          binding.status, binding.lastErrorCode ?? null, binding.revision, binding.createdAt, binding.updatedAt]
      )
      return
    }
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.project_endpoint_bindings
       SET locator=$2::jsonb,locator_revision=$3,status=$4,last_error_code=$5,revision=$6,updated_at=$7
       WHERE project_endpoint_binding_id=$1 AND revision=$8`,
      [binding.projectEndpointBindingId, JSON.stringify(binding.locator), binding.locatorRevision, binding.status,
        binding.lastErrorCode ?? null, binding.revision, binding.updatedAt, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async upsertProjectContentSpaceBinding(
    binding: StoredProjectContentSpaceBinding,
    expectedRevision: number | null
  ): Promise<void> {
    if (expectedRevision === null) {
      await this.sql.query(
        `INSERT INTO sciforge_collaboration.project_content_space_bindings
         (project_id,root_resource_ref_id,root_reference_digest,status,revision,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [binding.projectId, binding.rootResourceRefId, Buffer.from(binding.rootReferenceDigest, 'hex'),
          binding.status, binding.revision,
          binding.createdAt, binding.updatedAt]
      )
      return
    }
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.project_content_space_bindings
       SET root_resource_ref_id=$2,root_reference_digest=$3,status=$4,revision=$5,updated_at=$6
       WHERE project_id=$1 AND revision=$7`,
      [binding.projectId, binding.rootResourceRefId, Buffer.from(binding.rootReferenceDigest, 'hex'),
        binding.status, binding.revision,
        binding.updatedAt, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async insertProjectInput(input: Omit<StoredProjectInput, 'sequence'>): Promise<StoredProjectInput> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.project_input_cursors(project_id,next_sequence)
       VALUES ($1,1) ON CONFLICT (project_id) DO NOTHING`, [input.projectId]
    )
    const cursor = await this.sql.query<{ sequence: unknown }>(
      `UPDATE sciforge_collaboration.project_input_cursors SET next_sequence=next_sequence+1
       WHERE project_id=$1 RETURNING next_sequence-1 AS sequence`, [input.projectId]
    )
    const sequence = number(cursor.rows[0]?.sequence)
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.project_inputs
       (project_input_id,project_id,sender_user_id,source_human_endpoint_id,provider_message_id,sequence,text,status,
        revision,occurred_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [input.projectInputId, input.projectId, input.senderUserId, input.sourceHumanEndpointId,
        input.providerMessageId, sequence, input.text, input.status, input.revision, input.occurredAt,
        input.createdAt, input.updatedAt]
    )
    return { ...input, sequence }
  }

  async insertHumanRequest(request: StoredHumanRequest): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.human_requests
       (human_request_id,project_id,source_kind,task_id,execution_id,source_inbox_message_id,target_user_id,
        requested_by_agent_id,required_assurance,prompt,confirmable_action,status,revision,expires_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)`,
      [request.humanRequestId, request.projectId, request.sourceKind, request.taskId ?? null,
        request.executionId ?? null, request.sourceInboxMessageId ?? null, request.targetUserId,
        request.requestedByAgentId, request.requiredAssurance, request.prompt,
        request.confirmableAction ? JSON.stringify(request.confirmableAction) : null, request.status,
        request.revision, request.expiresAt, request.createdAt, request.updatedAt]
    )
  }

  async expireHumanRequestIfPending(
    humanRequestId: string,
    targetUserId: string,
    expectedRevision: number,
    expiredAt: string
  ): Promise<boolean> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.human_requests
       SET status='expired',revision=revision+1,updated_at=$4
       WHERE human_request_id=$1
         AND target_user_id=$2
         AND revision=$3
         AND status='pending'
         AND expires_at<=$4`,
      [humanRequestId, targetUserId, expectedRevision, expiredAt]
    )
    return result.rowCount === 1
  }

  async updateHumanRequest(request: StoredHumanRequest, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.human_requests SET status=$2,revision=$3,updated_at=$4
       WHERE human_request_id=$1 AND revision=$5`,
      [request.humanRequestId, request.status, request.revision, request.updatedAt, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async insertHumanAnswer(answer: StoredHumanAnswer): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.human_answers
       (human_answer_id,human_request_id,project_id,task_id,execution_id,request_revision,answered_by_user_id,
        answered_from_human_endpoint_id,assurance,answer,decision,confirmation_id,revision,answered_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [answer.humanAnswerId, answer.humanRequestId, answer.projectId, answer.taskId ?? null,
        answer.executionId ?? null, answer.requestRevision, answer.answeredByUserId,
        answer.answeredFromHumanEndpointId, answer.assurance, answer.answer, answer.decision ?? null,
        answer.confirmationId ?? null, answer.revision, answer.answeredAt, answer.createdAt, answer.updatedAt]
    )
  }

  async insertActionConfirmation(confirmation: StoredActionConfirmation): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.action_confirmations
       (confirmation_id,human_request_id,project_id,target_user_id,coordinator_agent_id,action,action_digest,status,
        approved_at,expires_at,consumed_at,consumed_by_actor_key,consumed_operation,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [confirmation.confirmationId, confirmation.humanRequestId, confirmation.projectId,
        confirmation.targetUserId, confirmation.coordinatorAgentId, JSON.stringify(confirmation.action),
        Buffer.from(confirmation.actionDigest, 'hex'), confirmation.status, confirmation.approvedAt,
        confirmation.expiresAt, confirmation.consumedAt ?? null, confirmation.consumedByActorKey ?? null,
        confirmation.consumedOperation ?? null, confirmation.createdAt, confirmation.updatedAt]
    )
  }

  async updateActionConfirmation(confirmation: StoredActionConfirmation): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.action_confirmations
       SET status=$2,consumed_at=$3,consumed_by_actor_key=$4,consumed_operation=$5,updated_at=$6
       WHERE confirmation_id=$1 AND status='approved'`,
      [confirmation.confirmationId, confirmation.status, confirmation.consumedAt ?? null,
        confirmation.consumedByActorKey ?? null, confirmation.consumedOperation ?? null,
        confirmation.updatedAt]
    )
    expectRevision(result.rowCount)
  }

  async insertProject(project: StoredProject, members: StoredProjectMember[]): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.projects
       (project_id,owner_user_id,display_name,goal,status,coordinator_agent_id,max_tasks,max_tasks_per_round,max_task_retries,
        max_coordination_rounds,coordination_round,revision,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [project.projectId, project.ownerUserId, project.displayName, project.goal, project.status, project.coordinatorAgentId,
        project.budgets.maxTasks, project.budgets.maxTasksPerRound, project.budgets.maxTaskRetries,
        project.budgets.maxCoordinationRounds, project.coordinationRound, project.revision, project.createdAt, project.updatedAt]
    )
    for (const member of members) {
      await this.sql.query(
        `INSERT INTO sciforge_collaboration.project_members(project_id,user_id,role,active,created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [member.projectId, member.userId, member.role, member.active, member.createdAt]
      )
    }
  }

  async updateProject(project: StoredProject, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.projects
       SET display_name=$2,goal=$3,status=$4,coordinator_agent_id=$5,max_tasks=$6,max_tasks_per_round=$7,max_task_retries=$8,
           max_coordination_rounds=$9,coordination_round=$10,revision=$11,updated_at=$12
       WHERE project_id=$1 AND revision=$13`,
      [project.projectId, project.displayName, project.goal, project.status, project.coordinatorAgentId, project.budgets.maxTasks,
        project.budgets.maxTasksPerRound, project.budgets.maxTaskRetries, project.budgets.maxCoordinationRounds,
        project.coordinationRound, project.revision, project.updatedAt, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async upsertProjectMember(member: StoredProjectMember): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.project_members(project_id,user_id,role,active,created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (project_id,user_id) DO UPDATE
       SET role=EXCLUDED.role,active=EXCLUDED.active`,
      [member.projectId, member.userId, member.role, member.active, member.createdAt]
    )
  }

  async insertTask(task: StoredTask): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.tasks
       (task_id,project_id,execution_id,assignee_agent_id,assignee_user_id,created_by_agent_id,title,objective,
        completion_criteria,dependency_task_ids,required_capabilities,resource_ref_ids,authorization_requirements,file_intent,
        status,retry_count,max_retries,coordination_round,active_turn_id,progress_percent,
        progress_summary,progress_reported_at,result_summary,result_record_id,safe_failure_code,safe_failure_summary,revision,created_at,
        updated_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
      [task.taskId, task.projectId, task.executionId, task.assigneeAgentId, task.assigneeUserId,
        task.createdByAgentId, task.title, task.objective, JSON.stringify(task.completionCriteria),
        JSON.stringify(task.dependencyTaskIds), JSON.stringify(task.requiredCapabilities),
        JSON.stringify(task.resourceRefIds), JSON.stringify(task.authorizationRequirements),
        task.fileIntent ? JSON.stringify(task.fileIntent) : null, task.status, task.retryCount,
        task.maxRetries, task.coordinationRound, task.activeTurnId ?? null, task.progress?.percent ?? null,
        task.progress?.summary ?? null, task.progress?.reportedAt ?? null, task.resultSummary ?? null,
        task.resultRecordId ?? null, task.safeFailureCode ?? null, task.safeFailureSummary ?? null,
        task.revision, task.createdAt,
        task.updatedAt, task.completedAt ?? null]
    )
  }

  async updateTask(task: StoredTask, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.tasks
       SET execution_id=$2,assignee_agent_id=$3,assignee_user_id=$4,title=$5,objective=$6,
           completion_criteria=$7::jsonb,dependency_task_ids=$8::jsonb,required_capabilities=$9::jsonb,
           resource_ref_ids=$10::jsonb,authorization_requirements=$11::jsonb,file_intent=$12::jsonb,
           status=$13,retry_count=$14,max_retries=$15,coordination_round=$16,active_turn_id=$17,
           progress_percent=$18,progress_summary=$19,progress_reported_at=$20,result_summary=$21,
           result_record_id=$22,safe_failure_code=$23,safe_failure_summary=$24,revision=$25,
           updated_at=$26,completed_at=$27
       WHERE task_id=$1 AND revision=$28`,
      [task.taskId, task.executionId, task.assigneeAgentId, task.assigneeUserId, task.title, task.objective,
        JSON.stringify(task.completionCriteria), JSON.stringify(task.dependencyTaskIds),
        JSON.stringify(task.requiredCapabilities), JSON.stringify(task.resourceRefIds),
        JSON.stringify(task.authorizationRequirements), task.fileIntent ? JSON.stringify(task.fileIntent) : null,
        task.status, task.retryCount, task.maxRetries,
        task.coordinationRound, task.activeTurnId ?? null, task.progress?.percent ?? null,
        task.progress?.summary ?? null, task.progress?.reportedAt ?? null, task.resultSummary ?? null,
        task.resultRecordId ?? null, task.safeFailureCode ?? null, task.safeFailureSummary ?? null,
        task.revision, task.updatedAt,
        task.completedAt ?? null, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async insertProjectRecord(record: StoredProjectRecord): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.project_records
       (project_record_id,project_id,kind,status,summary,author_user_id,author_agent_id,source_task_id,
        source_execution_id,source_revision,criterion_evidence,resource_ref_ids,log_summary,accepted_by_user_id,
        accepted_by_agent_id,accepted_at,revision,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19)`,
      [record.projectRecordId, record.projectId, record.kind, record.status, record.summary,
        record.authorUserId, record.authorAgentId ?? null, record.sourceTaskId ?? null,
        record.sourceExecutionId ?? null, record.sourceRevision ?? null, JSON.stringify(record.criterionEvidence),
        JSON.stringify(record.resourceRefIds), record.logSummary ?? null, record.acceptedByUserId ?? null,
        record.acceptedByAgentId ?? null, record.acceptedAt ?? null, record.revision, record.createdAt,
        record.updatedAt]
    )
  }

  async updateProjectRecord(record: StoredProjectRecord, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.project_records
       SET kind=$2,status=$3,summary=$4,source_task_id=$5,source_execution_id=$6,source_revision=$7,
           criterion_evidence=$8::jsonb,resource_ref_ids=$9::jsonb,log_summary=$10,accepted_by_user_id=$11,
           accepted_by_agent_id=$12,accepted_at=$13,revision=$14,updated_at=$15
       WHERE project_record_id=$1 AND revision=$16`,
      [record.projectRecordId, record.kind, record.status, record.summary, record.sourceTaskId ?? null,
        record.sourceExecutionId ?? null, record.sourceRevision ?? null, JSON.stringify(record.criterionEvidence),
        JSON.stringify(record.resourceRefIds), record.logSummary ?? null, record.acceptedByUserId ?? null,
        record.acceptedByAgentId ?? null, record.acceptedAt ?? null, record.revision, record.updatedAt,
        expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async insertResourceRef(resource: StoredResourceRef): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.resource_refs
       (resource_ref_id,project_id,task_id,execution_id,task_revision,created_by_user_id,created_by_agent_id,
        provider,external_id,kind,name,open_url,portable_reference,provider_version,status,status_reason_code,
        unavailable_at,revoked_at,invalidated_at,revision,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [resource.resourceRefId, resource.projectId, resource.taskId ?? null, resource.executionId ?? null,
        resource.taskRevision ?? null,
        resource.createdByUserId, resource.createdByAgentId ?? null, resource.provider, resource.externalId,
        resource.kind, resource.name, resource.openUrl ?? null,
        resource.portableReference
          ? serializePortableResourceReferenceCarrier(resource.portableReference)
          : null,
        resource.version ?? null, resource.status, resource.statusReasonCode ?? null,
        resource.unavailableAt ?? null, resource.revokedAt ?? null, resource.invalidatedAt ?? null,
        resource.revision, resource.createdAt, resource.updatedAt]
    )
  }

  async updateResourceRef(resource: StoredResourceRef, expectedRevision: number): Promise<void> {
    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.resource_refs
       SET status=$2,status_reason_code=$3,unavailable_at=$4,revoked_at=$5,invalidated_at=$6,revision=$7,updated_at=$8
       WHERE resource_ref_id=$1 AND revision=$9`,
      [resource.resourceRefId, resource.status, resource.statusReasonCode ?? null,
        resource.unavailableAt ?? null, resource.revokedAt ?? null, resource.invalidatedAt ?? null,
        resource.revision, resource.updatedAt, expectedRevision]
    )
    expectRevision(result.rowCount)
  }

  async supersedeExpiredInboxMessages(
    recipient: InboxRecipient,
    expiredAt: string
  ): Promise<StoredInboxCursor | null> {
    const locked = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.inbox_cursors
       WHERE recipient_kind=$1 AND recipient_id=$2
       FOR UPDATE`,
      [recipient.kind, recipient.id]
    )
    if (!locked.rows[0]) return null
    const cursor = mapCursor(locked.rows[0])
    await this.sql.query(
      `UPDATE sciforge_collaboration.inbox_messages
       SET disposition='superseded',superseded_at=$4
       WHERE recipient_kind=$1
         AND recipient_id=$2
         AND sequence>$3
         AND disposition='active'
         AND expires_at<=$4`,
      [recipient.kind, recipient.id, cursor.ackedSequence, expiredAt]
    )
    return cursor
  }

  async supersedeCoordinatorInbox(
    projectId: string,
    recipientAgentId: string,
    supersededAt: string
  ): Promise<StoredInboxMessage[]> {
    const result = await this.sql.query(
      `WITH changed AS (
         UPDATE sciforge_collaboration.inbox_messages AS message
         SET disposition='superseded',superseded_at=$3
         WHERE message.recipient_kind='agent'
           AND message.recipient_id=$2
           AND message.disposition='active'
           AND message.sequence>COALESCE((
             SELECT cursor.acked_sequence
             FROM sciforge_collaboration.inbox_cursors AS cursor
             WHERE cursor.recipient_kind='agent' AND cursor.recipient_id=$2
           ),0)
           AND COALESCE(message.payload->>'projectId', message.payload->'answer'->>'projectId')=$1
           AND message.message_type IN (
             'task.updated',
             'project_record.submitted',
             'project.input.received',
             'project.endpoint.updated',
             'project.started',
             'human.answer.received'
           )
         RETURNING message.*
       )
       SELECT * FROM changed ORDER BY sequence`,
      [projectId, recipientAgentId, supersededAt]
    )
    return result.rows.map(mapInbox)
  }

  async appendInbox(
    message: Omit<StoredInboxMessage, 'sequence' | 'disposition'>
  ): Promise<StoredInboxMessage> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.inbox_cursors(recipient_kind,recipient_id,next_sequence,acked_sequence,updated_at)
       VALUES ($1,$2,1,0,$3) ON CONFLICT (recipient_kind,recipient_id) DO NOTHING`,
      [message.recipient.kind, message.recipient.id, message.createdAt]
    )
    const cursor = await this.sql.query<{ next_sequence: unknown }>(
      `UPDATE sciforge_collaboration.inbox_cursors
       SET next_sequence=next_sequence+1,updated_at=$3
       WHERE recipient_kind=$1 AND recipient_id=$2
       RETURNING next_sequence-1 AS next_sequence`,
      [message.recipient.kind, message.recipient.id, message.createdAt]
    )
    const sequence = number(cursor.rows[0]?.next_sequence)
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.inbox_messages
       (recipient_kind,recipient_id,sequence,message_id,message_type,payload,disposition,superseded_at,
        superseded_by_message_id,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
      [message.recipient.kind, message.recipient.id, sequence, message.messageId, message.messageType,
        JSON.stringify(message.payload), 'active', null, null, message.createdAt, message.expiresAt]
    )
    return {
      recipient: message.recipient,
      sequence,
      messageId: message.messageId,
      messageType: message.messageType,
      payload: message.payload,
      disposition: 'active',
      createdAt: message.createdAt,
      expiresAt: message.expiresAt
    }
  }

  async ackInbox(recipient: InboxRecipient, throughSequence: number, updatedAt: string): Promise<StoredInboxCursor> {
    const locked = await this.sql.query(
      `SELECT * FROM sciforge_collaboration.inbox_cursors
       WHERE recipient_kind=$1 AND recipient_id=$2
       FOR UPDATE`,
      [recipient.kind, recipient.id]
    )
    if (!locked.rows[0]) {
      throw new CollaborationServiceError('validation_failed', 'Inbox does not exist for this recipient.')
    }
    const cursor = mapCursor(locked.rows[0])
    if (throughSequence <= cursor.ackedSequence) return cursor

    const target = await this.sql.query(
      `SELECT sequence FROM sciforge_collaboration.inbox_messages
       WHERE recipient_kind=$1 AND recipient_id=$2 AND sequence=$3
       FOR SHARE`,
      [recipient.kind, recipient.id, throughSequence]
    )
    if (!target.rows[0] || throughSequence >= cursor.nextSequence) {
      throw new CollaborationServiceError('validation_failed', 'Inbox acknowledgement target does not exist.')
    }

    const gap = await this.sql.query<{ total: unknown; active: unknown }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE disposition='active') AS active
       FROM sciforge_collaboration.inbox_messages
       WHERE recipient_kind=$1 AND recipient_id=$2
         AND sequence>$3 AND sequence<$4`,
      [recipient.kind, recipient.id, cursor.ackedSequence, throughSequence]
    )
    const expectedGap = throughSequence - cursor.ackedSequence - 1
    if (number(gap.rows[0]?.total) !== expectedGap || number(gap.rows[0]?.active) !== 0) {
      throw new CollaborationServiceError(
        'inbox_ack_gap',
        'Inbox acknowledgement cannot skip an active or missing message.',
        { details: { ackedSequence: cursor.ackedSequence, nextSequence: cursor.nextSequence } }
      )
    }

    const result = await this.sql.query(
      `UPDATE sciforge_collaboration.inbox_cursors
       SET acked_sequence=$3,updated_at=$4
       WHERE recipient_kind=$1 AND recipient_id=$2 AND acked_sequence=$5
       RETURNING *`,
      [recipient.kind, recipient.id, throughSequence, updatedAt, cursor.ackedSequence]
    )
    expectRevision(result.rowCount)
    return mapCursor(result.rows[0])
  }

  async insertReceipt(receipt: StoredReceipt): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.receipts
       (receipt_id,actor_key,idempotency_key,request_digest,operation,resource_kind,resource_id,response,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [receipt.receiptId, receipt.actorKey, receipt.idempotencyKey, Buffer.from(receipt.requestDigest, 'hex'),
        receipt.operation, receipt.resourceKind ?? null, receipt.resourceId ?? null, JSON.stringify(receipt.response),
        receipt.createdAt, receipt.expiresAt]
    )
  }

  async insertAudit(event: StoredAuditEvent): Promise<void> {
    await this.sql.query(
      `INSERT INTO sciforge_collaboration.audit_events
       (audit_event_id,actor_kind,actor_user_id,actor_endpoint_id,actor_agent_id,action,resource_kind,resource_id,
        outcome,metadata,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [event.auditEventId, event.actorKind, event.actorUserId ?? null, event.actorEndpointId ?? null,
        event.actorAgentId ?? null, event.action, event.resourceKind ?? null, event.resourceId ?? null,
        event.outcome, JSON.stringify(event.metadata), event.createdAt]
    )
  }
}

function expectRevision(rowCount: number | null): void {
  if (rowCount !== 1) throw new CollaborationServiceError('revision_conflict', 'The resource revision changed before this write.')
}

function advisoryLockKey(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest().readBigInt64BE(0).toString()
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareSignedIntegerStrings(left: string, right: string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function translateDatabaseError(error: unknown): unknown {
  if (error instanceof CollaborationServiceError) return error
  const candidate = error as { code?: unknown; constraint?: unknown }
  if (candidate?.code === '40P01' || candidate?.code === '40001') {
    return new CollaborationServiceError(
      'revision_conflict',
      'Concurrent collaboration routing changed while acquiring write locks.',
      { retryable: true }
    )
  }
  if (candidate?.code === '23505') {
    if (typeof candidate.constraint === 'string') {
      const mapped = IDENTITY_UNIQUE_CONSTRAINT_ERRORS.get(candidate.constraint)
      if (mapped) return new CollaborationServiceError(mapped.code, mapped.message)
    }
    return new CollaborationServiceError('identity_conflict', 'A unique collaboration identity is already active.')
  }
  if (candidate?.code === '23503') {
    if (candidate.constraint === 'agent_nodes_device_owner_fk') {
      return new CollaborationServiceError('ownership_conflict', 'The Agent and Device ownership linkage is invalid.')
    }
    return new CollaborationServiceError('validation_failed', 'A referenced collaboration resource does not exist.')
  }
  if (
    candidate?.code === '23514' &&
    typeof candidate.constraint === 'string' &&
    IDENTITY_VALIDATION_CONSTRAINTS.has(candidate.constraint)
  ) {
    return new CollaborationServiceError('validation_failed', 'Identity metadata failed a storage safety constraint.')
  }
  if (
    candidate?.code === '23514' &&
    typeof candidate.constraint === 'string' &&
    RESOURCE_REF_VALIDATION_CONSTRAINTS.has(candidate.constraint)
  ) {
    return new CollaborationServiceError('validation_failed', 'ResourceRef metadata failed a storage safety constraint.')
  }
  return error
}

const RESOURCE_REF_VALIDATION_CONSTRAINTS = new Set([
  'resource_refs_provider_format',
  'resource_refs_external_id_safe',
  'resource_refs_kind_format',
  'resource_refs_name_safe',
  'resource_refs_open_url_safe',
  'resource_refs_portable_reference_safe',
  'resource_refs_provider_version_safe',
  'resource_refs_status_valid',
  'resource_refs_revision_valid',
  'resource_refs_provenance_complete',
  'resource_refs_status_reason_format',
  'resource_refs_status_timestamp_consistent'
])

const IDENTITY_UNIQUE_CONSTRAINT_ERRORS = new Map<string, Readonly<{
  code: 'identity_conflict' | 'IDENTITY_ALREADY_BOUND' | 'ownership_conflict'
  message: string
}>>([
  ['oidc_identities_pkey', { code: 'identity_conflict', message: 'The OIDC identity already exists.' }],
  ['oidc_identities_issuer_subject_unique', { code: 'identity_conflict', message: 'The OIDC identity already exists.' }],
  ['oidc_identities_identity_owner_unique', { code: 'identity_conflict', message: 'The OIDC identity owner is inconsistent.' }],
  ['device_enrollments_pkey', { code: 'identity_conflict', message: 'The Device enrollment already exists.' }],
  ['device_enrollments_nonce_digest_unique', { code: 'identity_conflict', message: 'The Device enrollment already exists.' }],
  ['devices_pkey', { code: 'identity_conflict', message: 'The Device identity already exists.' }],
  ['devices_installation_unique', { code: 'ownership_conflict', message: 'The installation is already owned by a Device.' }],
  ['devices_identity_owner_unique', { code: 'ownership_conflict', message: 'The Device owner is inconsistent.' }],
  ['human_endpoint_bindings_external_identity_unique', {
    code: 'identity_conflict', message: 'The external identity already exists.'
  }],
  ['human_endpoint_bindings_other_provider_identity_active_unique', {
    code: 'identity_conflict', message: 'The provider identity is already active.'
  }],
  ['human_endpoint_bindings_zulip_provider_identity_active_unique', {
    code: 'IDENTITY_ALREADY_BOUND', message: 'The Zulip identity is already bound.'
  }],
  ['human_endpoint_bindings_zulip_user_realm_active_unique', {
    code: 'identity_conflict', message: 'The User already has an active Zulip identity in this realm.'
  }],
  ['zulip_binding_requests_pkey', { code: 'identity_conflict', message: 'The binding request already exists.' }],
  ['zulip_binding_requests_code_digest_unique', {
    code: 'identity_conflict', message: 'The binding request already exists.'
  }],
  ['zulip_binding_requests_provider_event_unique', {
    code: 'identity_conflict', message: 'The provider event was already processed.'
  }],
  ['zulip_binding_requests_pending_user_realm_unique', {
    code: 'identity_conflict', message: 'A pending binding request already exists for this User and realm.'
  }]
])

const IDENTITY_VALIDATION_CONSTRAINTS = new Set([
  'agent_nodes_active_device_required',
  'device_enrollments_status_valid',
  'device_enrollments_consumption_state',
  'device_enrollments_revision_valid',
  'device_enrollments_times',
  'devices_display_name_valid',
  'devices_platform_shape',
  'devices_public_key_shape',
  'devices_capability_summary_shape',
  'devices_status_valid',
  'devices_status_timestamps',
  'devices_revision_valid',
  'devices_times',
  'human_endpoint_bindings_external_identity_shape',
  'oidc_identities_identity_shape',
  'oidc_identities_status_valid',
  'oidc_identities_status_timestamps',
  'oidc_identities_revision_valid',
  'oidc_identities_times',
  'zulip_binding_requests_status_valid',
  'zulip_binding_requests_confirmation_state',
  'zulip_binding_requests_revision_valid',
  'zulip_binding_requests_times'
])

function string(row: SqlRow, key: string): string { return String(row[key]) }
function optionalString(row: SqlRow, key: string): string | undefined { return row[key] == null ? undefined : String(row[key]) }
function number(value: unknown): number { return Number(value ?? 0) }
function boundedReadLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_001) {
    throw new Error('Repository bounded-read limit is invalid.')
  }
  return value
}
function boundedPageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new Error('Repository page size is invalid.')
  }
  return value
}
function nonNegativeIntegerText(value: unknown): string {
  const text = String(value ?? '')
  if (!/^\d+$/u.test(text)) throw new Error('Repository watermark is not a non-negative integer.')
  return text
}
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString() }
function optionalIso(value: unknown): string | undefined { return value == null ? undefined : iso(value) }
function digest(value: unknown): string { return Buffer.isBuffer(value) ? value.toString('hex') : String(value) }
function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function jsonArray(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function jsonStrings(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : [] }

function mapUser(row: SqlRow): StoredUser {
  return { userId: string(row, 'user_id'), displayName: string(row, 'display_name'), status: string(row, 'status') as StoredUser['status'],
    revision: number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), revokedAt: optionalIso(row.revoked_at) }
}
function mapOidcIdentity(row: SqlRow): StoredOidcIdentity {
  return {
    identityId: string(row, 'identity_id'), userId: string(row, 'user_id'), issuer: string(row, 'issuer'),
    subject: string(row, 'subject'), emailAtLinkTime: optionalString(row, 'email_at_link_time'),
    status: string(row, 'status') as StoredOidcIdentity['status'], revision: number(row.revision),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), revokedAt: optionalIso(row.revoked_at)
  }
}
function mapDeviceEnrollment(row: SqlRow): StoredDeviceEnrollment {
  return {
    enrollmentId: string(row, 'enrollment_id'), userId: string(row, 'user_id'),
    installationId: string(row, 'installation_id'), nonceDigest: digest(row.nonce_digest),
    status: string(row, 'status') as StoredDeviceEnrollment['status'], revision: number(row.revision),
    expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    consumedAt: optionalIso(row.consumed_at)
  }
}
function mapDevice(row: SqlRow): StoredDevice {
  return {
    deviceId: string(row, 'device_id'), userId: string(row, 'user_id'),
    installationId: string(row, 'installation_id'), displayName: string(row, 'display_name'),
    platform: jsonRecord(row.platform) as StoredDevice['platform'],
    publicKeyJwk: jsonRecord(row.public_key_jwk) as StoredDevice['publicKeyJwk'],
    capabilitySummary: jsonStrings(row.capability_summary), status: string(row, 'status') as StoredDevice['status'],
    revision: number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    revokedAt: optionalIso(row.revoked_at)
  }
}
function mapZulipBindingRequest(row: SqlRow): StoredZulipBindingRequest {
  return {
    bindingRequestId: string(row, 'binding_request_id'), userId: string(row, 'user_id'),
    realmUrl: string(row, 'realm_url'), codeDigest: digest(row.code_digest),
    status: string(row, 'status') as StoredZulipBindingRequest['status'], revision: number(row.revision),
    expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    confirmedAt: optionalIso(row.confirmed_at), externalIdentityId: optionalString(row, 'external_identity_id'),
    serviceActorId: optionalString(row, 'service_actor_id'), providerEventId: optionalString(row, 'provider_event_id')
  }
}
function mapExternalIdentity(row: SqlRow): StoredExternalIdentity {
  return {
    externalIdentityId: string(row, 'external_identity_id'), humanEndpointId: string(row, 'human_endpoint_id'),
    userId: string(row, 'user_id'), provider: 'zulip', realmUrl: string(row, 'realm_url'),
    realmId: string(row, 'realm_id'), zulipUserId: string(row, 'provider_user_id'),
    status: string(row, 'status') as StoredExternalIdentity['status'], revision: number(row.revision),
    verifiedAt: iso(row.verified_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    revokedAt: optionalIso(row.revoked_at)
  }
}
function mapChallenge(row: SqlRow): StoredChallenge {
  return { challengeId: string(row, 'challenge_id'), requestedUserId: optionalString(row, 'requested_user_id'), provider: string(row, 'provider'),
    realmId: string(row, 'realm_id'), expectedProviderUserId: optionalString(row, 'expected_provider_user_id'),
    challengeDigest: digest(row.challenge_digest), pollSecretDigest: digest(row.poll_secret_digest),
    requestedDisplayName: string(row, 'requested_display_name'), expiresAt: iso(row.expires_at), createdAt: iso(row.created_at),
    verifiedUserId: optionalString(row, 'verified_user_id'), verifiedEndpointId: optionalString(row, 'verified_endpoint_id'),
    verifiedAt: optionalIso(row.verified_at), consumedAt: optionalIso(row.consumed_at) }
}
function mapEndpoint(row: SqlRow): StoredEndpoint {
  return { humanEndpointId: string(row, 'human_endpoint_id'), userId: string(row, 'user_id'), provider: string(row, 'provider'),
    realmId: string(row, 'realm_id'), providerUserId: string(row, 'provider_user_id'), displayName: optionalString(row, 'display_name'),
    assurance: string(row, 'assurance') as StoredEndpoint['assurance'], status: string(row, 'status') as StoredEndpoint['status'],
    revision: number(row.revision), verifiedAt: iso(row.verified_at), updatedAt: iso(row.updated_at), revokedAt: optionalIso(row.revoked_at) }
}
function mapAgent(row: SqlRow): StoredAgent {
  return { agentId: string(row, 'agent_id'), installationId: optionalString(row, 'installation_id'),
    deviceId: optionalString(row, 'device_id'), ownerUserId: string(row, 'owner_user_id'),
    displayName: string(row, 'display_name'), nodeType: string(row, 'node_type'), capabilities: jsonStrings(row.capabilities),
    status: string(row, 'status') as StoredAgent['status'], connectionStatus: string(row, 'connection_status') as StoredAgent['connectionStatus'],
    credentialGeneration: number(row.credential_generation), revision: number(row.revision), lastSeenAt: optionalIso(row.last_seen_at),
    updatedAt: iso(row.updated_at), revokedAt: optionalIso(row.revoked_at) }
}
function mapAgentCapabilityProfile(row: SqlRow): StoredAgentCapabilityProfile {
  return {
    agentId: string(row, 'agent_id'),
    ownerUserId: string(row, 'owner_user_id'),
    nodeType: string(row, 'node_type') as StoredAgentCapabilityProfile['nodeType'],
    osFamily: string(row, 'os_family') as StoredAgentCapabilityProfile['osFamily'],
    osArchitecture: string(row, 'os_architecture') as StoredAgentCapabilityProfile['osArchitecture'],
    osVersion: optionalString(row, 'os_version'),
    runtimeIds: jsonStrings(row.runtime_ids),
    capabilities: jsonArray(row.capabilities) as StoredAgentCapabilityProfile['capabilities'],
    gpu: jsonArray(row.gpu) as StoredAgentCapabilityProfile['gpu'],
    vpnAccessIds: jsonStrings(row.vpn_access_ids),
    slurmClusterIds: jsonStrings(row.slurm_cluster_ids),
    accessibleResourceRefIds: jsonStrings(row.accessible_resource_ref_ids),
    resultReturnPolicy: jsonRecord(row.result_return_policy) as StoredAgentCapabilityProfile['resultReturnPolicy'],
    reportedAt: iso(row.reported_at),
    expiresAt: iso(row.expires_at),
    revision: number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  }
}
function mapWorkerDirectoryEntry(row: SqlRow): WorkerDirectoryEntryView {
  const capabilities = jsonArray(row.capabilities) as StoredAgentCapabilityProfile['capabilities']
  const gpu = jsonArray(row.gpu) as StoredAgentCapabilityProfile['gpu']
  return {
    ownerUserId: string(row, 'owner_user_id'),
    agentId: string(row, 'agent_id'),
    displayName: string(row, 'display_name'),
    nodeType: string(row, 'node_type') as WorkerDirectoryEntryView['nodeType'],
    os: {
      family: string(row, 'os_family') as WorkerDirectoryEntryView['os']['family'],
      architecture: string(row, 'os_architecture') as WorkerDirectoryEntryView['os']['architecture']
    },
    runtimeIds: [...new Set(jsonStrings(row.runtime_ids))].sort((left, right) => left.localeCompare(right)),
    capabilityIds: [...new Set(capabilities.map((capability) => capability.capabilityId))]
      .sort((left, right) => left.localeCompare(right)),
    gpu: gpu.map((entry) => ({
      ...(entry.vendor ? { vendor: entry.vendor } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.memoryGB !== undefined ? { memoryGB: entry.memoryGB } : {})
    })),
    status: string(row, 'portal_status') as WorkerDirectoryEntryView['status'],
    lastSeenAt: iso(row.last_seen_at),
    profileExpiresAt: iso(row.profile_expires_at),
    revision: number(row.revision)
  }
}
function mapCredential(row: SqlRow): StoredCredential {
  return { credentialId: string(row, 'credential_id'), kind: string(row, 'kind') as StoredCredential['kind'],
    subjectUserId: string(row, 'subject_user_id'), subjectAgentId: optionalString(row, 'subject_agent_id'), tokenDigest: digest(row.token_digest),
    assurance: string(row, 'assurance') as StoredCredential['assurance'], generation: number(row.generation), createdAt: iso(row.created_at),
    expiresAt: optionalIso(row.expires_at), revokedAt: optionalIso(row.revoked_at) }
}
function mapParticipant(row: SqlRow): StoredParticipant {
  return { userId: string(row, 'user_id'), primaryHumanEndpointId: optionalString(row, 'primary_human_endpoint_id'),
    primaryAgentId: optionalString(row, 'primary_agent_id'), status: string(row, 'status') as StoredParticipant['status'],
    revision: number(row.revision), updatedAt: iso(row.updated_at) }
}
function mapProject(row: SqlRow): StoredProject {
  return { projectId: string(row, 'project_id'), ownerUserId: string(row, 'owner_user_id'), displayName: string(row, 'display_name'), goal: string(row, 'goal'),
    status: string(row, 'status') as StoredProject['status'], coordinatorAgentId: string(row, 'coordinator_agent_id'),
    budgets: { maxTasks: number(row.max_tasks), maxTasksPerRound: number(row.max_tasks_per_round),
      maxTaskRetries: number(row.max_task_retries), maxCoordinationRounds: number(row.max_coordination_rounds) },
    coordinationRound: number(row.coordination_round), revision: number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}
function mapMember(row: SqlRow): StoredProjectMember {
  return { projectId: string(row, 'project_id'), userId: string(row, 'user_id'), role: string(row, 'role') as StoredProjectMember['role'],
    active: Boolean(row.active), createdAt: iso(row.created_at) }
}
function mapTask(row: SqlRow): StoredTask {
  return { taskId: string(row, 'task_id'), projectId: string(row, 'project_id'), executionId: string(row, 'execution_id'),
    assigneeAgentId: string(row, 'assignee_agent_id'), assigneeUserId: string(row, 'assignee_user_id'),
    createdByAgentId: string(row, 'created_by_agent_id'), title: string(row, 'title'), objective: string(row, 'objective'),
    completionCriteria: jsonArray(row.completion_criteria) as StoredTask['completionCriteria'],
    dependencyTaskIds: jsonStrings(row.dependency_task_ids),
    requiredCapabilities: jsonRecord(row.required_capabilities) as StoredTask['requiredCapabilities'],
    resourceRefIds: jsonStrings(row.resource_ref_ids),
    ...(row.file_intent == null
      ? {}
      : { fileIntent: jsonRecord(row.file_intent) as StoredTask['fileIntent'] }),
    authorizationRequirements: jsonArray(row.authorization_requirements) as StoredTask['authorizationRequirements'],
    status: string(row, 'status') as StoredTask['status'], retryCount: number(row.retry_count), maxRetries: number(row.max_retries),
    coordinationRound: number(row.coordination_round), activeTurnId: optionalString(row, 'active_turn_id'),
    ...(row.progress_percent == null ? {} : { progress: { percent: number(row.progress_percent),
      summary: string(row, 'progress_summary'), reportedAt: iso(row.progress_reported_at) } }),
    resultSummary: optionalString(row, 'result_summary'), resultRecordId: optionalString(row, 'result_record_id'),
    safeFailureCode: optionalString(row, 'safe_failure_code'), safeFailureSummary: optionalString(row, 'safe_failure_summary'),
    revision: number(row.revision),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), completedAt: optionalIso(row.completed_at) }
}
function mapRecord(row: SqlRow): StoredProjectRecord {
  return { projectRecordId: string(row, 'project_record_id'), projectId: string(row, 'project_id'),
    kind: string(row, 'kind') as StoredProjectRecord['kind'], status: string(row, 'status') as StoredProjectRecord['status'],
    summary: string(row, 'summary'), authorUserId: string(row, 'author_user_id'), authorAgentId: optionalString(row, 'author_agent_id'),
    sourceTaskId: optionalString(row, 'source_task_id'), sourceExecutionId: optionalString(row, 'source_execution_id'),
    sourceRevision: row.source_revision == null ? undefined : number(row.source_revision),
    criterionEvidence: jsonArray(row.criterion_evidence) as StoredProjectRecord['criterionEvidence'],
    resourceRefIds: jsonStrings(row.resource_ref_ids), logSummary: optionalString(row, 'log_summary'),
    acceptedByUserId: optionalString(row, 'accepted_by_user_id'), acceptedByAgentId: optionalString(row, 'accepted_by_agent_id'),
    acceptedAt: optionalIso(row.accepted_at), revision: number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}
function mapResourceRef(row: SqlRow): StoredResourceRef {
  return {
    resourceRefId: string(row, 'resource_ref_id'),
    projectId: string(row, 'project_id'),
    ...(row.task_id == null ? {} : { taskId: string(row, 'task_id') }),
    ...(row.execution_id == null ? {} : { executionId: string(row, 'execution_id') }),
    ...(row.task_revision == null ? {} : { taskRevision: number(row.task_revision) }),
    createdByUserId: string(row, 'created_by_user_id'),
    ...(row.created_by_agent_id == null ? {} : { createdByAgentId: string(row, 'created_by_agent_id') }),
    provider: string(row, 'provider'),
    externalId: string(row, 'external_id'),
    kind: string(row, 'kind'),
    name: string(row, 'name'),
    ...(row.open_url == null ? {} : { openUrl: string(row, 'open_url') }),
    ...(row.portable_reference == null
      ? {}
      : { portableReference: deserializePortableResourceReferenceCarrier(string(row, 'portable_reference')) }),
    version: optionalString(row, 'provider_version'),
    status: string(row, 'status') as StoredResourceRef['status'],
    ...(row.status_reason_code == null ? {} : { statusReasonCode: string(row, 'status_reason_code') }),
    ...(row.unavailable_at == null ? {} : { unavailableAt: iso(row.unavailable_at) }),
    ...(row.revoked_at == null ? {} : { revokedAt: iso(row.revoked_at) }),
    ...(row.invalidated_at == null ? {} : { invalidatedAt: iso(row.invalidated_at) }),
    revision: number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  }
}
function mapProjection(row: SqlRow): StoredProjection {
  return { projectionId: string(row, 'projection_id'), ownerUserId: string(row, 'owner_user_id'), agentId: string(row, 'agent_id'),
    humanEndpointId: string(row, 'human_endpoint_id'), locator: jsonRecord(row.locator) as StoredProjection['locator'],
    locatorRevision: number(row.locator_revision), displayName: string(row, 'display_name'), status: string(row, 'status') as StoredProjection['status'],
    allowedSenderUserIds: jsonStrings(row.allowed_sender_user_ids), lastErrorCode: optionalString(row, 'last_error_code'),
    revision: number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}
function mapManagedContainer(row: SqlRow): StoredManagedContainer {
  return {
    managedContainerId: string(row, 'managed_container_id'),
    ownerUserId: string(row, 'owner_user_id'),
    humanEndpointId: string(row, 'human_endpoint_id'),
    provider: string(row, 'provider'),
    realmId: string(row, 'realm_id'),
    ownerProviderUserId: string(row, 'owner_provider_user_id'),
    stableKey: string(row, 'stable_key'),
    displayName: string(row, 'display_name'),
    externalContainerId: optionalString(row, 'external_container_id'),
    policy: jsonRecord(row.policy) as StoredManagedContainer['policy'],
    observedChecks: row.observed_checks == null
      ? undefined
      : jsonRecord(row.observed_checks) as StoredManagedContainer['observedChecks'],
    status: string(row, 'status') as StoredManagedContainer['status'],
    lastVerifiedAt: optionalIso(row.last_verified_at),
    safeErrorCode: optionalString(row, 'safe_error_code'),
    revision: number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  }
}
function mapManagedContainerJob(row: SqlRow): StoredManagedContainerJob {
  return {
    jobId: string(row, 'job_id'),
    managedContainerId: string(row, 'managed_container_id'),
    operation: string(row, 'operation') as StoredManagedContainerJob['operation'],
    desiredRevision: number(row.desired_revision),
    state: string(row, 'state') as StoredManagedContainerJob['state'],
    attemptCount: number(row.attempt_count),
    nextAttemptAt: iso(row.next_attempt_at),
    leaseOwner: optionalString(row, 'lease_owner'),
    leaseExpiresAt: optionalIso(row.lease_expires_at),
    safeErrorCode: optionalString(row, 'safe_error_code'),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  }
}
function mapProjectBinding(row: SqlRow): StoredProjectEndpointBinding {
  return { projectEndpointBindingId: string(row, 'project_endpoint_binding_id'), projectId: string(row, 'project_id'),
    locator: jsonRecord(row.locator) as StoredProjectEndpointBinding['locator'], locatorRevision: number(row.locator_revision),
    status: string(row, 'status') as StoredProjectEndpointBinding['status'], lastErrorCode: optionalString(row, 'last_error_code'),
    revision: number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}
function mapProjectContentSpaceBinding(row: SqlRow): StoredProjectContentSpaceBinding {
  return {
    projectId: string(row, 'project_id'),
    rootResourceRefId: string(row, 'root_resource_ref_id'),
    rootReferenceDigest: digest(row.root_reference_digest),
    status: string(row, 'status') as StoredProjectContentSpaceBinding['status'],
    revision: number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  }
}
function mapProjectInput(row: SqlRow): StoredProjectInput {
  return { projectInputId: string(row, 'project_input_id'), projectId: string(row, 'project_id'),
    senderUserId: string(row, 'sender_user_id'), sourceHumanEndpointId: string(row, 'source_human_endpoint_id'),
    providerMessageId: string(row, 'provider_message_id'), sequence: number(row.sequence), text: string(row, 'text'),
    status: string(row, 'status') as StoredProjectInput['status'], revision: number(row.revision),
    occurredAt: iso(row.occurred_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}
function mapHumanRequest(row: SqlRow): StoredHumanRequest {
  return { humanRequestId: string(row, 'human_request_id'), projectId: string(row, 'project_id'),
    sourceKind: string(row, 'source_kind') as StoredHumanRequest['sourceKind'],
    ...(row.task_id == null ? {} : { taskId: string(row, 'task_id') }),
    ...(row.execution_id == null ? {} : { executionId: string(row, 'execution_id') }),
    ...(row.source_inbox_message_id == null ? {} : { sourceInboxMessageId: string(row, 'source_inbox_message_id') }),
    targetUserId: string(row, 'target_user_id'), requestedByAgentId: string(row, 'requested_by_agent_id'),
    requiredAssurance: string(row, 'required_assurance') as StoredHumanRequest['requiredAssurance'], prompt: string(row, 'prompt'),
    ...(row.confirmable_action == null ? {} : {
      confirmableAction: jsonRecord(row.confirmable_action) as StoredHumanRequest['confirmableAction']
    }),
    status: string(row, 'status') as StoredHumanRequest['status'], revision: number(row.revision), expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}
function mapHumanAnswer(row: SqlRow): StoredHumanAnswer {
  return { humanAnswerId: string(row, 'human_answer_id'), humanRequestId: string(row, 'human_request_id'),
    projectId: string(row, 'project_id'),
    ...(row.task_id == null ? {} : { taskId: string(row, 'task_id') }),
    ...(row.execution_id == null ? {} : { executionId: string(row, 'execution_id') }),
    requestRevision: number(row.request_revision),
    answeredByUserId: string(row, 'answered_by_user_id'), answeredFromHumanEndpointId: string(row, 'answered_from_human_endpoint_id'),
    assurance: string(row, 'assurance') as StoredHumanAnswer['assurance'], answer: string(row, 'answer'),
    ...(row.decision == null ? {} : { decision: string(row, 'decision') as StoredHumanAnswer['decision'] }),
    ...(row.confirmation_id == null ? {} : { confirmationId: string(row, 'confirmation_id') }),
    revision: number(row.revision),
    answeredAt: iso(row.answered_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}
function mapCursor(row: SqlRow): StoredInboxCursor {
  return { recipient: { kind: string(row, 'recipient_kind') as InboxRecipient['kind'], id: string(row, 'recipient_id') },
    nextSequence: number(row.next_sequence), ackedSequence: number(row.acked_sequence), updatedAt: iso(row.updated_at) }
}
function mapInbox(row: SqlRow): StoredInboxMessage {
  return { recipient: { kind: string(row, 'recipient_kind') as InboxRecipient['kind'], id: string(row, 'recipient_id') },
    sequence: number(row.sequence), messageId: string(row, 'message_id'), messageType: string(row, 'message_type'), payload: jsonRecord(row.payload),
    disposition: string(row, 'disposition') as StoredInboxMessage['disposition'],
    ...(row.superseded_at == null ? {} : { supersededAt: iso(row.superseded_at) }),
    ...(row.superseded_by_message_id == null ? {} : { supersededByMessageId: string(row, 'superseded_by_message_id') }),
    createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) }
}
function mapActionConfirmation(row: SqlRow): StoredActionConfirmation {
  return {
    confirmationId: string(row, 'confirmation_id'),
    humanRequestId: string(row, 'human_request_id'),
    projectId: string(row, 'project_id'),
    targetUserId: string(row, 'target_user_id'),
    coordinatorAgentId: string(row, 'coordinator_agent_id'),
    action: jsonRecord(row.action) as StoredActionConfirmation['action'],
    actionDigest: digest(row.action_digest),
    status: string(row, 'status') as StoredActionConfirmation['status'],
    approvedAt: iso(row.approved_at),
    expiresAt: iso(row.expires_at),
    consumedAt: optionalIso(row.consumed_at),
    consumedByActorKey: optionalString(row, 'consumed_by_actor_key'),
    consumedOperation: optionalString(row, 'consumed_operation'),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  }
}
function mapReceipt(row: SqlRow): StoredReceipt {
  return { receiptId: string(row, 'receipt_id'), actorKey: string(row, 'actor_key'), idempotencyKey: string(row, 'idempotency_key'),
    requestDigest: digest(row.request_digest), operation: string(row, 'operation'), resourceKind: optionalString(row, 'resource_kind'),
    resourceId: optionalString(row, 'resource_id'), response: jsonRecord(row.response), createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) }
}
