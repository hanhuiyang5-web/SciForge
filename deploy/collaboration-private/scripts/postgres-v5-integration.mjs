#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes
} from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'

const RUNTIME_INDEX_URL = 'file:///app/node_modules/@sciforge/collaboration-server/dist/index.js'
const PG_INDEX_URL = 'file:///app/node_modules/pg/esm/index.mjs'
const MIGRATION_V1_URL = new URL(
  'file:///app/node_modules/@sciforge/collaboration-server/migrations/0001_collaboration_schema.sql'
)
const V5_BASELINE_MIGRATION_URLS = [
  '0002_resource_refs.sql',
  '0003_task_progress.sql',
  '0004_coordination_contract.sql',
  '0005_unified_identity_device_bindings.sql'
].map((filename) => new URL(
  `file:///app/node_modules/@sciforge/collaboration-server/migrations/${filename}`
))
const MIGRATION_V9_URL = new URL(
  'file:///app/node_modules/@sciforge/collaboration-server/migrations/0009_portal_bounded_reads.sql'
)
const PASSWORD_FILE_ENV = 'SCIFORGE_POSTGRES_V5_ADMIN_PASSWORD_FILE'
const SNAPSHOT_PASSWORD_FILE_ENV = 'SCIFORGE_POSTGRES_V5_SNAPSHOT_PASSWORD_FILE'
const EXPECTED_COMMIT_ENV = 'SCIFORGE_COLLAB_CONTRACT_COMMIT'
const PORTAL_BOUNDED_READ_INDEXES = Object.freeze([
  Object.freeze({
    tableName: 'agent_nodes',
    indexName: 'agent_nodes_active_owner_agent_idx',
    keyColumns: Object.freeze(['owner_user_id', 'agent_id']),
    predicate: "status = 'active'::text"
  }),
  Object.freeze({
    tableName: 'human_answers',
    indexName: 'human_answers_project_created_answer_idx',
    keyColumns: Object.freeze(['project_id', 'created_at', 'human_answer_id']),
    predicate: null
  }),
  Object.freeze({
    tableName: 'human_requests',
    indexName: 'human_requests_project_target_request_id_idx',
    keyColumns: Object.freeze(['project_id', 'target_user_id', 'human_request_id']),
    predicate: null
  }),
  Object.freeze({
    tableName: 'oidc_identities',
    indexName: 'oidc_identities_active_user_issuer_idx',
    keyColumns: Object.freeze(['user_id', 'issuer']),
    predicate: "status = 'active'::text"
  }),
  Object.freeze({
    tableName: 'project_members',
    indexName: 'project_members_active_project_user_idx',
    keyColumns: Object.freeze(['project_id', 'user_id']),
    predicate: 'active'
  }),
  Object.freeze({
    tableName: 'project_members',
    indexName: 'project_members_active_user_project_idx',
    keyColumns: Object.freeze(['user_id', 'project_id']),
    predicate: 'active'
  }),
  Object.freeze({
    tableName: 'project_records',
    indexName: 'project_records_candidate_task_result_project_idx',
    keyColumns: Object.freeze(['project_id']),
    predicate: "(kind = 'task_result'::text) AND (status = 'candidate'::text)"
  }),
  Object.freeze({
    tableName: 'project_records',
    indexName: 'project_records_project_record_id_idx',
    keyColumns: Object.freeze(['project_id', 'project_record_id']),
    predicate: null
  }),
  Object.freeze({
    tableName: 'tasks',
    indexName: 'tasks_active_assignee_idx',
    keyColumns: Object.freeze(['assignee_agent_id']),
    predicate: "status = ANY (ARRAY['accepted'::text, 'in_progress'::text, 'needs_human'::text])"
  }),
  Object.freeze({
    tableName: 'tasks',
    indexName: 'tasks_project_task_id_idx',
    keyColumns: Object.freeze(['project_id', 'task_id']),
    predicate: null
  })
])
const NOW = new Date()
const LEGACY_RECORD_AT = new Date(NOW.getTime() - 3_000)
const FIRST_LEGACY_TRANSFER_AT = new Date(NOW.getTime() - 2_000)
const SECOND_LEGACY_TRANSFER_AT = new Date(NOW.getTime() - 1_000)
const now = () => new Date(NOW)
const nowEpochSeconds = Math.floor(NOW.getTime() / 1_000)

const snapshotMode = process.argv.length === 3 && process.argv[2] === '--production-snapshot'
const supportedInvocation = process.argv.length === 2 || snapshotMode
let stage = snapshotMode ? 'production_snapshot' : 'runtime_import'

const outcome = supportedInvocation
  ? await (snapshotMode ? runProductionSnapshot() : run()).catch((error) => ({
      ok: false,
      failureCode: safeFailureCode(error)
    }))
  : { ok: false, failureCode: 'invalid_arguments' }

