#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

expected_commit="${1:-}"
env_input="${2:-$PRIVATE_DEPLOY_DIR/.env}"
[[ -n "$expected_commit" ]] || die "Usage: verify.sh <approved-40-character-contract-commit> [env-file]"

for command in docker curl grep readlink stat sha256sum tar awk sort; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable."
validate_release_bundle "$expected_commit"
prepare_compose_environment "$expected_commit" "$env_input"
if [[ "$RELEASE_MANIFEST_MODE" == a-https-oidc-test ]]; then
  [[ "$SCIFORGE_COLLABORATION_ALLOWED_ORIGINS" == "$A_HTTPS_OIDC_TEST_ORIGIN" \
      && "$SCIFORGE_COLLABORATION_OIDC_ISSUER" == "$A_HTTPS_OIDC_TEST_ISSUER" \
      && "$SCIFORGE_COLLABORATION_OIDC_AUDIENCE" == "$A_HTTPS_OIDC_TEST_AUDIENCE" \
      && "$SCIFORGE_COLLABORATION_OIDC_AUTHORIZED_PARTIES" == "$A_HTTPS_OIDC_TEST_AUTHORIZED_PARTIES" \
      && "$SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK" == false \
      && "$SCIFORGE_COLLAB_DEPLOYMENT_MODE" == oidc-test-private ]] \
    || die "The OIDC test app does not use its immutable identity profile."
elif [[ "$RELEASE_MANIFEST_MODE" == a-https-test-edge ]]; then
  [[ "$SCIFORGE_COLLABORATION_ALLOWED_ORIGINS" == "$A_HTTPS_TEST_EDGE_ORIGIN" \
      && -z "$SCIFORGE_COLLABORATION_OIDC_ISSUER" \
      && "$SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK" == false ]] \
    || die "The core-only HTTPS edge app identity boundary is invalid."
elif [[ -n "$SCIFORGE_COLLABORATION_ALLOWED_ORIGINS" \
    || -n "$SCIFORGE_COLLABORATION_OIDC_ISSUER" ]]; then
  die "A non-HTTPS release must not enable a browser origin or OIDC issuer."
fi
"${COMPOSE[@]}" config --quiet

running_services="$("${COMPOSE[@]}" ps --status running --services)"
grep -qx postgres <<< "$running_services" || die "PostgreSQL container is not running."
grep -qx app <<< "$running_services" || die "Application container is not running."

published_endpoint="$("${COMPOSE[@]}" port app 8787)"
[[ "$published_endpoint" == "127.0.0.1:$SCIFORGE_COLLAB_HOST_PORT" ]] \
  || die "Application port is not restricted to the expected loopback endpoint."
postgres_endpoint="$("${COMPOSE[@]}" port postgres 5432 2>/dev/null || true)"
[[ -z "$postgres_endpoint" ]] || die "PostgreSQL must not publish a host port."

base_url="http://127.0.0.1:$SCIFORGE_COLLAB_HOST_PORT"
curl --fail --silent --show-error --max-time 5 "$base_url/healthz" > /dev/null
curl --fail --silent --show-error --max-time 5 "$base_url/readyz" > /dev/null
console_headers="$(curl --fail --silent --show-error --max-time 5 --dump-header - --output /dev/null "$base_url/console/")"
grep -qi '^content-type: text/html; charset=utf-8' <<< "$console_headers" \
  || die "A console did not return the expected HTML content type."
grep -qi "^content-security-policy: .*frame-ancestors 'none'" <<< "$console_headers" \
  || die "A console is missing its fail-closed frame policy."
console_body="$(curl --fail --silent --show-error --max-time 5 "$base_url/console/")"
grep -q 'SciForge · 协同控制塔' <<< "$console_body" || die "A console shell is missing from the fixed release."

schema_version="$("${COMPOSE[@]}" exec -T --user postgres postgres \
  psql -U sciforge_collab -d sciforge_collaboration --tuples-only --no-align \
  --command='SELECT max(version) FROM sciforge_collaboration.schema_migrations;')"
expected_schema_version="$(expected_collaboration_schema_version)"
[[ "$schema_version" == "$expected_schema_version" ]] \
  || die "Live database schema version does not match the validated release migrations."
[[ "$expected_schema_version" == 9 ]] \
  || die "This fixed release verifier requires collaboration schema v9 exactly."

