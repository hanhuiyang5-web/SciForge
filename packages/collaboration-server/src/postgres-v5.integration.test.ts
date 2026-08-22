import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { serializePortableResourceReferenceCarrier } from '@sciforge/collaboration-contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// @ts-expect-error The vendored dynamic Ed25519 fixture is intentionally plain ESM.
import { createDeviceFixture } from '../../../test-fixtures/collaboration/unified-identity/device-fixture.mjs'
// @ts-expect-error This test-only bridge re-exports E's exact public Content Space codec.
import {
  parsePortableArtifactReference,
  toPortableArtifactReference
} from '../../../test-fixtures/collaboration/e-content-space-portable.mjs'
import { AuthenticationService, type UserActor } from './auth.js'
import { toResourceRef } from './contracts.js'
import { CollaborationServiceError } from './errors.js'
import { IdentityService } from './identity-service.js'
import {
  COLLABORATION_SCHEMA_VERSION,
  isCollaborationDatabaseReady,
  runCollaborationMigrations
} from './migrations.js'
import type { StoredAgent } from './model.js'
import type { VerifiedOidcIdentity } from './oidc.js'
import {
  createPostgresPool,
  PostgresCollaborationRepository,
  type SqlPool
} from './postgres.js'
import { CollaborationService } from './service.js'

const INTEGRATION_ENABLED = process.env.SCIFORGE_POSTGRES_V5_INTEGRATION === '1'
const describePostgresV5 = INTEGRATION_ENABLED ? describe : describe.skip
const NOW = new Date('2026-08-18T12:00:00.000Z')
const LEGACY_RECORD_AT = new Date(NOW.getTime() - 3_000)
const FIRST_LEGACY_TRANSFER_AT = new Date(NOW.getTime() - 2_000)
const SECOND_LEGACY_TRANSFER_AT = new Date(NOW.getTime() - 1_000)
const now = () => new Date(NOW)
const nowEpochSeconds = Math.floor(NOW.getTime() / 1_000)
const V5_BASELINE_MIGRATIONS = [
  '0002_resource_refs.sql',
  '0003_task_progress.sql',
  '0004_coordination_contract.sql',
  '0005_unified_identity_device_bindings.sql'
] as const

type MigrationEvidence = Readonly<{
  postgresVersion: string
  postgresVersionNumber: string
  versionsAtV1: number[]
  versionsAtV5: number[]
  versionsAtCurrent: number[]
  readyAtV1: boolean
  readyAtV5: boolean
  readyAtCurrent: boolean
  unsafeProjectRecordAuthorSourceRejected: boolean
  ambiguousProjectRecordAuthorTransferRejected: boolean
  equalTimestampProjectRecordAuthorTransferRejected: boolean
  activeProjectMembershipLimitRejected: boolean
  projectRecordLimitRejected: boolean
  humanNeededLimitRejected: boolean
  legacyProjectRecordAuthorUserAtV5: unknown
  legacyProjectRecordAuthorUserAtCurrent: unknown
  legacyProjectRecordAuthorAgentAtCurrent: unknown
  legacyTaskAssigneeUserAtCurrent: unknown
  transferredProjectRecordAuthorUserAtCurrent: unknown
  transferredProjectRecordAgentOwnerAtCurrent: unknown
  legacyProjectRecordAuthorUserNullableAtCurrent: unknown
  legacyAgentStatus: string
  legacyAgentDeviceId: unknown
  legacyCredentialRevoked: boolean
}>