if (!outcome.ok) {
  process.stderr.write(`${JSON.stringify({
    event: 'postgres.v10.integration',
    status: 'failed',
    stage,
    failureCode: outcome.failureCode
  })}\n`)
  process.exitCode = 1
} else if (snapshotMode) {
  process.stdout.write(`${JSON.stringify(outcome.snapshot)}\n`)
} else {
  process.stdout.write(`${JSON.stringify({
    event: 'postgres.v10.integration',
    status: 'passed',
    node: process.version,
    postgresVersion: outcome.postgresVersion,
    postgresVersionNumber: outcome.postgresVersionNumber,
    migrations: outcome.migrations,
    portalBoundedReadIndexes: outcome.portalBoundedReadIndexes,
    checks: outcome.checks
  })}\n`)
}

async function runProductionSnapshot() {
  await assertRuntimeRevision()
  const pg = await import(PG_INDEX_URL)
  assert.ok(pg.Client)
  const connectionString = await databaseUrlFromPasswordFile({
    envName: SNAPSHOT_PASSWORD_FILE_ENV,
    expectedPath: '/run/secrets/postgres-v5-snapshot-password',
    username: 'sciforge_collab',
    database: 'sciforge_collaboration'
  })
  const client = new pg.Client({ connectionString, statement_timeout: 120_000 })
  let transactionStarted = false
  try {
    await client.connect()
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionStarted = true
    const versions = await client.query(
      'SELECT version FROM sciforge_collaboration.schema_migrations ORDER BY version'
    )
    const tableRows = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='sciforge_collaboration' AND table_type='BASE TABLE'
       ORDER BY table_name`
    )
    const tables = []
    for (const [index, record] of tableRows.rows.entries()) {
      const table = String(record.table_name)
      assert.match(table, /^[a-z][a-z0-9_]*$/u)
      const digest = createHash('sha256')
      const count = await streamTableDigest({ client, table, digest, cursorIndex: index })
      tables.push({ table, count, digest: digest.digest('hex') })
    }
    await client.query('COMMIT')
    transactionStarted = false
    return {
      ok: true,
      snapshot: {
        schemaVersions: versions.rows.map((row) => String(row.version)),
        tables
      }
    }
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function streamTableDigest({ client, table, digest, cursorIndex }) {
  const cursor = `snapshot_${cursorIndex}`
  assert.match(cursor, /^snapshot_[0-9]+$/u)
  await client.query(
    `DECLARE "${cursor}" NO SCROLL CURSOR FOR
     SELECT to_jsonb(row_value)::text AS value
     FROM sciforge_collaboration."${table}" AS row_value
     ORDER BY to_jsonb(row_value)::text`
  )
  let count = 0
  try {
    while (true) {
      const batch = await client.query(`FETCH FORWARD 512 FROM "${cursor}"`)
      for (const row of batch.rows) {
        const value = String(row.value)
        digest.update(`${Buffer.byteLength(value, 'utf8')}:`, 'utf8')
        digest.update(value, 'utf8')
        digest.update('\n', 'utf8')
        count += 1
      }
      if (batch.rows.length < 512) break
    }
  } finally {
    await client.query(`CLOSE "${cursor}"`).catch(() => undefined)
  }
  return count
}

async function run() {
  let runtime
  let adminPool
  let databasePool
  let repository
  let databaseName
  let databaseCreated = false
  let primaryFailure
  let evidence

  try {
    runtime = await import(RUNTIME_INDEX_URL)
    assertRuntimeExports(runtime)

    stage = 'runtime_revision'
    await assertRuntimeRevision()

    stage = 'admin_secret'
    const adminConnectionString = await databaseUrlFromPasswordFile({
      envName: PASSWORD_FILE_ENV,
      expectedPath: '/run/secrets/postgres-v5-admin-password',
      username: 'sciforge_admin',
      database: 'postgres'
    })
    databaseName = temporaryDatabaseName()
    adminPool = runtime.createPostgresPool({
      connectionString: adminConnectionString,
      maxConnections: 1,
      statementTimeoutMs: 120_000
    })

    stage = 'temporary_database_create'
    await adminPool.query(`CREATE DATABASE ${quotedDatabaseIdentifier(databaseName)}`)
    databaseCreated = true

    const databaseUrl = new URL(adminConnectionString)
    databaseUrl.pathname = `/${databaseName}`
    databasePool = runtime.createPostgresPool({
      connectionString: databaseUrl.toString(),
      maxConnections: 32,
      statementTimeoutMs: 120_000
    })
    databaseUrl.password = ''
    repository = new runtime.PostgresCollaborationRepository(databasePool)

    stage = 'migration_v1_install'
    const version = await databasePool.query('SHOW server_version')
    const versionNumber = await databasePool.query('SHOW server_version_num')
    const migrationV1 = await readFile(MIGRATION_V1_URL, 'utf8')
    await databasePool.query(migrationV1)
    await seedLegacyV1Agent(databasePool)
    const versionsAtV1 = await migrationVersions(databasePool)
    const readyAtV1 = await runtime.isCollaborationDatabaseReady(databasePool)

    stage = 'migration_v1_to_v5_baseline'
    await applyMigrationUrls(databasePool, V5_BASELINE_MIGRATION_URLS)
    const versionsAtV5 = await migrationVersions(databasePool)
    const readyAtV5 = await runtime.isCollaborationDatabaseReady(databasePool)
    await prepareLegacyProjectRecordTransferFixture(databasePool)

    stage = 'migration_v10_hard_cap_rejection'
    await verifyMigrationHardCaps(databasePool)

    stage = 'migration_v5_to_v10'
    await runtime.runCollaborationMigrations(databasePool)
    const versionsAtV10 = await migrationVersions(databasePool)
    const readyAtV10 = await runtime.isCollaborationDatabaseReady(databasePool)
    const portalBoundedReadIndexes = await verifyPortalBoundedReadIndexes(databasePool)
    await verifyProjectContentSpaceTaskIoSchema(databasePool)
    await verifyLegacyProjectRecordAuthorMigration(databasePool)
    const legacyAgent = await databasePool.query(
      `SELECT agent.status, agent.device_id,
              credential.revoked_at IS NOT NULL AS credential_revoked
       FROM sciforge_collaboration.agent_nodes AS agent
       JOIN sciforge_collaboration.credentials AS credential
         ON credential.subject_agent_id=agent.agent_id
      WHERE agent.agent_id=$1`,
      ['agt_pg_legacy_agent_0001']
    )
    const legacy = legacyAgent.rows[0]
    assert.ok(legacy)
    assert.equal(runtime.COLLABORATION_SCHEMA_VERSION, 10)
    assert.deepEqual(versionsAtV1, [1])
    assert.deepEqual(versionsAtV5, [1, 2, 3, 4, 5])
    assert.deepEqual(versionsAtV10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.equal(readyAtV1, false)
    assert.equal(readyAtV5, false)
    assert.equal(readyAtV10, true)
    assert.equal(legacy.status, 'revoked')
    assert.equal(legacy.device_id, null)
    assert.equal(legacy.credential_revoked, true)

    const identities = new runtime.IdentityService({ repository, now })
    const collaboration = new runtime.CollaborationService({ repository, now })
    const authentication = new runtime.AuthenticationService(repository, now)

    stage = 'oidc_concurrency'
    await verifyConcurrentOidcJit({ identities, databasePool })

    stage = 'device_agent_lifecycle'
    await verifyDeviceAndAgentLifecycle({
      identities,
      collaboration,
      authentication,
      repository,
      databasePool,
      runtime
    })

    stage = 'zulip_binding_uniqueness'
    await verifyZulipBindingUniqueness({ identities, runtime })

    evidence = {
      postgresVersion: String(version.rows[0]?.server_version),
      postgresVersionNumber: String(versionNumber.rows[0]?.server_version_num),
      migrations: versionsAtV10,
      portalBoundedReadIndexes,
      checks: [
        'v1_to_v5_to_v10_readiness',
        'portal_bounded_read_indexes',
        'portal_hard_caps',
        'provider_identity_inbox_constraint',
        'portable_resource_reference_constraint',
        'managed_provider_container_schema',
        'project_content_space_task_io_schema',
        'legacy_agent_revocation',
        'legacy_project_record_author_backfill',
        'legacy_project_record_author_transfer_ambiguity',
        'concurrent_oidc_jit',
        'device_agent_lifecycle',
        'zulip_binding_uniqueness'
      ]
    }
  } catch (error) {
    primaryFailure = error
  } finally {
    stage = primaryFailure ? stage : 'temporary_database_cleanup'
    let cleanupFailure
    try {
      if (repository) await repository.close()
      else if (databasePool) await databasePool.end()
    } catch (error) {
      cleanupFailure = error
    }
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
    } catch (error) {
      cleanupFailure ??= error
    }
    try {
      if (adminPool) await adminPool.end()
    } catch (error) {
      cleanupFailure ??= error
    }
    if (cleanupFailure) {
      stage = 'temporary_database_cleanup'
      primaryFailure ??= cleanupFailure
    }
  }

  if (primaryFailure) throw primaryFailure
  assert.ok(evidence)
  return { ok: true, ...evidence }
}

function assertRuntimeExports(runtime) {
  for (const exportName of [
    'AuthenticationService',
    'CollaborationService',
    'CollaborationServiceError',
    'IdentityService',
    'PostgresCollaborationRepository',
    'canonicalEnrollmentBytes',
    'createPostgresPool',
    'isCollaborationDatabaseReady',
    'runCollaborationMigrations'
  ]) {
    assert.ok(runtime[exportName], `missing runtime export: ${exportName}`)
  }
}

async function assertRuntimeRevision() {
  const expectedCommit = process.env[EXPECTED_COMMIT_ENV]
  assert.match(expectedCommit ?? '', /^[0-9a-f]{40}$/u)
  const installedCommit = (await readFile('/app/CONTRACT_COMMIT', 'utf8')).replace(/[\r\n]/gu, '')
  assert.equal(installedCommit, expectedCommit)
}

async function databaseUrlFromPasswordFile({ envName, expectedPath, username, database }) {
  const passwordPath = process.env[envName]
  assert.equal(passwordPath, expectedPath)
  const metadata = await lstat(passwordPath)
  assert.ok(metadata.isFile())
  assert.equal(metadata.isSymbolicLink(), false)
  assert.equal(metadata.uid, 0)
  assert.equal(metadata.gid, 10001)
  assert.equal(metadata.mode & 0o777, 0o440)
  assert.equal(metadata.size, 64)

  const secretBuffer = await readFile(passwordPath)
  try {
    const password = secretBuffer.toString('ascii')
    assert.match(password, /^[0-9A-Fa-f]{64}$/u)
    const url = new URL(`postgresql://postgres:5432/${database}`)
    url.username = username
    url.password = password
    return url.toString()
  } finally {
    secretBuffer.fill(0)
  }
}