project_record_author_nullable="$("${COMPOSE[@]}" exec -T --user postgres postgres \
  psql -U sciforge_collab -d sciforge_collaboration --tuples-only --no-align \
  --command="SELECT is_nullable FROM information_schema.columns
             WHERE table_schema='sciforge_collaboration'
               AND table_name='project_records'
               AND column_name='author_user_id';")"
[[ "$project_record_author_nullable" == NO ]] \
  || die "Live database schema v9 does not require a ProjectRecord User author."

portal_hard_cap_violation_count="$("${COMPOSE[@]}" exec -T --user postgres postgres \
  psql -U sciforge_collab -d sciforge_collaboration --tuples-only --no-align \
  --command="
    SELECT
      (SELECT count(*) FROM (
         SELECT user_id FROM sciforge_collaboration.project_members
         WHERE active=true GROUP BY user_id HAVING count(*)>1000
       ) AS over_membership)
      +
      (SELECT count(*) FROM (
         SELECT project_id FROM sciforge_collaboration.project_records
         GROUP BY project_id HAVING count(*)>50000
       ) AS over_records)
      +
      (SELECT count(*) FROM (
         SELECT project_id FROM sciforge_collaboration.human_requests
         GROUP BY project_id HAVING count(*)>10000
       ) AS over_human_needed);")"
[[ "$portal_hard_cap_violation_count" == 0 ]] \
  || die "Live database schema v9 violates a fixed Portal collection cap."

portal_bounded_read_index_receipt="$("${COMPOSE[@]}" exec -T --user postgres postgres \
  psql -U sciforge_collab -d sciforge_collaboration --tuples-only --no-align \
  --command="
    WITH expected(table_name,index_name,key_columns,predicate) AS (
      VALUES
        ('agent_nodes','agent_nodes_active_owner_agent_idx',
          ARRAY['owner_user_id','agent_id']::text[],\$\$status = 'active'::text\$\$::text),
        ('human_answers','human_answers_project_created_answer_idx',
          ARRAY['project_id','created_at','human_answer_id']::text[],NULL::text),
        ('human_requests','human_requests_project_target_request_id_idx',
          ARRAY['project_id','target_user_id','human_request_id']::text[],NULL::text),
        ('oidc_identities','oidc_identities_active_user_issuer_idx',
          ARRAY['user_id','issuer']::text[],\$\$status = 'active'::text\$\$::text),
        ('project_members','project_members_active_project_user_idx',
          ARRAY['project_id','user_id']::text[],\$\$active\$\$::text),
        ('project_members','project_members_active_user_project_idx',
          ARRAY['user_id','project_id']::text[],\$\$active\$\$::text),
        ('project_records','project_records_candidate_task_result_project_idx',
          ARRAY['project_id']::text[],
          \$\$(kind = 'task_result'::text) AND (status = 'candidate'::text)\$\$::text),
        ('project_records','project_records_project_record_id_idx',
          ARRAY['project_id','project_record_id']::text[],NULL::text),
        ('tasks','tasks_active_assignee_idx',ARRAY['assignee_agent_id']::text[],
          \$\$status = ANY (ARRAY['accepted'::text, 'in_progress'::text, 'needs_human'::text])\$\$::text),
        ('tasks','tasks_project_task_id_idx',ARRAY['project_id','task_id']::text[],NULL::text)
    ), actual AS (
      SELECT table_relation.relname AS table_name,
             index_relation.relname AS index_name,
             access_method.amname AS access_method,
             index_metadata.indisunique AS is_unique,
             ARRAY(
               SELECT pg_catalog.pg_get_indexdef(index_relation.oid,key_position,true)
               FROM generate_series(1,index_metadata.indnkeyatts) AS key_position
               ORDER BY key_position
             ) AS key_columns,
             pg_catalog.pg_get_expr(index_metadata.indpred,index_metadata.indrelid,true) AS predicate
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
    )
    SELECT expected.index_name
      FROM expected
      JOIN actual USING (table_name,index_name,key_columns)
     WHERE actual.access_method='btree'
       AND actual.is_unique=false
       AND actual.predicate IS NOT DISTINCT FROM expected.predicate
     ORDER BY expected.index_name;")"
expected_portal_bounded_read_index_receipt=$'agent_nodes_active_owner_agent_idx\nhuman_answers_project_created_answer_idx\nhuman_requests_project_target_request_id_idx\noidc_identities_active_user_issuer_idx\nproject_members_active_project_user_idx\nproject_members_active_user_project_idx\nproject_records_candidate_task_result_project_idx\nproject_records_project_record_id_idx\ntasks_active_assignee_idx\ntasks_project_task_id_idx'
[[ "$portal_bounded_read_index_receipt" == "$expected_portal_bounded_read_index_receipt" ]] \
  || die "Live database schema v9 is missing an exact Portal bounded-read index."