describePostgresV5('real PostgreSQL v1 -> v5 -> current-schema collaboration integration', () => {
  let adminPool: SqlPool | undefined
  let databasePool: SqlPool | undefined
  let repository: PostgresCollaborationRepository | undefined
  let identities: IdentityService | undefined
  let collaboration: CollaborationService | undefined
  let authentication: AuthenticationService | undefined
  let databaseName: string | undefined
  let databaseCreated = false
  let migrationEvidence: MigrationEvidence | undefined

  beforeAll(async () => {
    const adminConnectionString = integrationAdminConnectionString()
    databaseName = temporaryDatabaseName()
    adminPool = createPostgresPool({
      connectionString: adminConnectionString,
      maxConnections: 1,
      statementTimeoutMs: 120_000
    })
    await adminPool.query(`CREATE DATABASE ${quotedDatabaseIdentifier(databaseName)}`)
    databaseCreated = true

    const databaseUrl = new URL(adminConnectionString)
    databaseUrl.pathname = `/${databaseName}`
    databasePool = createPostgresPool({
      connectionString: databaseUrl.toString(),
      maxConnections: 32,
      statementTimeoutMs: 120_000
    })
    repository = new PostgresCollaborationRepository(databasePool)

    const version = await databasePool.query<{ server_version: unknown }>('SHOW server_version')
    const versionNumber = await databasePool.query<{ server_version_num: unknown }>('SHOW server_version_num')
    const migrationV1 = await readFile(
      new URL('../migrations/0001_collaboration_schema.sql', import.meta.url),
      'utf8'
    )
    await databasePool.query(migrationV1)
    await seedLegacyV1Agent(databasePool)
    const versionsAtV1 = await migrationVersions(databasePool)
    const readyAtV1 = await isCollaborationDatabaseReady(databasePool)

    await applyMigrationFiles(databasePool, V5_BASELINE_MIGRATIONS)
    const versionsAtV5 = await migrationVersions(databasePool)
    const readyAtV5 = await isCollaborationDatabaseReady(databasePool)

    const legacyRecordAtV5 = await databasePool.query<{
      author_user_id: unknown
      author_agent_id: unknown
    }>(
      `SELECT author_user_id,author_agent_id
       FROM sciforge_collaboration.project_records
       WHERE source_task_id=$1`,
      ['tsk_pg_legacy_completed_0001']
    )
    const legacyRecordV5 = legacyRecordAtV5.rows[0]
    if (!legacyRecordV5 || legacyRecordV5.author_user_id !== null ||
        legacyRecordV5.author_agent_id !== 'agt_pg_legacy_agent_0001') {
      throw new Error('Schema v4 did not materialize the expected legacy Agent-only ProjectRecord fixture.')
    }

    await databasePool.query(
      `INSERT INTO sciforge_collaboration.project_records
         (project_record_id,project_id,kind,status,summary,author_user_id,author_agent_id,
          revision,created_at,updated_at)
       VALUES ($1,$2,'observation','candidate',$3,$4,$5,1,$6,$6)`,
      [
        'rec_pg_pretransfer_author_0001',
        'prj_pg_legacy_project_0001',
        'This immutable author predates an Agent ownership transfer.',
        'usr_pg_legacy_user_0001',
        'agt_pg_legacy_agent_0001',
        LEGACY_RECORD_AT.toISOString()
      ]
    )
    await databasePool.query(
      `WITH transferred AS (
         UPDATE sciforge_collaboration.agent_nodes
         SET owner_user_id=$2,revision=revision+1,updated_at=$3
         WHERE agent_id=$1
         RETURNING agent_id
       )
       INSERT INTO sciforge_collaboration.audit_events
         (audit_event_id,actor_kind,actor_user_id,action,resource_kind,resource_id,outcome,created_at)
       SELECT $4,'user',$5,'agent.owner.transfer','agent',agent_id,'accepted',$3
       FROM transferred`,
      [
        'agt_pg_legacy_agent_0001',
        'usr_pg_legacy_other_0001',
        FIRST_LEGACY_TRANSFER_AT.toISOString(),
        'audit_pg_legacy_transfer_0001',
        'usr_pg_legacy_user_0001'
      ]
    )
    await databasePool.query(
      `WITH transferred AS (
         UPDATE sciforge_collaboration.agent_nodes
         SET owner_user_id=$2,revision=revision+1,updated_at=$3
         WHERE agent_id=$1
         RETURNING agent_id
       )
       INSERT INTO sciforge_collaboration.audit_events
         (audit_event_id,actor_kind,actor_user_id,action,resource_kind,resource_id,outcome,created_at)
       SELECT $4,'user',$5,'agent.owner.transfer','agent',agent_id,'accepted',$3
       FROM transferred`,
      [
        'agt_pg_legacy_agent_0001',
        'usr_pg_legacy_final_0001',
        SECOND_LEGACY_TRANSFER_AT.toISOString(),
        'audit_pg_legacy_transfer_0002',
        'usr_pg_legacy_other_0001'
      ]
    )

    const cascadedTaskAssignee = await databasePool.query<{ assignee_user_id: unknown }>(
      `SELECT assignee_user_id
       FROM sciforge_collaboration.tasks
       WHERE task_id=$1`,
      ['tsk_pg_legacy_completed_0001']
    )
    if (cascadedTaskAssignee.rows[0]?.assignee_user_id !== 'usr_pg_legacy_final_0001') {
      throw new Error('The legacy Task owner did not cascade through both Agent ownership transfers.')
    }

    const migrationV9 = await readFile(
      new URL('../migrations/0009_portal_bounded_reads.sql', import.meta.url),
      'utf8'
    )
    await databasePool.query(
      `INSERT INTO sciforge_collaboration.audit_events
         (audit_event_id,actor_kind,actor_user_id,action,resource_kind,resource_id,outcome,created_at)
       VALUES ($1,'user',$2,'agent.owner.transfer','agent',$3,'accepted',$4)`,
      [
        'audit_pg_legacy_transfer_ambiguous_0001',
        'usr_pg_legacy_user_0001',
        'agt_pg_legacy_agent_0001',
        FIRST_LEGACY_TRANSFER_AT.toISOString()
      ]
    )
    const ambiguousProjectRecordAuthorTransferRejected = await migrationFailureMatches(
      databasePool,
      migrationV9,
      'migration_0009_project_record_author_transfer_ambiguous'
    )
    if (!ambiguousProjectRecordAuthorTransferRejected) {
      throw new Error('Schema v9 did not reject same-timestamp ProjectRecord author transfer evidence.')
    }
    await databasePool.query(
      'DELETE FROM sciforge_collaboration.audit_events WHERE audit_event_id=$1',
      ['audit_pg_legacy_transfer_ambiguous_0001']
    )

    await databasePool.query(
      `INSERT INTO sciforge_collaboration.audit_events
         (audit_event_id,actor_kind,actor_user_id,action,resource_kind,resource_id,outcome,created_at)
       VALUES ($1,'user',$2,'agent.owner.transfer','agent',$3,'accepted',$4)`,
      [
        'audit_pg_legacy_transfer_equal_0001',
        'usr_pg_legacy_user_0001',
        'agt_pg_legacy_agent_0001',
        LEGACY_RECORD_AT.toISOString()
      ]
    )
    const equalTimestampProjectRecordAuthorTransferRejected = await migrationFailureMatches(
      databasePool,
      migrationV9,
      'migration_0009_project_record_author_transfer_invalid'
    )
    if (!equalTimestampProjectRecordAuthorTransferRejected) {
      throw new Error('Schema v9 did not reject equal-time ProjectRecord author transfer evidence.')
    }
    await databasePool.query(
      'DELETE FROM sciforge_collaboration.audit_events WHERE audit_event_id=$1',
      ['audit_pg_legacy_transfer_equal_0001']
    )

    await databasePool.query(
      `INSERT INTO sciforge_collaboration.agent_nodes
         (agent_id,installation_id,owner_user_id,display_name,node_type,capabilities,status,
          connection_status,credential_generation,revision,updated_at,revoked_at)
       VALUES ($1,$2,$3,$4,'desktop','[]'::jsonb,'revoked','offline',1,1,$5,$5)`,
      [
        'agt_pg_legacy_other_0001',
        'ins_pg_legacy_other_0001',
        'usr_pg_legacy_other_0001',
        'Other Legacy PostgreSQL Agent',
        NOW.toISOString()
      ]
    )
    await databasePool.query(
      `UPDATE sciforge_collaboration.project_records
       SET author_agent_id=$2
       WHERE source_task_id=$1`,
      ['tsk_pg_legacy_completed_0001', 'agt_pg_legacy_other_0001']
    )
    const unsafeProjectRecordAuthorSourceRejected = await migrationFailureMatches(
      databasePool,
      migrationV9,
      'migration_0009_project_record_author_source_invalid'
    )
    if (!unsafeProjectRecordAuthorSourceRejected) {
      throw new Error('Schema v9 did not reject an unsafe ProjectRecord source/author Agent mismatch.')
    }
    await databasePool.query(
      `UPDATE sciforge_collaboration.project_records
       SET author_agent_id=$2
       WHERE source_task_id=$1`,
      ['tsk_pg_legacy_completed_0001', 'agt_pg_legacy_agent_0001']
    )

    const historicalCapEvidence = await verifyMigrationHardCaps(databasePool, migrationV9)

    await runCollaborationMigrations(databasePool)
    const versionsAtCurrent = await migrationVersions(databasePool)
    const readyAtCurrent = await isCollaborationDatabaseReady(databasePool)
    const legacyAgent = await databasePool.query<{
      status: unknown
      device_id: unknown
      credential_revoked: unknown
    }>(
      `SELECT agent.status, agent.device_id,
              credential.revoked_at IS NOT NULL AS credential_revoked
       FROM sciforge_collaboration.agent_nodes AS agent
       JOIN sciforge_collaboration.credentials AS credential
         ON credential.subject_agent_id=agent.agent_id
       WHERE agent.agent_id=$1`,
      ['agt_pg_legacy_agent_0001']
    )
    const legacy = legacyAgent.rows[0]
    if (!legacy) throw new Error('Migration did not preserve the legacy Agent fixture.')
    const legacyRecordAtCurrent = await databasePool.query<{
      author_user_id: unknown
      author_agent_id: unknown
      assignee_user_id: unknown
    }>(
      `SELECT record.author_user_id,record.author_agent_id,task.assignee_user_id
       FROM sciforge_collaboration.project_records AS record
       JOIN sciforge_collaboration.tasks AS task
         ON task.task_id=record.source_task_id
       WHERE record.source_task_id=$1`,
      ['tsk_pg_legacy_completed_0001']
    )
    const legacyRecordCurrent = legacyRecordAtCurrent.rows[0]
    if (!legacyRecordCurrent) throw new Error('Migration did not preserve the legacy ProjectRecord fixture.')
    const transferredRecordAtCurrent = await databasePool.query<{
      author_user_id: unknown
      owner_user_id: unknown
    }>(
      `SELECT record.author_user_id,agent.owner_user_id
       FROM sciforge_collaboration.project_records AS record
       JOIN sciforge_collaboration.agent_nodes AS agent
         ON agent.agent_id=record.author_agent_id
       WHERE record.project_record_id=$1`,
      ['rec_pg_pretransfer_author_0001']
    )
    const transferredRecordCurrent = transferredRecordAtCurrent.rows[0]
    if (!transferredRecordCurrent) throw new Error('Migration did not preserve the transferred author fixture.')
    const authorColumn = await databasePool.query<{ is_nullable: unknown }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema='sciforge_collaboration'
         AND table_name='project_records'
         AND column_name='author_user_id'`
    )
    migrationEvidence = {
      postgresVersion: String(version.rows[0]?.server_version),
      postgresVersionNumber: String(versionNumber.rows[0]?.server_version_num),
      versionsAtV1,
      versionsAtV5,
      versionsAtCurrent,
      readyAtV1,
      readyAtV5,
      readyAtCurrent,
      unsafeProjectRecordAuthorSourceRejected,
      ambiguousProjectRecordAuthorTransferRejected,
      equalTimestampProjectRecordAuthorTransferRejected,
      ...historicalCapEvidence,
      legacyProjectRecordAuthorUserAtV5: legacyRecordV5.author_user_id,
      legacyProjectRecordAuthorUserAtCurrent: legacyRecordCurrent.author_user_id,
      legacyProjectRecordAuthorAgentAtCurrent: legacyRecordCurrent.author_agent_id,
      legacyTaskAssigneeUserAtCurrent: legacyRecordCurrent.assignee_user_id,
      transferredProjectRecordAuthorUserAtCurrent: transferredRecordCurrent.author_user_id,
      transferredProjectRecordAgentOwnerAtCurrent: transferredRecordCurrent.owner_user_id,
      legacyProjectRecordAuthorUserNullableAtCurrent: authorColumn.rows[0]?.is_nullable,
      legacyAgentStatus: String(legacy.status),
      legacyAgentDeviceId: legacy.device_id,
      legacyCredentialRevoked: legacy.credential_revoked === true
    }

    identities = new IdentityService({ repository, now })
    collaboration = new CollaborationService({ repository, now })
    authentication = new AuthenticationService(repository, now)
    process.stdout.write(
      `[postgres-v9-integration] node=${process.version} postgres=${migrationEvidence.postgresVersion} ` +
      `postgresVersionNumber=${migrationEvidence.postgresVersionNumber} ` +
      `v5Baseline=${versionsAtV5.join(',')} migrations=${versionsAtCurrent.join(',')} ready=${String(readyAtCurrent)}\n`
    )
  }, 120_000)

  afterAll(async () => {
    try {
      if (repository) await repository.close()
      else if (databasePool) await databasePool.end()
    } finally {
      try {
        if (adminPool && databaseCreated && databaseName) {
          await adminPool.query(
            `SELECT pg_terminate_backend(pid)
             FROM pg_catalog.pg_stat_activity
             WHERE datname=$1 AND pid<>pg_backend_pid()`,
            [databaseName]
          )
          await adminPool.query(`DROP DATABASE ${quotedDatabaseIdentifier(databaseName)}`)
          databaseCreated = false
        }
      } finally {
        if (adminPool) await adminPool.end()
      }
    }
  }, 120_000)

  it('migrates an isolated v1 database through the v5 baseline to exact schema v9 readiness', async () => {
    expect(COLLABORATION_SCHEMA_VERSION).toBe(9)
    expect(migrationEvidence).toMatchObject({
      versionsAtV1: [1],
      versionsAtV5: [1, 2, 3, 4, 5],
      versionsAtCurrent: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      readyAtV1: false,
      readyAtV5: false,
      readyAtCurrent: true,
      unsafeProjectRecordAuthorSourceRejected: true,
      ambiguousProjectRecordAuthorTransferRejected: true,
      equalTimestampProjectRecordAuthorTransferRejected: true,
      activeProjectMembershipLimitRejected: true,
      projectRecordLimitRejected: true,
      humanNeededLimitRejected: true,
      legacyProjectRecordAuthorUserAtV5: null,
      legacyProjectRecordAuthorUserAtCurrent: 'usr_pg_legacy_user_0001',
      legacyProjectRecordAuthorAgentAtCurrent: 'agt_pg_legacy_agent_0001',
      legacyTaskAssigneeUserAtCurrent: 'usr_pg_legacy_final_0001',
      transferredProjectRecordAuthorUserAtCurrent: 'usr_pg_legacy_user_0001',
      transferredProjectRecordAgentOwnerAtCurrent: 'usr_pg_legacy_final_0001',
      legacyProjectRecordAuthorUserNullableAtCurrent: 'NO',
      legacyAgentStatus: 'revoked',
      legacyAgentDeviceId: null,
      legacyCredentialRevoked: true
    })
    expect(await isCollaborationDatabaseReady(required(databasePool, 'database pool'))).toBe(true)
  })

  it('preserves User and transferred-Agent historical authors while rejecting a missing User author', async () => {
    const connection = await required(databasePool, 'database pool').connect()
    await connection.query('BEGIN')
    try {
      await expect(connection.query(
        `INSERT INTO sciforge_collaboration.project_records
           (project_record_id,project_id,kind,status,summary,author_user_id,author_agent_id,
            revision,created_at,updated_at)
         VALUES ($1,$2,'observation','candidate',$3,$4,NULL,1,$5,$5)`,
        [
          'rec_pg_user_authored_0001',
          'prj_pg_legacy_project_0001',
          'A valid User-authored record remains Agent-independent.',
          'usr_pg_legacy_user_0001',
          NOW.toISOString()
        ]
      )).resolves.toMatchObject({ rowCount: 1 })

      await connection.query('SAVEPOINT missing_author')
      let missingAuthorError: unknown
      try {
        await connection.query(
          `INSERT INTO sciforge_collaboration.project_records
             (project_record_id,project_id,kind,status,summary,author_user_id,author_agent_id,
              revision,created_at,updated_at)
           VALUES ($1,$2,'observation','candidate',$3,NULL,$4,1,$5,$5)`,
          [
            'rec_pg_missing_author_0001',
            'prj_pg_legacy_project_0001',
            'This missing User author must fail.',
            'agt_pg_legacy_agent_0001',
            NOW.toISOString()
          ]
        )
      } catch (error) {
        missingAuthorError = error
      }
      await connection.query('ROLLBACK TO SAVEPOINT missing_author')
      expect(postgresErrorCode(missingAuthorError)).toBe('23502')

      const historicalAuthor = await connection.query<{
        author_user_id: unknown
        owner_user_id: unknown
      }>(
        `SELECT record.author_user_id,agent.owner_user_id
         FROM sciforge_collaboration.project_records AS record
         JOIN sciforge_collaboration.agent_nodes AS agent
           ON agent.agent_id=record.author_agent_id
         WHERE record.project_record_id=$1`,
        ['rec_pg_pretransfer_author_0001']
      )
      expect(historicalAuthor.rows).toEqual([{
        author_user_id: 'usr_pg_legacy_user_0001',
        owner_user_id: 'usr_pg_legacy_final_0001'
      }])
    } finally {
      await connection.query('ROLLBACK').catch(() => undefined)
      connection.release()
    }
  }, 120_000)

  it('rejects same-name Portal indexes whose PostgreSQL definitions are wrong', async () => {
    const pool = required(databasePool, 'database pool')
    const connection = await pool.connect()
    const transactionPool: SqlPool = {
      query: (text, values) => connection.query(text, values),
      connect: async () => { throw new Error('Readiness must stay on the definition-test transaction.') },
      end: async () => undefined
    }
    const wrongDefinitions = [
      {
        name: 'agent_nodes_active_owner_agent_idx',
        create: `CREATE INDEX agent_nodes_active_owner_agent_idx
                 ON sciforge_collaboration.agent_nodes(agent_id, owner_user_id)
                 WHERE status = 'active'`
      },
      {
        name: 'tasks_project_task_id_idx',
        create: `CREATE INDEX tasks_project_task_id_idx
                 ON sciforge_collaboration.tasks(task_id, project_id)`
      },
      {
        name: 'project_records_project_record_id_idx',
        create: `CREATE INDEX project_records_project_record_id_idx
                 ON sciforge_collaboration.project_records(project_record_id, project_id)`
      },
      {
        name: 'human_requests_project_target_request_id_idx',
        create: `CREATE INDEX human_requests_project_target_request_id_idx
                 ON sciforge_collaboration.human_requests(project_id, human_request_id, target_user_id)`
      },
      {
        name: 'human_answers_project_created_answer_idx',
        create: `CREATE INDEX human_answers_project_created_answer_idx
                 ON sciforge_collaboration.human_answers(project_id, human_answer_id, created_at)`
      },
      {
        name: 'tasks_active_assignee_idx',
        create: `CREATE INDEX tasks_active_assignee_idx
                 ON sciforge_collaboration.tasks(assignee_agent_id)
                 WHERE status IN ('accepted')`
      },
      {
        name: 'oidc_identities_active_user_issuer_idx',
        create: `CREATE INDEX oidc_identities_active_user_issuer_idx
                 ON sciforge_collaboration.oidc_identities(user_id, issuer)
                 WHERE status = 'revoked'`
      },
      {
        name: 'project_members_active_user_project_idx',
        create: `CREATE INDEX project_members_active_user_project_idx
                 ON sciforge_collaboration.project_members(project_id, user_id)
                 WHERE active = true`
      },
      {
        name: 'project_members_active_project_user_idx',
        create: `CREATE INDEX project_members_active_project_user_idx
                 ON sciforge_collaboration.project_members(user_id, project_id)
                 WHERE active = true`
      },
      {
        name: 'project_records_candidate_task_result_project_idx',
        create: `CREATE INDEX project_records_candidate_task_result_project_idx
                 ON sciforge_collaboration.project_records(project_id)
                 WHERE kind = 'task_result' AND status = 'accepted'`
      }
    ] as const

    await connection.query('BEGIN')
    try {
      for (const definition of wrongDefinitions) {
        await connection.query('SAVEPOINT wrong_portal_index')
        await connection.query(`DROP INDEX sciforge_collaboration.${definition.name}`)
        await connection.query(definition.create)
        await expect(isCollaborationDatabaseReady(transactionPool)).resolves.toBe(false)
        await connection.query('ROLLBACK TO SAVEPOINT wrong_portal_index')
      }
      await expect(isCollaborationDatabaseReady(transactionPool)).resolves.toBe(true)

      await connection.query('SAVEPOINT inactive_membership_churn')
      await connection.query(
        `INSERT INTO sciforge_collaboration.user_principals
           (user_id,display_name,status,revision,created_at,updated_at)
         SELECT 'usr_pg_inactive_churn_' || lpad(series::text, 5, '0'),
                'Inactive churn fixture','active',1,$1,$1
         FROM generate_series(1,500) AS series`,
        [NOW.toISOString()]
      )
      await connection.query(
        `INSERT INTO sciforge_collaboration.project_members(project_id,user_id,role,active,created_at)
         SELECT $1,'usr_pg_inactive_churn_' || lpad(series::text, 5, '0'),'member',false,$2
         FROM generate_series(1,500) AS series`,
        ['prj_pg_legacy_project_0001', NOW.toISOString()]
      )
      await connection.query(
        `INSERT INTO sciforge_collaboration.projects
           (project_id,owner_user_id,display_name,goal,status,coordinator_agent_id,
            max_tasks,max_tasks_per_round,max_task_retries,max_coordination_rounds,
            coordination_round,revision,created_at,updated_at)
         SELECT 'prj_pg_inactive_churn_' || lpad(series::text, 5, '0'),$1,
                'Inactive churn fixture','Prove the user-first partial index shape.',
                'active',$2,1,1,0,1,1,1,$3,$3
         FROM generate_series(1,500) AS series`,
        ['usr_pg_legacy_user_0001', 'agt_pg_legacy_agent_0001', NOW.toISOString()]
      )
      await connection.query(
        `INSERT INTO sciforge_collaboration.project_members(project_id,user_id,role,active,created_at)
         SELECT 'prj_pg_inactive_churn_' || lpad(series::text, 5, '0'),$1,'member',false,$2
         FROM generate_series(1,500) AS series`,
        ['usr_pg_legacy_user_0001', NOW.toISOString()]
      )
      await connection.query(
        `INSERT INTO sciforge_collaboration.devices
           (device_id,user_id,installation_id,display_name,platform,public_key_jwk,
            capability_summary,status,revision,created_at,updated_at,revoked_at)
         SELECT 'dev_pg_agent_churn_' || lpad(series::text, 5, '0'),
                'usr_pg_inactive_churn_' || lpad(series::text, 5, '0'),
                'ins_pg_device_churn_' || lpad(series::text, 5, '0'),
                'Other-owner Device fixture',
                '{"os":"linux","arch":"x64","appVersion":"test"}'::jsonb,
                '{"kty":"OKP","crv":"Ed25519","alg":"EdDSA","use":"sig","kid":"churn","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'::jsonb,
                '[]'::jsonb,'active',1,$1,$1,NULL
         FROM generate_series(1,500) AS series`,
        [NOW.toISOString()]
      )
      await connection.query(
        `INSERT INTO sciforge_collaboration.agent_nodes
           (agent_id,installation_id,owner_user_id,display_name,node_type,capabilities,status,
            connection_status,credential_generation,revision,last_seen_at,updated_at,revoked_at,device_id)
         SELECT 'agt_pg_agent_churn_' || lpad(series::text, 5, '0'),
                'ins_pg_agent_churn_' || lpad(series::text, 5, '0'),
                'usr_pg_inactive_churn_' || lpad(series::text, 5, '0'),
                'Other-owner Agent fixture','desktop','[]'::jsonb,'active',
                'offline',1,1,NULL,$1,NULL,
                'dev_pg_agent_churn_' || lpad(series::text, 5, '0')
         FROM generate_series(1,500) AS series`,
        [NOW.toISOString()]
      )
      await connection.query(
        `INSERT INTO sciforge_collaboration.human_endpoint_bindings
           (human_endpoint_id,user_id,provider,realm_id,provider_user_id,display_name,assurance,
            status,revision,verified_at,updated_at,revoked_at,external_identity_id,realm_url,created_at)
         VALUES ('hep_pg_answer_churn_0001',$1,'fake-im','answer-churn-realm',
                 'answer-churn-user','Answer churn endpoint','verified','active',1,$2,$2,NULL,NULL,NULL,$2)`,
        ['usr_pg_legacy_user_0001', NOW.toISOString()]
      )
      await connection.query(
        `INSERT INTO sciforge_collaboration.human_requests
           (human_request_id,project_id,task_id,target_user_id,requested_by_agent_id,
            required_assurance,prompt,status,revision,expires_at,created_at,updated_at,
            source_kind,execution_id,source_inbox_message_id,confirmable_action)
         SELECT 'hrq_pg_answer_churn_' || lpad(series::text, 5, '0'),
                'prj_pg_inactive_churn_' || lpad(series::text, 5, '0'),NULL,$1,$2,
                'verified','Answer-index churn fixture','answered',1,
                $3::timestamptz + interval '1 hour',$3,$3,'coordinator',NULL,
                'ibx_pg_answer_churn_' || lpad(series::text, 5, '0'),NULL
         FROM generate_series(1,500) AS series`,
        ['usr_pg_legacy_user_0001', 'agt_pg_legacy_agent_0001', NOW.toISOString()]
      )
      await connection.query(
        `INSERT INTO sciforge_collaboration.human_answers
           (human_answer_id,human_request_id,project_id,task_id,request_revision,
            answered_by_user_id,answered_from_human_endpoint_id,assurance,answer,revision,
            answered_at,created_at,updated_at,execution_id,decision,confirmation_id)
         SELECT 'han_pg_answer_churn_' || lpad(series::text, 5, '0'),
                'hrq_pg_answer_churn_' || lpad(series::text, 5, '0'),
                'prj_pg_inactive_churn_' || lpad(series::text, 5, '0'),NULL,1,$1,
                'hep_pg_answer_churn_0001','verified','Bounded answer fixture',1,$2,$2,$2,
                NULL,NULL,NULL
         FROM generate_series(1,500) AS series`,
        ['usr_pg_legacy_user_0001', NOW.toISOString()]
      )
      await connection.query('SET LOCAL enable_seqscan=off')
      const byProjectPlan = await connection.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON,COSTS OFF)
         SELECT user_id FROM sciforge_collaboration.project_members
         WHERE project_id=$1 AND active=true ORDER BY user_id LIMIT 1001`,
        ['prj_pg_legacy_project_0001']
      )
      const byUserPlan = await connection.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON,COSTS OFF)
         SELECT project_id FROM sciforge_collaboration.project_members
         WHERE user_id=$1 AND active=true ORDER BY project_id LIMIT 1001`,
        ['usr_pg_legacy_user_0001']
      )
      const ownedAgentPlan = await connection.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON,COSTS OFF)
         SELECT agent.*
         FROM sciforge_collaboration.agent_nodes AS agent
         INNER JOIN sciforge_collaboration.user_principals AS owner
           ON owner.user_id=agent.owner_user_id AND owner.status='active'
         INNER JOIN sciforge_collaboration.devices AS device
           ON device.device_id=agent.device_id
          AND device.user_id=agent.owner_user_id
          AND device.status='active'
         WHERE agent.owner_user_id=$1 AND agent.status='active'
           AND agent.node_type IN ('desktop','server')
         ORDER BY agent.agent_id
         LIMIT 101`,
        ['usr_pg_inactive_churn_00001']
      )
      const humanAnswerPlan = await connection.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON,COSTS OFF)
         SELECT * FROM sciforge_collaboration.human_answers
         WHERE project_id=$1
         ORDER BY created_at,human_answer_id`,
        ['prj_pg_inactive_churn_00001']
      )
      expect(JSON.stringify(byProjectPlan.rows)).toContain('project_members_active_project_user_idx')
      expect(JSON.stringify(byUserPlan.rows)).toContain('project_members_active_user_project_idx')
      expect(JSON.stringify(ownedAgentPlan.rows)).toContain('agent_nodes_active_owner_agent_idx')
      expect(JSON.stringify(humanAnswerPlan.rows)).toContain('human_answers_project_created_answer_idx')
      await connection.query('ROLLBACK TO SAVEPOINT inactive_membership_churn')
    } finally {
      await connection.query('ROLLBACK').catch(() => undefined)
      connection.release()
    }
  }, 120_000)

  it('serializes concurrent first use of one issuer/subject into one User and one audit fact', async () => {
    const service = required(identities, 'Identity Service')
    const verified = verifiedIdentity('postgres-concurrent-subject', { email: 'concurrent@example.invalid' })
    const actors = await Promise.all(Array.from({ length: 24 }, () => service.resolveOidcUser(verified)))
    expect(new Set(actors.map((actor) => actor.userId))).toHaveLength(1)
    expect(new Set(actors.map((actor) => actor.identityId))).toHaveLength(1)

    const counts = await required(databasePool, 'database pool').query<{
      identity_count: unknown
      user_count: unknown
      audit_count: unknown
    }>(
      `SELECT
         (SELECT count(*) FROM sciforge_collaboration.oidc_identities
          WHERE issuer=$1 AND subject=$2) AS identity_count,
         (SELECT count(DISTINCT user_id) FROM sciforge_collaboration.oidc_identities
          WHERE issuer=$1 AND subject=$2) AS user_count,
         (SELECT count(*) FROM sciforge_collaboration.audit_events
          WHERE action='oidc.user.jit' AND actor_user_id=$3) AS audit_count`,
      [verified.issuer, verified.subject, actors[0]?.userId]
    )
    expect(counts.rows[0]).toMatchObject({ identity_count: '1', user_count: '1', audit_count: '1' })
  }, 60_000)

  it('enforces enrollment single consumption, installation ownership, Device cascade, and Agent linkage', async () => {
    const identityService = required(identities, 'Identity Service')
    const collaborationService = required(collaboration, 'Collaboration Service')
    const authenticationService = required(authentication, 'Authentication Service')
    const postgresRepository = required(repository, 'PostgreSQL repository')
    const owner = await identityService.resolveOidcUser(verifiedIdentity('postgres-device-owner'))
    const other = await identityService.resolveOidcUser(verifiedIdentity('postgres-device-other'))
    const installationId = 'ins_pg_identity_device_0001'
    const enrollment = await identityService.createDeviceEnrollment(owner, {
      installationId,
      idempotencyKey: 'idem_pg_device_enrollment_0001'
    })
    const fixture = createDeviceFixture({
      enrollmentId: enrollment.enrollmentId,
      nonce: enrollment.nonce,
      userId: owner.userId,
      installationId,
      expiresAt: enrollment.expiresAt,
      capabilitySummary: ['local-files']
    })
    const createInput = {
      ...fixture.deviceRequest,
      nonce: enrollment.nonce
    }
    const outcomes = await Promise.allSettled([
      identityService.createDevice(owner, {
        ...createInput,
        idempotencyKey: 'idem_pg_device_create_race_0001'
      }),
      identityService.createDevice(owner, {
        ...createInput,
        idempotencyKey: 'idem_pg_device_create_race_0002'
      })
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    if (!rejected) throw new Error('Expected exactly one Device creation to be rejected.')
    expect(serviceErrorCode(rejected.reason)).toBe('invalid_state_transition')
    const fulfilled = outcomes.find((outcome) => outcome.status === 'fulfilled')
    if (!fulfilled) throw new Error('Expected exactly one Device creation to succeed.')
    const created = fulfilled.value

    const storedEnrollment = await postgresRepository.getDeviceEnrollment(enrollment.enrollmentId)
    expect(storedEnrollment).toMatchObject({ status: 'consumed', revision: 2 })
    expect((await postgresRepository.listDevicesForUser(owner.userId))).toHaveLength(1)

    const conflictingEnrollment = await identityService.createDeviceEnrollment(other, {
      installationId,
      idempotencyKey: 'idem_pg_device_enrollment_other_0001'
    })
    const conflictingFixture = createDeviceFixture({
      enrollmentId: conflictingEnrollment.enrollmentId,
      nonce: conflictingEnrollment.nonce,
      userId: other.userId,
      installationId,
      expiresAt: conflictingEnrollment.expiresAt
    })
    await expectServiceCode(() => identityService.createDevice(other, {
      ...conflictingFixture.deviceRequest,
      nonce: conflictingEnrollment.nonce,
      idempotencyKey: 'idem_pg_device_create_other_0001'
    }), 'ownership_conflict')

    await expectServiceCode(() => collaborationService.registerAgent(other, {
      deviceId: created.device.deviceId,
      displayName: 'Cross-owner Agent',
      nodeType: 'desktop',
      capabilities: ['runtime-exec'],
      idempotencyKey: 'idem_pg_agent_cross_owner_0001'
    }), 'permission_denied')
    const registered = await collaborationService.registerAgent(owner, {
      deviceId: created.device.deviceId,
      displayName: 'PostgreSQL Runtime Agent',
      nodeType: 'desktop',
      capabilities: ['runtime-exec'],
      idempotencyKey: 'idem_pg_agent_register_0001'
    })
    expect(registered.agent.deviceId).toBe(created.device.deviceId)
    expect(registered.deviceCredential).toEqual(expect.any(String))

    const constraintAgentBase = storedAgentFixture(other, NOW.toISOString())
    await expectServiceCode(() => postgresRepository.transaction((tx) => tx.insertAgent({
      ...constraintAgentBase,
      agentId: 'agt_pg_active_without_device_0001'
    })), 'validation_failed')
    await expectServiceCode(() => postgresRepository.transaction((tx) => tx.insertAgent({
      ...constraintAgentBase,
      agentId: 'agt_pg_cross_owner_device_0001',
      deviceId: created.device.deviceId
    })), 'ownership_conflict')
    await expect(postgresRepository.transaction((tx) => tx.insertAgent({
      ...constraintAgentBase,
      agentId: 'agt_pg_revoked_without_device_0001',
      status: 'revoked',
      connectionStatus: 'offline',
      revokedAt: NOW.toISOString()
    }))).resolves.toBeUndefined()

    const credential = registered.deviceCredential
    if (!credential) throw new Error('Expected a one-time Agent credential.')
    await expect(authenticationService.resolveBearer(credential)).resolves.toMatchObject({
      kind: 'agent_device',
      deviceId: created.device.deviceId,
      agentId: registered.agent.agentId
    })
    await identityService.revokeDevice(owner, created.device.deviceId, 'idem_pg_device_revoke_0001')
    await expectServiceCode(() => authenticationService.resolveBearer(credential), 'credential_revoked')
    const credentialState = await required(databasePool, 'database pool').query<{ revoked: unknown }>(
      `SELECT revoked_at IS NOT NULL AS revoked
       FROM sciforge_collaboration.credentials
       WHERE subject_agent_id=$1 AND kind='agent_device'`,
      [registered.agent.agentId]
    )
    expect(credentialState.rows).toEqual([{ revoked: true }])
  }, 60_000)

  it('linearizes Device revocation against new Agent routing', async () => {
    const identityService = required(identities, 'Identity Service')
    const collaborationService = required(collaboration, 'Collaboration Service')
    const authenticationService = required(authentication, 'Authentication Service')
    const pool = required(databasePool, 'database pool')
    const postgresRepository = required(repository, 'PostgreSQL repository')
    const owner = await identityService.resolveOidcUser(verifiedIdentity('postgres-route-owner'))
    const member = await identityService.resolveOidcUser(verifiedIdentity('postgres-route-member'))
    const coordinator = await provisionIntegratedAgent(
      identityService, collaborationService, authenticationService, owner, 'coordinator'
    )
    const revokeFirstWorker = await provisionIntegratedAgent(
      identityService, collaborationService, authenticationService, member, 'revoke-first'
    )
    const routeFirstWorker = await provisionIntegratedAgent(
      identityService, collaborationService, authenticationService, member, 'route-first'
    )
    const project = await collaborationService.createProject(owner, {
      displayName: 'PostgreSQL Device route fence',
      goal: 'Linearize every new worker route with Device revocation.',
      memberUserIds: [owner.userId, member.userId],
      coordinatorAgentId: coordinator.agent.agentId,
      idempotencyKey: 'idem_pg_device_route_project_0001'
    })
    const before = await countProjectTasks(pool, project.projectId)

    // Revocation owns the Device row first. The route must wait, observe the
    // committed revoked state, and leave both Task and Project revision intact.
    const revokeConnection = await pool.connect()
    let revokeCommitted = false
    try {
      await revokeConnection.query('BEGIN')
      await revokeConnection.query(
        `UPDATE sciforge_collaboration.devices
         SET status='revoked',revision=revision+1,updated_at=$2,revoked_at=$2
         WHERE device_id=$1`,
        [revokeFirstWorker.device.deviceId, NOW.toISOString()]
      )
      await revokeConnection.query(
        `UPDATE sciforge_collaboration.credentials
         SET revoked_at=$2
         WHERE kind='agent_device' AND subject_agent_id=$1 AND revoked_at IS NULL`,
        [revokeFirstWorker.agent.agentId, NOW.toISOString()]
      )
      const blockedRoute = collaborationService.createTask(owner, {
        projectId: project.projectId,
        assigneeAgentId: revokeFirstWorker.agent.agentId,
        title: 'Revocation-first route',
        objective: 'This route must fail after the Device revocation commits.',
        completionCriteria: ['No Task row is committed.'],
        dependencyTaskIds: [],
        expectedProjectRevision: project.revision,
        idempotencyKey: 'idem_pg_device_route_revoke_first_task_0001'
      })
      await waitForDeviceRowLockWait(pool)
      await expectStillPending(blockedRoute)
      await revokeConnection.query('COMMIT')
      revokeCommitted = true
      await expectServiceCode(() => blockedRoute, 'permission_denied')
    } finally {
      if (!revokeCommitted) await revokeConnection.query('ROLLBACK').catch(() => undefined)
      revokeConnection.release()
    }
    expect(await countProjectTasks(pool, project.projectId)).toBe(before)
    await expect(postgresRepository.getProject(project.projectId)).resolves.toMatchObject({ revision: project.revision })

    // The route owns the Device row first and is deliberately held at the
    // Project lock. A later real revokeDevice call must wait until that route
    // commits, after which every further route through the Agent fails closed.
    const projectBlocker = await pool.connect()
    let blockerCommitted = false
    let acceptedTask: Awaited<ReturnType<CollaborationService['createTask']>>
    try {
      await projectBlocker.query('BEGIN')
      await projectBlocker.query(
        'SELECT project_id FROM sciforge_collaboration.projects WHERE project_id=$1 FOR UPDATE',
        [project.projectId]
      )
      const routeFirst = collaborationService.createTask(owner, {
        projectId: project.projectId,
        assigneeAgentId: routeFirstWorker.agent.agentId,
        title: 'Route-first assignment',
        objective: 'This route linearizes before the later Device revocation.',
        completionCriteria: ['Exactly one Task row is committed.'],
        dependencyTaskIds: [],
        expectedProjectRevision: project.revision,
        idempotencyKey: 'idem_pg_device_route_route_first_task_0001'
      })
      await waitForProjectRowLockWait(pool)
      const laterRevocation = identityService.revokeDevice(
        member,
        routeFirstWorker.device.deviceId,
        'idem_pg_device_route_route_first_revoke_0001'
      )
      await expectStillPending(laterRevocation)
      await projectBlocker.query('COMMIT')
      blockerCommitted = true
      acceptedTask = await routeFirst
      await expect(laterRevocation).resolves.toMatchObject({ device: { status: 'revoked' } })
    } finally {
      if (!blockerCommitted) await projectBlocker.query('ROLLBACK').catch(() => undefined)
      projectBlocker.release()
    }

    expect(acceptedTask!).toMatchObject({ assigneeAgentId: routeFirstWorker.agent.agentId })
    expect(await countProjectTasks(pool, project.projectId)).toBe(before + 1)
    const latestProject = await postgresRepository.getProject(project.projectId)
    if (!latestProject) throw new Error('Expected the route-fence Project after Task creation.')
    await expectServiceCode(() => collaborationService.createTask(owner, {
      projectId: project.projectId,
      assigneeAgentId: routeFirstWorker.agent.agentId,
      title: 'Post-revocation route',
      objective: 'No route may commit after Device revocation completes.',
      completionCriteria: ['No second Task row is committed.'],
      dependencyTaskIds: [],
      expectedProjectRevision: latestProject.revision,
      idempotencyKey: 'idem_pg_device_route_post_revoke_task_0001'
    }), 'permission_denied')
    expect(await countProjectTasks(pool, project.projectId)).toBe(before + 1)
  }, 60_000)

  it('enforces both ACTIVE Zulip uniqueness dimensions and creates new history on rebind', async () => {
    const identityService = required(identities, 'Identity Service')
    const owner = await identityService.resolveOidcUser(verifiedIdentity('postgres-binding-owner'))
    const contender = await identityService.resolveOidcUser(verifiedIdentity('postgres-binding-contender'))
    const serviceActor = { kind: 'service' as const, clientId: 'postgres-v5-integration' }
    const realmUrl = 'https://zulip-pg.example.invalid'
    const realmId = 'postgres-zulip-realm-0001'
    const zulipUserId = 'postgres-zulip-user-0001'

    const firstBegin = await identityService.beginZulipBinding(owner, {
      realmUrl,
      idempotencyKey: 'idem_pg_binding_begin_owner_0001'
    })
    const first = await identityService.confirmZulipBinding(serviceActor, {
      bindingCode: firstBegin.bindingCode,
      realmUrl,
      realmId,
      zulipUserId,
      providerEventId: 'postgres-provider-event-owner-0001',
      idempotencyKey: 'idem_pg_binding_confirm_owner_0001'
    })

    const contenderBegin = await identityService.beginZulipBinding(contender, {
      realmUrl,
      idempotencyKey: 'idem_pg_binding_begin_contender_0001'
    })
    await expectServiceCode(() => identityService.confirmZulipBinding(serviceActor, {
      bindingCode: contenderBegin.bindingCode,
      realmUrl,
      realmId,
      zulipUserId,
      providerEventId: 'postgres-provider-event-contender-0001',
      idempotencyKey: 'idem_pg_binding_confirm_contender_0001'
    }), 'IDENTITY_ALREADY_BOUND')

    const secondIdentityBegin = await identityService.beginZulipBinding(owner, {
      realmUrl,
      idempotencyKey: 'idem_pg_binding_begin_second_0001'
    })
    await expectServiceCode(() => identityService.confirmZulipBinding(serviceActor, {
      bindingCode: secondIdentityBegin.bindingCode,
      realmUrl,
      realmId,
      zulipUserId: 'postgres-zulip-user-0002',
      providerEventId: 'postgres-provider-event-second-0001',
      idempotencyKey: 'idem_pg_binding_confirm_second_0001'
    }), 'identity_conflict')

    await identityService.revokeExternalIdentity(
      owner,
      first.identity.externalIdentityId,
      'idem_pg_binding_revoke_owner_0001'
    )
    const rebindBegin = await identityService.beginZulipBinding(owner, {
      realmUrl,
      idempotencyKey: 'idem_pg_binding_begin_rebind_0001'
    })
    const rebound = await identityService.confirmZulipBinding(serviceActor, {
      // Revocation invalidates every older pending code, so rebind starts a fresh request.
      bindingCode: rebindBegin.bindingCode,
      realmUrl,
      realmId,
      zulipUserId,
      providerEventId: 'postgres-provider-event-rebind-0001',
      idempotencyKey: 'idem_pg_binding_confirm_rebind_0001'
    })
    expect(rebound.identity.externalIdentityId).not.toBe(first.identity.externalIdentityId)

    const identitiesForOwner = (await identityService.listExternalIdentities(owner)).identities
      .filter((identity) => identity.realmId === realmId)
    expect(identitiesForOwner).toHaveLength(2)
    expect(identitiesForOwner.map((identity) => identity.status).sort()).toEqual(['active', 'revoked'])
    expect(identitiesForOwner.filter((identity) => identity.status === 'active')).toMatchObject([{
      externalIdentityId: rebound.identity.externalIdentityId,
      zulipUserId
    }])
  }, 60_000)

  it('round-trips a maximum-boundary portable artifact through PostgreSQL and E codec validation', async () => {
    const identityService = required(identities, 'Identity Service')
    const collaborationService = required(collaboration, 'Collaboration Service')
    const pool = required(databasePool, 'database pool')
    const owner = await identityService.resolveOidcUser(verifiedIdentity('postgres-portable-owner'))
    const installationId = 'ins_pg_portable_device_0001'
    const enrollment = await identityService.createDeviceEnrollment(owner, {
      installationId,
      idempotencyKey: 'idem_pg_portable_enrollment_0001'
    })
    const fixture = createDeviceFixture({
      enrollmentId: enrollment.enrollmentId,
      nonce: enrollment.nonce,
      userId: owner.userId,
      installationId,
      expiresAt: enrollment.expiresAt,
      capabilitySummary: ['portable-resource-round-trip']
    })
    const device = await identityService.createDevice(owner, {
      ...fixture.deviceRequest,
      nonce: enrollment.nonce,
      idempotencyKey: 'idem_pg_portable_device_0001'
    })
    const registered = await collaborationService.registerAgent(owner, {
      deviceId: device.device.deviceId,
      displayName: 'Portable PostgreSQL Coordinator',
      nodeType: 'desktop',
      capabilities: ['portable-resource-round-trip'],
      idempotencyKey: 'idem_pg_portable_agent_0001'
    })
    const project = await collaborationService.createProject(owner, {
      displayName: 'Portable PostgreSQL round trip',
      goal: 'Persist one portable artifact and revalidate it with E public codec.',
      memberUserIds: [],
      coordinatorAgentId: registered.agent.agentId,
      idempotencyKey: 'idem_pg_portable_project_0001'
    })

    const digest = 'd'.repeat(64)
    const providerInstanceRef = `p${'a'.repeat(255)}`
    const fileId = `f${'b'.repeat(255)}`
    const immutableVersionId = `v${'c'.repeat(255)}`
    const portableReference = toPortableArtifactReference({
      providerInstanceRef,
      fileId,
      immutableVersionId,
      digest: { algorithm: 'sha256', value: digest }
    })
    const created = await collaborationService.createResourceRef(owner, {
      projectId: project.projectId,
      provider: 'opencontent',
      externalId: `x${'e'.repeat(511)}`,
      kind: portableReference.kind,
      name: 'n'.repeat(200),
      portableReference,
      version: '1'.repeat(200),
      idempotencyKey: 'idem_pg_portable_resource_0001'
    })

    const fetched = toResourceRef(await collaborationService.getResourceRef(owner, created.resourceRefId))
    expect(fetched.openUrl).toBeNull()
    expect(fetched.portableReference).toEqual(portableReference)
    expect(parsePortableArtifactReference(fetched.portableReference)).toEqual({
      providerInstanceRef,
      fileId,
      immutableVersionId,
      digest: { algorithm: 'sha256', value: digest }
    })
    expect(fetched.externalId).toHaveLength(512)
    expect(fetched.name).toHaveLength(200)
    expect(fetched.version).toHaveLength(200)

    const persisted = await pool.query<{ open_url: unknown; portable_reference: string }>(
      `SELECT open_url, portable_reference
       FROM sciforge_collaboration.resource_refs
       WHERE resource_ref_id=$1`,
      [created.resourceRefId]
    )
    expect(persisted.rows).toHaveLength(1)
    expect(persisted.rows[0]).toMatchObject({
      open_url: null,
      portable_reference: serializePortableResourceReferenceCarrier(portableReference)
    })
    expect(parsePortableArtifactReference(JSON.parse(persisted.rows[0]!.portable_reference))).toEqual({
      providerInstanceRef,
      fileId,
      immutableVersionId,
      digest: { algorithm: 'sha256', value: digest }
    })
  }, 60_000)
})

function integrationAdminConnectionString(): string {
  const value = process.env.SCIFORGE_POSTGRES_V5_ADMIN_URL
  if (!value) {
    throw new Error(
      'SCIFORGE_POSTGRES_V5_ADMIN_URL is required when SCIFORGE_POSTGRES_V5_INTEGRATION=1.'
    )
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('SCIFORGE_POSTGRES_V5_ADMIN_URL must be a valid PostgreSQL URL.')
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('SCIFORGE_POSTGRES_V5_ADMIN_URL must use postgres:// or postgresql://.')
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('SCIFORGE_POSTGRES_V5_ADMIN_URL must name an explicit administrative database.')
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  if (!loopback && process.env.SCIFORGE_POSTGRES_V5_ALLOW_REMOTE !== '1') {
    throw new Error(
      'Remote PostgreSQL integration is disabled; use loopback or explicitly set SCIFORGE_POSTGRES_V5_ALLOW_REMOTE=1.'
    )
  }
  return value
}

function temporaryDatabaseName(): string {
  return `sciforge_identity_v6_it_${process.pid}_${randomBytes(6).toString('hex')}`
}

function quotedDatabaseIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new Error('Unsafe temporary database identifier.')
  return `"${value}"`
}

async function migrationVersions(pool: SqlPool): Promise<number[]> {
  const result = await pool.query<{ version: unknown }>(
    'SELECT version FROM sciforge_collaboration.schema_migrations ORDER BY version'
  )
  return result.rows.map((row) => Number(row.version))
}

async function applyMigrationFiles(pool: SqlPool, filenames: readonly string[]): Promise<void> {
  for (const filename of filenames) {
    const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8')
    await pool.query(sql)
  }
}

async function migrationFailureMatches(
  pool: SqlPool,
  migrationSql: string,
  expectedMessage: string
): Promise<boolean> {
  const connection = await pool.connect()
  try {
    try {
      await connection.query(migrationSql)
      return false
    } catch (error) {
      const matches = error instanceof Error && error.message.includes(expectedMessage)
      await connection.query('ROLLBACK')
      return matches
    }
  } finally {
    connection.release()
  }
}

async function verifyMigrationHardCaps(
  pool: SqlPool,
  migrationSql: string
): Promise<{
  activeProjectMembershipLimitRejected: boolean
  projectRecordLimitRejected: boolean
  humanNeededLimitRejected: boolean
}> {
  const at = NOW.toISOString()
  await pool.query(
    `INSERT INTO sciforge_collaboration.projects
       (project_id,owner_user_id,display_name,goal,status,coordinator_agent_id,
        max_tasks,max_tasks_per_round,max_task_retries,max_coordination_rounds,
        coordination_round,revision,created_at,updated_at)
     SELECT 'prj_pg_membership_cap_' || lpad(series::text, 6, '0'),
            $1,'Membership cap fixture','Prove schema v9 refuses an over-limit User.',
            'active',$2,1,1,0,1,1,1,$3,$3
     FROM generate_series(1,1001) AS series`,
    ['usr_pg_legacy_user_0001', 'agt_pg_legacy_agent_0001', at]
  )
  await pool.query(
    `INSERT INTO sciforge_collaboration.project_members(project_id,user_id,role,active,created_at)
     SELECT 'prj_pg_membership_cap_' || lpad(series::text, 6, '0'),$1,'member',true,$2
     FROM generate_series(1,1001) AS series`,
    ['usr_pg_legacy_user_0001', at]
  )
  const activeProjectMembershipLimitRejected = await migrationFailureMatches(
    pool,
    migrationSql,
    'migration_0009_active_project_membership_limit_exceeded'
  )
  await pool.query(
    `DELETE FROM sciforge_collaboration.projects
     WHERE project_id LIKE 'prj_pg_membership_cap_%'`
  )

  await pool.query(
    `INSERT INTO sciforge_collaboration.project_records
       (project_record_id,project_id,kind,status,summary,author_user_id,
        criterion_evidence,resource_ref_ids,revision,created_at,updated_at)
     SELECT 'rec_pg_record_cap_' || lpad(series::text, 6, '0'),$1,
            'observation','candidate','Record cap fixture',$2,'[]'::jsonb,'[]'::jsonb,1,$3,$3
     FROM generate_series(1,50000) AS series`,
    ['prj_pg_legacy_project_0001', 'usr_pg_legacy_user_0001', at]
  )
  const projectRecordLimitRejected = await migrationFailureMatches(
    pool,
    migrationSql,
    'migration_0009_project_record_limit_exceeded'
  )
  await pool.query(
    `DELETE FROM sciforge_collaboration.project_records
     WHERE project_record_id LIKE 'rec_pg_record_cap_%'`
  )

  await pool.query(
    `INSERT INTO sciforge_collaboration.human_requests
       (human_request_id,project_id,task_id,target_user_id,requested_by_agent_id,
        required_assurance,prompt,status,revision,expires_at,created_at,updated_at,
        source_kind,execution_id,source_inbox_message_id,confirmable_action)
     SELECT 'hrq_pg_human_cap_' || lpad(series::text, 6, '0'),$1,NULL,$2,$3,
            'verified','HumanNeeded cap fixture','pending',1,$4::timestamptz + interval '1 hour',
            $4,$4,'coordinator',NULL,'ibx_pg_human_cap_' || lpad(series::text, 6, '0'),NULL
     FROM generate_series(1,10001) AS series`,
    [
      'prj_pg_legacy_project_0001',
      'usr_pg_legacy_user_0001',
      'agt_pg_legacy_agent_0001',
      at
    ]
  )
  const humanNeededLimitRejected = await migrationFailureMatches(
    pool,
    migrationSql,
    'migration_0009_human_needed_limit_exceeded'
  )
  await pool.query(
    `DELETE FROM sciforge_collaboration.human_requests
     WHERE human_request_id LIKE 'hrq_pg_human_cap_%'`
  )

  if (!activeProjectMembershipLimitRejected || !projectRecordLimitRejected || !humanNeededLimitRejected) {
    throw new Error('Schema v9 did not reject every historical Portal hard-cap violation.')
  }
  return {
    activeProjectMembershipLimitRejected,
    projectRecordLimitRejected,
    humanNeededLimitRejected
  }
}

async function seedLegacyV1Agent(pool: SqlPool): Promise<void> {
  await pool.query(
    `INSERT INTO sciforge_collaboration.user_principals
       (user_id,display_name,status,revision,created_at,updated_at)
     VALUES ($1,$2,'active',1,$3,$3)`,
    ['usr_pg_legacy_user_0001', 'Legacy PostgreSQL User', LEGACY_RECORD_AT.toISOString()]
  )
  await pool.query(
    `INSERT INTO sciforge_collaboration.user_principals
       (user_id,display_name,status,revision,created_at,updated_at)
     VALUES ($1,$2,'active',1,$3,$3)`,
    ['usr_pg_legacy_other_0001', 'Other Legacy PostgreSQL User', LEGACY_RECORD_AT.toISOString()]
  )
  await pool.query(
    `INSERT INTO sciforge_collaboration.user_principals
       (user_id,display_name,status,revision,created_at,updated_at)
     VALUES ($1,$2,'active',1,$3,$3)`,
    ['usr_pg_legacy_final_0001', 'Final Legacy PostgreSQL User', LEGACY_RECORD_AT.toISOString()]
  )
  await pool.query(
    `INSERT INTO sciforge_collaboration.agent_nodes
       (agent_id,installation_id,owner_user_id,display_name,node_type,capabilities,status,
        connection_status,credential_generation,revision,updated_at)
     VALUES ($1,$2,$3,$4,'desktop','[]'::jsonb,'active','online',1,1,$5)`,
    [
      'agt_pg_legacy_agent_0001',
      'ins_pg_legacy_install_0001',
      'usr_pg_legacy_user_0001',
      'Legacy PostgreSQL Agent',
      LEGACY_RECORD_AT.toISOString()
    ]
  )
  await pool.query(
    `INSERT INTO sciforge_collaboration.credentials
       (credential_id,kind,subject_user_id,subject_agent_id,token_digest,assurance,generation,created_at)
     VALUES ($1,'agent_device',$2,$3,$4,'device',1,$5)`,
    [
      'credential_pg_legacy_agent_0001',
      'usr_pg_legacy_user_0001',
      'agt_pg_legacy_agent_0001',
      randomBytes(32),
      LEGACY_RECORD_AT.toISOString()
    ]
  )
  await pool.query(
    `INSERT INTO sciforge_collaboration.projects
       (project_id,owner_user_id,display_name,goal,status,coordinator_agent_id,max_tasks,
        max_tasks_per_round,max_task_retries,max_coordination_rounds,coordination_round,revision,
        created_at,updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,10,5,2,4,1,1,$6,$6)`,
    [
      'prj_pg_legacy_project_0001',
      'usr_pg_legacy_user_0001',
      'Legacy completed Task project',
      'Exercise the schema v4 Agent-only result materialization path.',
      'agt_pg_legacy_agent_0001',
      LEGACY_RECORD_AT.toISOString()
    ]
  )
  await pool.query(
    `INSERT INTO sciforge_collaboration.project_members
       (project_id,user_id,role,active,created_at)
     VALUES ($1,$2,'owner',true,$3)`,
    ['prj_pg_legacy_project_0001', 'usr_pg_legacy_user_0001', LEGACY_RECORD_AT.toISOString()]
  )
  await pool.query(
    `INSERT INTO sciforge_collaboration.project_members
       (project_id,user_id,role,active,created_at)
     VALUES
       ($1,$2,'member',true,$4),
       ($1,$3,'member',true,$4)`,
    [
      'prj_pg_legacy_project_0001',
      'usr_pg_legacy_other_0001',
      'usr_pg_legacy_final_0001',
      LEGACY_RECORD_AT.toISOString()
    ]
  )
  await pool.query(
    `INSERT INTO sciforge_collaboration.tasks
       (task_id,project_id,assignee_agent_id,created_by_agent_id,title,objective,completion_criteria,
        dependency_task_ids,status,retry_count,max_retries,coordination_round,result_summary,revision,
        created_at,updated_at,completed_at)
     VALUES ($1,$2,$3,$3,$4,$5,$6::jsonb,'[]'::jsonb,'completed',0,2,1,$7,1,$8,$8,$8)`,
    [
      'tsk_pg_legacy_completed_0001',
      'prj_pg_legacy_project_0001',
      'agt_pg_legacy_agent_0001',
      'Legacy completed Task',
      'Produce one legacy inline result for schema v4 to materialize.',
      JSON.stringify(['The legacy result remains attributable after migration.']),
      'Legacy completed Task result.',
      LEGACY_RECORD_AT.toISOString()
    ]
  )
}

function verifiedIdentity(
  subject: string,
  overrides: Partial<VerifiedOidcIdentity> = {}
): VerifiedOidcIdentity {
  return {
    issuer: 'https://login-pg.example.invalid/realms/SciForge',
    subject,
    audience: ['sciforge-cloud-api'],
    authorizedParty: 'sciforge-desktop',
    issuedAt: nowEpochSeconds,
    notBefore: nowEpochSeconds - 1,
    expiresAt: nowEpochSeconds + 300,
    authTime: nowEpochSeconds,
    preferredUsername: subject,
    ...overrides
  }
}

function storedAgentFixture(owner: UserActor, updatedAt: string): StoredAgent {
  return {
    agentId: 'agt_pg_constraint_agent_0001',
    ownerUserId: owner.userId,
    displayName: 'PostgreSQL Constraint Agent',
    nodeType: 'desktop',
    capabilities: ['runtime-exec'],
    status: 'active',
    connectionStatus: 'offline',
    credentialGeneration: 1,
    revision: 1,
    updatedAt
  }
}

async function provisionIntegratedAgent(
  identities: IdentityService,
  collaboration: CollaborationService,
  authentication: AuthenticationService,
  owner: UserActor,
  label: string
) {
  const installationId = `ins_pg_route_${label.replaceAll('-', '_')}_0001`
  const enrollment = await identities.createDeviceEnrollment(owner, {
    installationId,
    idempotencyKey: `idem_pg_route_${label}_enrollment_0001`
  })
  const fixture = createDeviceFixture({
    enrollmentId: enrollment.enrollmentId,
    nonce: enrollment.nonce,
    userId: owner.userId,
    installationId,
    expiresAt: enrollment.expiresAt,
    capabilitySummary: ['research.execute']
  })
  const created = await identities.createDevice(owner, {
    ...fixture.deviceRequest,
    nonce: enrollment.nonce,
    idempotencyKey: `idem_pg_route_${label}_device_0001`
  })
  const registered = await collaboration.registerAgent(owner, {
    deviceId: created.device.deviceId,
    displayName: `PostgreSQL ${label} Agent`,
    nodeType: 'desktop',
    capabilities: ['research.execute'],
    idempotencyKey: `idem_pg_route_${label}_agent_0001`
  })
  if (!registered.deviceCredential) throw new Error(`Expected the ${label} Agent credential.`)
  const actor = await authentication.resolveBearer(registered.deviceCredential)
  if (actor.kind !== 'agent_device') throw new Error(`Expected the ${label} Agent actor.`)
  const agent = await collaboration.heartbeatAgent(actor, {
    expectedRevision: registered.agent.revision,
    connectionStatus: 'online',
    idempotencyKey: `idem_pg_route_${label}_heartbeat_0001`
  })
  await collaboration.reportAgentCapabilityProfile(actor, {
    agentId: agent.agentId,
    ownerUserId: owner.userId,
    nodeType: 'personal_computer',
    os: { family: 'linux', architecture: 'x64' },
    runtimeIds: ['runtime.postgres-integration'],
    capabilities: [{
      capabilityId: 'research.execute',
      evidence: { level: 'verified', checkedAt: NOW.toISOString() }
    }],
    vpnAccessIds: [],
    slurmClusterIds: [],
    accessibleResourceRefIds: [],
    resultReturnPolicy: {
      summary: true,
      evidenceRefs: true,
      resourceRefs: true,
      logSummary: true,
      fullFileRequiresConfirmation: true,
      fullLogRequiresConfirmation: true
    },
    reportedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60 * 60 * 1_000).toISOString(),
    idempotencyKey: `idem_pg_route_${label}_capability_0001`
  })
  return { device: created.device, agent, actor }
}

async function countProjectTasks(pool: SqlPool, projectId: string): Promise<number> {
  const result = await pool.query<{ count: unknown }>(
    'SELECT count(*) FROM sciforge_collaboration.tasks WHERE project_id=$1',
    [projectId]
  )
  return Number(result.rows[0]?.count ?? 0)
}

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  const state = await Promise.race([
    promise.then(() => 'fulfilled' as const, () => 'rejected' as const),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100))
  ])
  expect(state).toBe('pending')
}

async function waitForProjectRowLockWait(pool: SqlPool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ waiting: unknown }>(
      `SELECT count(*) AS waiting
       FROM pg_catalog.pg_stat_activity
       WHERE datname=current_database()
         AND pid<>pg_backend_pid()
         AND wait_event_type='Lock'
         AND query LIKE '%sciforge_collaboration.projects WHERE project_id = $1 FOR UPDATE%'`
    )
    if (Number(result.rows[0]?.waiting ?? 0) > 0) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for the routed transaction to block on the Project row lock.')
}

async function waitForDeviceRowLockWait(pool: SqlPool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ waiting: unknown }>(
      `SELECT count(*) AS waiting
       FROM pg_catalog.pg_stat_activity
       WHERE datname=current_database()
         AND pid<>pg_backend_pid()
         AND wait_event_type='Lock'
         AND query LIKE '%sciforge_collaboration.devices WHERE device_id=$1 FOR UPDATE%'`
    )
    if (Number(result.rows[0]?.waiting ?? 0) > 0) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for the routed transaction to block on the Device row lock.')
}

async function expectServiceCode(work: () => Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown
  try {
    await work()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(CollaborationServiceError)
  expect(serviceErrorCode(thrown)).toBe(code)
}

function serviceErrorCode(error: unknown): string | undefined {
  return error instanceof CollaborationServiceError ? error.code : undefined
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing initialized ${label}.`)
  return value
}