async function verifyConcurrentOidcJit({ identities, databasePool }) {
  const verified = verifiedIdentity('postgres-concurrent-subject', {
    email: 'concurrent@example.invalid'
  })
  const actors = await Promise.all(
    Array.from({ length: 24 }, () => identities.resolveOidcUser(verified))
  )
  assert.equal(new Set(actors.map((actor) => actor.userId)).size, 1)
  assert.equal(new Set(actors.map((actor) => actor.identityId)).size, 1)

  const counts = await databasePool.query(
    `SELECT
       (SELECT count(*) FROM sciforge_collaboration.oidc_identities
        WHERE issuer=$1 AND subject=$2) AS identity_count,
       (SELECT count(DISTINCT user_id) FROM sciforge_collaboration.oidc_identities
        WHERE issuer=$1 AND subject=$2) AS user_count,
       (SELECT count(*) FROM sciforge_collaboration.audit_events
        WHERE action='oidc.user.jit' AND actor_user_id=$3) AS audit_count`,
    [verified.issuer, verified.subject, actors[0]?.userId]
  )
  assert.deepEqual(counts.rows[0], {
    identity_count: '1',
    user_count: '1',
    audit_count: '1'
  })
}

async function verifyDeviceAndAgentLifecycle({
  identities,
  collaboration,
  authentication,
  repository,
  databasePool,
  runtime
}) {
  const owner = await identities.resolveOidcUser(verifiedIdentity('postgres-device-owner'))
  const other = await identities.resolveOidcUser(verifiedIdentity('postgres-device-other'))
  const installationId = 'ins_pg_identity_device_0001'
  const enrollment = await identities.createDeviceEnrollment(owner, {
    installationId,
    idempotencyKey: 'idem_pg_device_enrollment_0001'
  })
  const fixture = createDeviceFixture(runtime.canonicalEnrollmentBytes, {
    enrollmentId: enrollment.enrollmentId,
    nonce: enrollment.nonce,
    userId: owner.userId,
    installationId,
    expiresAt: enrollment.expiresAt,
    capabilitySummary: ['local-files']
  })
  const createInput = { ...fixture.deviceRequest, nonce: enrollment.nonce }
  const outcomes = await Promise.allSettled([
    identities.createDevice(owner, {
      ...createInput,
      idempotencyKey: 'idem_pg_device_create_race_0001'
    }),
    identities.createDevice(owner, {
      ...createInput,
      idempotencyKey: 'idem_pg_device_create_race_0002'
    })
  ])
  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(serviceErrorCode(rejected[0].reason, runtime), 'invalid_state_transition')
  const created = fulfilled[0].value

  const storedEnrollment = await repository.getDeviceEnrollment(enrollment.enrollmentId)
  assert.equal(storedEnrollment?.status, 'consumed')
  assert.equal(storedEnrollment?.revision, 2)
  assert.equal((await repository.listDevicesForUser(owner.userId)).length, 1)

  const conflictingEnrollment = await identities.createDeviceEnrollment(other, {
    installationId,
    idempotencyKey: 'idem_pg_device_enrollment_other_0001'
  })
  const conflictingFixture = createDeviceFixture(runtime.canonicalEnrollmentBytes, {
    enrollmentId: conflictingEnrollment.enrollmentId,
    nonce: conflictingEnrollment.nonce,
    userId: other.userId,
    installationId,
    expiresAt: conflictingEnrollment.expiresAt
  })
  await expectServiceCode(runtime, () => identities.createDevice(other, {
    ...conflictingFixture.deviceRequest,
    nonce: conflictingEnrollment.nonce,
    idempotencyKey: 'idem_pg_device_create_other_0001'
  }), 'ownership_conflict')

  await expectServiceCode(runtime, () => collaboration.registerAgent(other, {
    deviceId: created.device.deviceId,
    displayName: 'Cross-owner Agent',
    nodeType: 'desktop',
    capabilities: ['runtime-exec'],
    idempotencyKey: 'idem_pg_agent_cross_owner_0001'
  }), 'permission_denied')
  const registered = await collaboration.registerAgent(owner, {
    deviceId: created.device.deviceId,
    displayName: 'PostgreSQL Runtime Agent',
    nodeType: 'desktop',
    capabilities: ['runtime-exec'],
    idempotencyKey: 'idem_pg_agent_register_0001'
  })
  assert.equal(registered.agent.deviceId, created.device.deviceId)
  assert.equal(typeof registered.deviceCredential, 'string')

  const constraintAgentBase = storedAgentFixture(other, NOW.toISOString())
  await expectServiceCode(runtime, () => repository.transaction((tx) => tx.insertAgent({
    ...constraintAgentBase,
    agentId: 'agt_pg_active_without_device_0001'
  })), 'validation_failed')
  await expectServiceCode(runtime, () => repository.transaction((tx) => tx.insertAgent({
    ...constraintAgentBase,
    agentId: 'agt_pg_cross_owner_device_0001',
    deviceId: created.device.deviceId
  })), 'ownership_conflict')
  await repository.transaction((tx) => tx.insertAgent({
    ...constraintAgentBase,
    agentId: 'agt_pg_revoked_without_device_0001',
    status: 'revoked',
    connectionStatus: 'offline',
    revokedAt: NOW.toISOString()
  }))

  const credential = registered.deviceCredential
  assert.equal(typeof credential, 'string')
  const actor = await authentication.resolveBearer(credential)
  assert.equal(actor.kind, 'agent_device')
  assert.equal(actor.deviceId, created.device.deviceId)
  assert.equal(actor.agentId, registered.agent.agentId)
  await identities.revokeDevice(owner, created.device.deviceId, 'idem_pg_device_revoke_0001')
  await expectServiceCode(runtime, () => authentication.resolveBearer(credential), 'credential_revoked')
  const credentialState = await databasePool.query(
    `SELECT revoked_at IS NOT NULL AS revoked
     FROM sciforge_collaboration.credentials
     WHERE subject_agent_id=$1 AND kind='agent_device'`,
    [registered.agent.agentId]
  )
  assert.deepEqual(credentialState.rows, [{ revoked: true }])
}