expected_tables="$(expected_collaboration_tables)"
expected_table_count="$(printf '%s\n' "$expected_tables" | awk 'END { print NR }')"
actual_tables="$("${COMPOSE[@]}" exec -T --user postgres postgres \
  psql -U sciforge_collab -d sciforge_collaboration --tuples-only --no-align \
  --command="SELECT table_name FROM information_schema.tables WHERE table_schema = 'sciforge_collaboration' AND table_type = 'BASE TABLE' ORDER BY table_name;")"
[[ "$actual_tables" == "$expected_tables" ]] \
  || die "Live database table set does not match the validated release migrations."

validate_database_role_layout

image_id="$(docker image inspect --format '{{.Id}}' "sciforge-collaboration-runtime:$expected_commit")"
image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
[[ "$image_revision" == "$expected_commit" ]] || die "Runtime image revision label mismatch."
app_container_id="$("${COMPOSE[@]}" ps -q app)"
running_image_id="$(docker container inspect --format '{{.Image}}' "$app_container_id")"
[[ "$running_image_id" == "$image_id" ]] || die "Running application container does not use the approved runtime image."
container_revision="$("${COMPOSE[@]}" exec -T app sh -c 'tr -d "\r\n" < /app/CONTRACT_COMMIT')"
[[ "$container_revision" == "$expected_commit" ]] || die "Running container revision proof mismatch."
if [[ "$RELEASE_MANIFEST_MODE" == a-https-oidc-test ]]; then
  "${COMPOSE[@]}" exec -T app node /app/verify-portal-assets.mjs \
    /app/RELEASE_MANIFEST.json "$A_CLOUD_PORTAL_ASSET_DIR" >/dev/null \
    || die "Running container Portal assets do not match the fixed release manifest."
fi
app_mode="$(docker container inspect --format \
  '{{index .Config.Labels "cn.sciforge.deployment.mode"}}' "$app_container_id")"
if [[ "$RELEASE_MANIFEST_MODE" == a-https-oidc-test ]]; then
  [[ "$app_mode" == oidc-test-private ]] || die "The running app is not in explicit OIDC test mode."
else
  [[ "$app_mode" == core-only-private ]] || die "The running app is not in core-only private mode."
fi
runtime_identity="$("${COMPOSE[@]}" exec -T app node -e \
  'process.stdout.write(`${process.getuid()}:${process.getgid()}`)')"
[[ "$runtime_identity" == 10001:10001 ]] \
  || die "Application runtime must use the fixed non-login UID/GID 10001."

# This deployment is intentionally core-only. Fail if provider configuration
# was accidentally injected into the production process.
"${COMPOSE[@]}" exec -T app node -e \
  "if (process.env.SCIFORGE_COLLABORATION_PROVIDER_CONFIG_FILE || process.env.SCIFORGE_COLLABORATION_SECRET_DIRECTORY || process.env.SCIFORGE_COLLAB_DB_ADMIN_PASSWORD || process.env.POSTGRES_PASSWORD) process.exit(1)"

# Real API boundary smoke. Every A-only deployment must advertise no Human
# providers, reject unverified JWTs, and keep trusted binding confirmation
# disabled. The OIDC test edge proves live Discovery/JWKS separately.
"${COMPOSE[@]}" exec -T app node --input-type=module - <<'NODE'
import { randomUUID } from 'node:crypto'

const fail = (message) => {
  console.error(`Core-only API smoke failed: ${message}`)
  process.exit(1)
}
const suffix = randomUUID().replaceAll('-', '').slice(0, 24)
const pgModule = await import('pg')
const Client = pgModule.Client ?? pgModule.default?.Client
if (!Client || !process.env.SCIFORGE_COLLABORATION_DATABASE_URL) {
  fail('database client is unavailable for core-only boundary verification')
}
const database = new Client({ connectionString: process.env.SCIFORGE_COLLABORATION_DATABASE_URL })
const identityFactCounts = async () => {
  const result = await database.query(
    `SELECT
       (SELECT count(*)::integer FROM sciforge_collaboration.user_principals) AS users,
       (SELECT count(*)::integer FROM sciforge_collaboration.device_enrollments) AS enrollments,
       (SELECT count(*)::integer FROM sciforge_collaboration.zulip_binding_requests) AS bindings`
  )
  return result.rows[0]
}
let beforeIdentityFacts
let afterIdentityFacts
try {
  await database.connect()
  beforeIdentityFacts = await identityFactCounts()
} catch {
  await database.end().catch(() => undefined)
  fail('identity persistence boundary could not be inspected')
}