async function verifyZulipBindingUniqueness({ identities, runtime }) {
  const owner = await identities.resolveOidcUser(verifiedIdentity('postgres-binding-owner'))
  const contender = await identities.resolveOidcUser(verifiedIdentity('postgres-binding-contender'))
  const serviceActor = { kind: 'service', clientId: 'postgres-v5-integration' }
  const realmUrl = 'https://zulip-pg.example.invalid'
  const realmId = 'postgres-zulip-realm-0001'
  const zulipUserId = 'postgres-zulip-user-0001'

  const firstBegin = await identities.beginZulipBinding(owner, {
    realmUrl,
    idempotencyKey: 'idem_pg_binding_begin_owner_0001'
  })
  const first = await identities.confirmZulipBinding(serviceActor, {
    bindingCode: firstBegin.bindingCode,
    realmUrl,
    realmId,
    zulipUserId,
    providerEventId: 'postgres-provider-event-owner-0001',
    idempotencyKey: 'idem_pg_binding_confirm_owner_0001'
  })

  const contenderBegin = await identities.beginZulipBinding(contender, {
    realmUrl,
    idempotencyKey: 'idem_pg_binding_begin_contender_0001'
  })
  await expectServiceCode(runtime, () => identities.confirmZulipBinding(serviceActor, {
    bindingCode: contenderBegin.bindingCode,
    realmUrl,
    realmId,
    zulipUserId,
    providerEventId: 'postgres-provider-event-contender-0001',
    idempotencyKey: 'idem_pg_binding_confirm_contender_0001'
  }), 'IDENTITY_ALREADY_BOUND')

  const secondIdentityBegin = await identities.beginZulipBinding(owner, {
    realmUrl,
    idempotencyKey: 'idem_pg_binding_begin_second_0001'
  })
  await expectServiceCode(runtime, () => identities.confirmZulipBinding(serviceActor, {
    bindingCode: secondIdentityBegin.bindingCode,
    realmUrl,
    realmId,
    zulipUserId: 'postgres-zulip-user-0002',
    providerEventId: 'postgres-provider-event-second-0001',
    idempotencyKey: 'idem_pg_binding_confirm_second_0001'
  }), 'identity_conflict')

  await identities.revokeExternalIdentity(
    owner,
    first.identity.externalIdentityId,
    'idem_pg_binding_revoke_owner_0001'
  )
  const rebindBegin = await identities.beginZulipBinding(owner, {
    realmUrl,
    idempotencyKey: 'idem_pg_binding_begin_rebind_0001'
  })
  const rebound = await identities.confirmZulipBinding(serviceActor, {
    bindingCode: rebindBegin.bindingCode,
    realmUrl,
    realmId,
    zulipUserId,
    providerEventId: 'postgres-provider-event-rebind-0001',
    idempotencyKey: 'idem_pg_binding_confirm_rebind_0001'
  })
  assert.notEqual(rebound.identity.externalIdentityId, first.identity.externalIdentityId)

  const identitiesForOwner = (await identities.listExternalIdentities(owner)).identities
    .filter((identity) => identity.realmId === realmId)
  assert.equal(identitiesForOwner.length, 2)
  assert.deepEqual(
    identitiesForOwner.map((identity) => identity.status).sort(),
    ['active', 'revoked']
  )
  const active = identitiesForOwner.filter((identity) => identity.status === 'active')
  assert.equal(active.length, 1)
  assert.equal(active[0].externalIdentityId, rebound.identity.externalIdentityId)
  assert.equal(active[0].zulipUserId, zulipUserId)
}

function createDeviceFixture(canonicalEnrollmentBytes, overrides) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicJwk = publicKey.export({ format: 'jwk' })
  assert.equal(publicJwk.kty, 'OKP')
  assert.equal(publicJwk.crv, 'Ed25519')
  assert.equal(typeof publicJwk.x, 'string')
  const enrollment = {
    enrollmentId: overrides.enrollmentId,
    nonce: overrides.nonce,
    userId: overrides.userId,
    installationId: overrides.installationId,
    expiresAt: overrides.expiresAt
  }
  const signature = signBytes(
    null,
    canonicalEnrollmentBytes(enrollment),
    privateKey
  ).toString('base64url')
  return {
    deviceRequest: {
      enrollmentId: enrollment.enrollmentId,
      installationId: enrollment.installationId,
      displayName: 'PostgreSQL Identity Test Desktop',
      platform: {
        os: 'linux',
        arch: 'x64',
        osVersion: 'bookworm',
        appVersion: '0.1.0'
      },
      publicKeyJwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: publicJwk.x,
        alg: 'EdDSA',
        use: 'sig',
        kid: 'postgres-v5-integration-device-key'
      },
      capabilitySummary: overrides.capabilitySummary ?? ['agent-runtime'],
      signature
    }
  }
}

function temporaryDatabaseName() {
  return `sciforge_identity_v10_it_${process.pid}_${randomBytes(6).toString('hex')}`
}