const catalogResponse = await fetch('http://127.0.0.1:8787/v1/commands', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    protocolVersion: '1.0',
    requestId: `req_${suffix}`,
    type: 'endpoint.catalog.get'
  })
})
const catalog = await catalogResponse.json().catch(() => null)
if (catalogResponse.status !== 200 || catalog?.type !== 'endpoint.catalog' ||
    !Array.isArray(catalog.providers) || catalog.providers.length !== 0) {
  fail('core-only provider catalog is not empty')
}

const idempotencyKey = `idem_private_smoke_${suffix}`
const pairingResponse = await fetch('http://127.0.0.1:8787/v1/commands', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
  body: JSON.stringify({
    protocolVersion: '1.0',
    requestId: `req_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    type: 'pairing.begin',
    idempotencyKey,
    realmUrl: 'https://identity-smoke.example.invalid'
  })
})
const pairingFailure = await pairingResponse.json().catch(() => null)
if (pairingResponse.status !== 401 || pairingFailure?.error?.code !== 'authentication_required') {
  fail('pairing.begin accepted an anonymous caller')
}
if (pairingFailure?.bindingCode || pairingFailure?.userCredential) {
  fail('anonymous pairing response exposed identity material')
}

const authorizationHeader = ['author', 'ization'].join('')
const invalidOidcBearer = [
  'Bearer',
  ['eyJhbGciOiJSUzI1NiIsImtpZCI6IngifQ', 'eyJzdWIiOiJ4In0', 'signature'].join('.')
].join(' ')
const meResponse = await fetch('http://127.0.0.1:8787/v1/me', {
  headers: { [authorizationHeader]: invalidOidcBearer }
})
if (meResponse.status !== 401) fail('unverifiable JWT-shaped bearer did not fail closed')
await meResponse.arrayBuffer()

const confirmKey = `idem_private_confirm_${suffix}`
const confirmResponse = await fetch('http://127.0.0.1:8787/v1/integrations/zulip/bindings/confirm', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': confirmKey },
  body: JSON.stringify({
    bindingCode: 'SF-ABCDEFGH-JKLMNPQR',
    realmUrl: 'https://identity-smoke.example.invalid',
    realmId: 'private-ecs-smoke',
    zulipUserId: 'private-ecs-user',
    providerEventId: `private-ecs-event-${suffix}`,
    idempotencyKey: confirmKey
  })
})
if (confirmResponse.status !== 401) fail('unconfigured trusted binding confirmation did not fail closed')
await confirmResponse.arrayBuffer()

try {
  afterIdentityFacts = await identityFactCounts()
  await database.end()
} catch {
  await database.end().catch(() => undefined)
  fail('identity persistence boundary could not be rechecked')
}
if (JSON.stringify(afterIdentityFacts) !== JSON.stringify(beforeIdentityFacts)) {
  fail('unauthenticated identity requests persisted facts')
}

const unauthenticatedResponse = await fetch('http://127.0.0.1:8787/v1/commands', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    protocolVersion: '1.0',
    requestId: `req_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    type: 'user.get',
    userId: 'usr_PrivateSmoke0001'
  })
})
if (unauthenticatedResponse.status !== 401) fail('unauthenticated user.get was not rejected')
await unauthenticatedResponse.arrayBuffer()
console.log('A-only API smoke passed: invalid OIDC and trusted binding confirmation failed closed; no identity facts persisted.')
NODE

websocket_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 --http1.1 \
  --header 'Connection: Upgrade' \
  --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' \
  --header 'Sec-WebSocket-Key: c2NpZm9yZV9wcml2YXRl' \
  "$base_url/v1/events" || true)"
[[ "$websocket_status" == "401" ]] || die "Unauthenticated WebSocket Upgrade was not rejected with HTTP 401."

echo "Verification passed: loopback-only app, least-privilege database role, release schema v${expected_schema_version}/${expected_table_count} tables, required ProjectRecord User authors, fixed Portal hard caps, ten exact Portal/coordination bounded-read indexes, fixed image revision/UID/GID, A console, probes and fail-closed auth boundaries."