async function verifyPortalBoundedReadIndexes(pool) {
  const expectedNames = PORTAL_BOUNDED_READ_INDEXES.map(({ indexName }) => indexName)
  const result = await pool.query(
    `SELECT table_relation.relname AS table_name,
            index_relation.relname AS index_name,
            access_method.amname AS access_method,
            index_metadata.indisunique AS is_unique,
            ARRAY(
              SELECT pg_catalog.pg_get_indexdef(index_relation.oid, key_position, true)
              FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
              ORDER BY key_position
            ) AS key_columns,
            pg_catalog.pg_get_expr(
              index_metadata.indpred,
              index_metadata.indrelid,
              true
            ) AS predicate
       FROM pg_catalog.pg_index AS index_metadata
       JOIN pg_catalog.pg_class AS index_relation
         ON index_relation.oid=index_metadata.indexrelid
       JOIN pg_catalog.pg_class AS table_relation
         ON table_relation.oid=index_metadata.indrelid
       JOIN pg_catalog.pg_namespace AS schema_namespace
         ON schema_namespace.oid=table_relation.relnamespace
       JOIN pg_catalog.pg_am AS access_method
         ON access_method.oid=index_relation.relam
      WHERE schema_namespace.nspname='sciforge_collaboration'
        AND index_relation.relname=ANY($1::text[])
      ORDER BY index_relation.relname`,
    [expectedNames]
  )

  assert.equal(result.rows.length, PORTAL_BOUNDED_READ_INDEXES.length)
  for (const [index, expected] of PORTAL_BOUNDED_READ_INDEXES.entries()) {
    const actual = result.rows[index]
    assert.ok(actual)
    assert.equal(actual.table_name, expected.tableName)
    assert.equal(actual.index_name, expected.indexName)
    assert.equal(actual.access_method, 'btree')
    assert.equal(actual.is_unique, false)
    assert.deepEqual(actual.key_columns, expected.keyColumns)
    assert.equal(actual.predicate, expected.predicate)
  }
  return expectedNames
}

async function verifyProjectContentSpaceTaskIoSchema(pool) {
  const columns = await pool.query(
    `SELECT table_name,column_name,data_type,is_nullable
       FROM information_schema.columns
      WHERE table_schema='sciforge_collaboration'
        AND (table_name='project_content_space_bindings'
          OR (table_name='tasks' AND column_name='file_intent'))
      ORDER BY table_name,column_name`
  )
  assert.deepEqual(columns.rows, [
    { table_name: 'project_content_space_bindings', column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    { table_name: 'project_content_space_bindings', column_name: 'project_id', data_type: 'text', is_nullable: 'NO' },
    { table_name: 'project_content_space_bindings', column_name: 'revision', data_type: 'bigint', is_nullable: 'NO' },
    { table_name: 'project_content_space_bindings', column_name: 'root_reference_digest', data_type: 'bytea', is_nullable: 'NO' },
    { table_name: 'project_content_space_bindings', column_name: 'root_resource_ref_id', data_type: 'text', is_nullable: 'NO' },
    { table_name: 'project_content_space_bindings', column_name: 'status', data_type: 'text', is_nullable: 'NO' },
    { table_name: 'project_content_space_bindings', column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    { table_name: 'tasks', column_name: 'file_intent', data_type: 'jsonb', is_nullable: 'YES' }
  ])
  const requiredConstraints = [
    'project_content_space_bindings_project_fk',
    'project_content_space_bindings_revision_valid',
    'project_content_space_bindings_root_digest_valid',
    'project_content_space_bindings_root_fk',
    'project_content_space_bindings_status_valid',
    'resource_refs_project_resource_unique',
    'tasks_file_intent_shape'
  ]
  const constraints = await pool.query(
    `SELECT constraint_name
       FROM information_schema.table_constraints
      WHERE constraint_schema='sciforge_collaboration'
        AND constraint_name=ANY($1::text[])
      ORDER BY constraint_name`,
    [requiredConstraints]
  )
  assert.deepEqual(constraints.rows.map((row) => row.constraint_name), requiredConstraints)
  const index = await pool.query(
    `SELECT index_metadata.indisunique AS is_unique,
            pg_catalog.pg_get_indexdef(index_relation.oid,1,true) AS key_column,
            pg_catalog.pg_get_expr(index_metadata.indpred,index_metadata.indrelid,true) AS predicate
       FROM pg_catalog.pg_index AS index_metadata
       JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid=index_metadata.indexrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=index_relation.relnamespace
      WHERE namespace.nspname='sciforge_collaboration'
        AND index_relation.relname='project_content_space_bindings_active_root_unique'`
  )
  assert.deepEqual(index.rows, [{
    is_unique: true,
    key_column: 'root_reference_digest',
    predicate: "status = 'active'::text"
  }])
}

async function applyMigrationUrls(pool, migrationUrls) {
  for (const migrationUrl of migrationUrls) {
    await pool.query(await readFile(migrationUrl, 'utf8'))
  }
}

async function migrationFailureMatches(pool, migrationSql, expectedMessage) {
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

async function verifyMigrationHardCaps(pool) {
  const migrationSql = await readFile(MIGRATION_V9_URL, 'utf8')
  const at = NOW.toISOString()
  await pool.query(
    `INSERT INTO sciforge_collaboration.projects
       (project_id,owner_user_id,display_name,goal,status,coordinator_agent_id,
        max_tasks,max_tasks_per_round,max_task_retries,max_coordination_rounds,
        coordination_round,revision,created_at,updated_at)
     SELECT 'prj_pg_membership_cap_' || lpad(series::text, 6, '0'),$1,
            'Membership cap fixture','Prove schema v9 refuses an over-limit User.',
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
  assert.equal(await migrationFailureMatches(
    pool, migrationSql, 'migration_0009_active_project_membership_limit_exceeded'
  ), true)
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
  assert.equal(await migrationFailureMatches(
    pool, migrationSql, 'migration_0009_project_record_limit_exceeded'
  ), true)
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
    ['prj_pg_legacy_project_0001', 'usr_pg_legacy_user_0001', 'agt_pg_legacy_agent_0001', at]
  )
  assert.equal(await migrationFailureMatches(
    pool, migrationSql, 'migration_0009_human_needed_limit_exceeded'
  ), true)
  await pool.query(
    `DELETE FROM sciforge_collaboration.human_requests
     WHERE human_request_id LIKE 'hrq_pg_human_cap_%'`
  )
}

function quotedDatabaseIdentifier(value) {
  assert.match(value, /^[a-z][a-z0-9_]{0,62}$/u)
  return `"${value}"`
}

async function migrationVersions(pool) {
  const result = await pool.query(
    'SELECT version FROM sciforge_collaboration.schema_migrations ORDER BY version'
  )
  return result.rows.map((row) => Number(row.version))
}

async function seedLegacyV1Agent(pool) {
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

async function prepareLegacyProjectRecordTransferFixture(pool) {
  const generated = await pool.query(
    `SELECT author_user_id,author_agent_id
     FROM sciforge_collaboration.project_records
     WHERE source_task_id=$1`,
    ['tsk_pg_legacy_completed_0001']
  )
  assert.deepEqual(generated.rows, [{
    author_user_id: null,
    author_agent_id: 'agt_pg_legacy_agent_0001'
  }])
  await pool.query(
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
  await pool.query(
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
  await pool.query(
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
  const cascadedTask = await pool.query(
    `SELECT assignee_user_id
     FROM sciforge_collaboration.tasks
     WHERE task_id=$1`,
    ['tsk_pg_legacy_completed_0001']
  )
  assert.deepEqual(cascadedTask.rows, [{ assignee_user_id: 'usr_pg_legacy_final_0001' }])

  await pool.query(
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
  assert.equal(await migrationFailureMatches(
    pool,
    await readFile(MIGRATION_V9_URL, 'utf8'),
    'migration_0009_project_record_author_transfer_ambiguous'
  ), true)
  await pool.query(
    'DELETE FROM sciforge_collaboration.audit_events WHERE audit_event_id=$1',
    ['audit_pg_legacy_transfer_ambiguous_0001']
  )
}

async function verifyLegacyProjectRecordAuthorMigration(pool) {
  const records = await pool.query(
    `SELECT record.project_record_id,record.author_user_id,record.author_agent_id,
            agent.owner_user_id,task.assignee_user_id
     FROM sciforge_collaboration.project_records AS record
     LEFT JOIN sciforge_collaboration.agent_nodes AS agent
       ON agent.agent_id=record.author_agent_id
     LEFT JOIN sciforge_collaboration.tasks AS task
       ON task.task_id=record.source_task_id
     WHERE record.source_task_id=$1 OR record.project_record_id=$2
     ORDER BY record.project_record_id`,
    ['tsk_pg_legacy_completed_0001', 'rec_pg_pretransfer_author_0001']
  )
  assert.equal(records.rows.length, 2)
  const generated = records.rows.find((record) => record.project_record_id !== 'rec_pg_pretransfer_author_0001')
  const transferred = records.rows.find((record) => record.project_record_id === 'rec_pg_pretransfer_author_0001')
  assert.deepEqual(generated && {
    author_user_id: generated.author_user_id,
    author_agent_id: generated.author_agent_id
  }, {
    author_user_id: 'usr_pg_legacy_user_0001',
    author_agent_id: 'agt_pg_legacy_agent_0001'
  })
  assert.deepEqual(transferred && {
    author_user_id: transferred.author_user_id,
    author_agent_id: transferred.author_agent_id
  }, {
    author_user_id: 'usr_pg_legacy_user_0001',
    author_agent_id: 'agt_pg_legacy_agent_0001'
  })
  assert.equal(generated?.assignee_user_id, 'usr_pg_legacy_final_0001')
  assert.equal(generated?.owner_user_id, 'usr_pg_legacy_final_0001')
  assert.equal(transferred?.owner_user_id, 'usr_pg_legacy_final_0001')
  const column = await pool.query(
    `SELECT is_nullable
     FROM information_schema.columns
     WHERE table_schema='sciforge_collaboration'
       AND table_name='project_records'
       AND column_name='author_user_id'`
  )
  assert.deepEqual(column.rows, [{ is_nullable: 'NO' }])
}

function verifiedIdentity(subject, overrides = {}) {
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

function storedAgentFixture(owner, updatedAt) {
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

async function expectServiceCode(runtime, work, code) {
  let thrown
  try {
    await work()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof runtime.CollaborationServiceError)
  assert.equal(thrown.code, code)
}

function serviceErrorCode(error, runtime) {
  return error instanceof runtime.CollaborationServiceError ? error.code : undefined
}

function safeFailureCode(error) {
  if (error && typeof error === 'object') {
    const candidate = Reflect.get(error, 'code')
    if (typeof candidate === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(candidate)) {
      return candidate
    }
    if (Reflect.get(error, 'name') === 'AssertionError') return 'assertion_failed'
  }
  return 'integration_failed'
}
