#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$file" \
    || die "Static deployment policy is missing from $(basename "$file"): $expected"
}

assert_not_contains() {
  local file="$1"
  local forbidden="$2"
  if grep -Fq -- "$forbidden" "$file"; then
    die "Static deployment policy contains forbidden text in $(basename "$file"): $forbidden"
  fi
}

for script in "$SCRIPT_DIR"/*.sh; do
  bash -n "$script"
done
node --check "$SCRIPT_DIR/postgres-v5-integration.mjs"
node --check "$SCRIPT_DIR/verify-portal-assets.mjs"
[[ -x "$SCRIPT_DIR/verify-portal-assets.mjs" ]] \
  || die "The fixed Portal asset verifier is not executable."
for edge_script in deploy-a-https-test-edge.sh disable-a-https-test-edge.sh \
    verify-a-https-test-edge.sh verify-a-https-test-edge-external.sh \
    deploy-a-https-oidc-test.sh disable-a-https-oidc-test.sh \
    verify-a-https-oidc-test.sh verify-a-https-oidc-test-external.sh; do
  [[ -x "$SCRIPT_DIR/$edge_script" ]] \
    || die "Fixed HTTPS edge script is not executable: $edge_script"
done

assert_contains "$SCRIPT_DIR/install-tunnel-user.sh" 'AllowStreamLocalForwarding no'
assert_contains "$SCRIPT_DIR/install-tunnel-user.sh" 'allowstreamlocalforwarding no'
assert_contains "$SCRIPT_DIR/install-tunnel-user.sh" 'PermitOpen 127.0.0.1:8787'

assert_contains "$SCRIPT_DIR/common.sh" 'validate_provider_secret_group_isolation'
assert_contains "$SCRIPT_DIR/common.sh" 'must not be assigned to a host group'
assert_contains "$SCRIPT_DIR/common.sh" 'Host account $account must not use provider runtime GID'
assert_contains "$SCRIPT_DIR/common.sh" 'id -G "$account"'
assert_contains "$SCRIPT_DIR/common.sh" 'Host account $account must not belong to provider runtime GID'
assert_contains "$SCRIPT_DIR/common.sh" 'PRIVATE_ENV_FILE="$PRIVATE_ENV_DIR/collaboration.env"'
assert_contains "$SCRIPT_DIR/common.sh" 'Production secrets directory must be root:root mode 0700.'
assert_contains "$SCRIPT_DIR/common.sh" 'Production root must not be writable by group or other.'
assert_contains "$SCRIPT_DIR/common.sh" 'Production env must be a root:root regular file with mode 0600.'
assert_contains "$SCRIPT_DIR/common.sh" 'fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_POSTGRES_CPUS 1.5'
assert_contains "$SCRIPT_DIR/common.sh" 'fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_APP_MEMORY 768m'
assert_contains "$SCRIPT_DIR/common.sh" 'fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_EDGE_PIDS 128'
assert_contains "$SCRIPT_DIR/common.sh" 'fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_LOG_MAX_SIZE 10m'
assert_contains "$SCRIPT_DIR/common.sh" 'export SCIFORGE_COLLAB_POSTGRES_CPUS="$postgres_cpus"'
assert_contains "$SCRIPT_DIR/common.sh" 'export SCIFORGE_COLLAB_EDGE_MEMORY="$edge_memory"'
assert_contains "$SCRIPT_DIR/common.sh" 'export SCIFORGE_COLLAB_LOG_MAX_FILES="$log_max_files"'
assert_contains "$DEPLOY_DIR/.env.example" '/srv/sciforge-collaboration/secrets/collaboration.env'
assert_contains "$DEPLOY_DIR/.env.example" 'physical root:root mode 0700 secrets'
assert_contains "$SCRIPT_DIR/common.sh" '(( ${#tarballs[@]} == 5 ))'
assert_contains "$SCRIPT_DIR/common.sh" 'sciforge-domain-sdk-*.tgz'
assert_contains "$SCRIPT_DIR/common.sh" 'sciforge-collaboration-portal-*.tgz'
assert_contains "$SCRIPT_DIR/common.sh" '&& portal_packages == 1 && server_packages == 1'
assert_contains "$SCRIPT_DIR/common.sh" '(( ${#manifest_filenames[@]} == 5 ))'
assert_contains "$SCRIPT_DIR/common.sh" 'line_count == 9 && ${#seen_files[@]} == 9'

assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '[[ "$ready_status" == 503 ]]'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'running_contract_commit'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'running_image_id'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'approved_image_revision'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '--core-only'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '--provider-zulip'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '--a-https-oidc-test'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'prepare_a_https_oidc_test_environment'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '[[ "$provider_mode" == oidc-test-private ]]'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'validate_a_https_oidc_test_app "$expected_commit"'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '[[ "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" == "$app_container_before" ]]'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '[[ "$provider_mode" == core-only-private ]]'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'body.providers.length !== 0'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '{{range .Config.Env}}{{println .}}{{end}}'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'provider_env_key_count'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '{{range .Mounts}}{{println .Destination}}{{end}}'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'NF && ($0 == "/" || $0 == target'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'provider_mount_violation_count'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'index(target, $0 "/") == 1'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '[[ "$provider_mode" == zulip-provider-private ]]'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'body.providers.length !== 1'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" "body.providers[0]?.provider !== 'zulip'"
assert_not_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'process.env.SCIFORGE_COLLABORATION_PROVIDER_CONFIG_FILE'
assert_not_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '[[ -z "$config_mount_rw" && -z "$secret_mount_rw" ]]'

assert_contains "$SCRIPT_DIR/deploy.sh" 'acquire_collaboration_deploy_lock'
assert_contains "$SCRIPT_DIR/deploy.sh" 'trap stop_unverified_app EXIT'
assert_contains "$SCRIPT_DIR/deploy.sh" 'app_launch_attempted=true'
assert_contains "$SCRIPT_DIR/deploy.sh" 'candidate_app_container_id'
assert_contains "$SCRIPT_DIR/deploy.sh" 'current_app_container_id" == "$candidate_app_container_id'
assert_contains "$SCRIPT_DIR/deploy.sh" 'candidate_app_revision" == "$expected_commit'
assert_contains "$SCRIPT_DIR/deploy.sh" 'current_app_revision" == "$expected_commit'
assert_contains "$SCRIPT_DIR/deploy.sh" 'docker stop -t 20 "$candidate_app_container_id"'
assert_contains "$SCRIPT_DIR/deploy.sh" 'the unverified app was stopped'
assert_contains "$SCRIPT_DIR/deploy.sh" 'Refusing to stop it; operator inspection is required.'
assert_contains "$SCRIPT_DIR/deploy.sh" 'PostgreSQL, volumes, container logs, backups, and release evidence were preserved'
assert_contains "$SCRIPT_DIR/deploy.sh" 'deployment_complete=true'
assert_not_contains "$SCRIPT_DIR/deploy.sh" '/run/lock/'

assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'acquire_collaboration_deploy_lock'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '$COLLABORATION_RUNTIME_DIR/postgres-v5-integration.lock'
assert_not_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '/run/lock/'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '--confirm-isolated-database-test'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '"${COMPOSE[@]}" build app'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'approved_image_revision'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'running_image_revision" =~ ^[0-9a-f]{40}$'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'app_state_before" == "$app_state_before_build'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" "'{{.Internal}}'"
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" "awk 'NF { print }'"
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'docker port "$postgres_container_id"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'chmod 0440 "$password_file"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'root:10001 mode 0440'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'dst=/run/secrets/postgres-v5-admin-password,readonly'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'dst=/app/postgres-v5-integration.mjs,readonly'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '"$approved_image_id"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'forbidden_runner_env_count'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '--production-snapshot'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'cn.sciforge.test.purpose=production-read-only-snapshot'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'dst=/run/secrets/postgres-v5-snapshot-password,readonly'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'forbidden_snapshot_env_count'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'production_snapshot_after" == "$production_snapshot_before"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'app_state_after" == "$app_state_before'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'expected_schema_version" == 10'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '^sciforge_identity_v10_it_[0-9]+_[0-9a-f]{12}$'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '"event":"postgres.v10.integration","status":"passed"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'v1_to_v5_to_v10_readiness'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'portal_bounded_read_indexes'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'portal_hard_caps'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'migration_0009_active_project_membership_limit_exceeded'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'migration_0009_project_record_limit_exceeded'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'migration_0009_human_needed_limit_exceeded'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'legacy_project_record_author_backfill'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'legacy_project_record_author_transfer_ambiguity'
assert_contains "$SCRIPT_DIR/verify.sh" 'project_record_author_nullable'
assert_contains "$SCRIPT_DIR/verify.sh" "table_name='project_records'"
assert_contains "$SCRIPT_DIR/verify.sh" "column_name='author_user_id'"
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'tasks_project_task_id_idx'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'project_records_project_record_id_idx'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'human_requests_project_target_request_id_idx'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'tasks_active_assignee_idx'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'oidc_identities_active_user_issuer_idx'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'project_members_active_user_project_idx'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'project_members_active_project_user_idx'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'project_records_candidate_task_result_project_idx'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'agent_nodes_active_owner_agent_idx'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'human_answers_project_created_answer_idx'
for portal_index in \
  agent_nodes_active_owner_agent_idx \
  human_answers_project_created_answer_idx \
  human_requests_project_target_request_id_idx \
  oidc_identities_active_user_issuer_idx \
  project_members_active_project_user_idx \
  project_members_active_user_project_idx \
  project_records_candidate_task_result_project_idx \
  project_records_project_record_id_idx \
  tasks_active_assignee_idx \
  tasks_project_task_id_idx; do
  assert_contains "$SCRIPT_DIR/verify.sh" "$portal_index"
done
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'provider_identity_inbox_constraint'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'portable_resource_reference_constraint'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'managed_provider_container_schema'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'project_content_space_task_io_schema'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'dropdb -U sciforge_admin --if-exists --force "$database"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'grep -Fq -f "$password_file" "$log_file"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '/run/sciforge-collaboration-private-postgres-v5.attestation'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'candidateImageId=%s'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'releaseManifestSha256=%s'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'runnerScriptSha256=%s'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'chmod 0600 "$attestation_temporary"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'mv -f -- "$attestation_temporary" "$attestation_path"'

assert_contains "$SCRIPT_DIR/deploy.sh" 'consume_postgres_v5_attestation "$image_id" "$expected_commit"'
assert_contains "$SCRIPT_DIR/common.sh" 'mv -- "$attestation_path" "$claimed_path"'
assert_contains "$SCRIPT_DIR/common.sh" 'candidateImageId=$candidate_image_id'
assert_contains "$SCRIPT_DIR/common.sh" 'runner_script_digest'
assert_contains "$SCRIPT_DIR/common.sh" 'now_epoch - verified_epoch <= 1800'
assert_contains "$SCRIPT_DIR/common.sh" 'mapfile -t tables < <(expected_collaboration_tables)'
assert_contains "$SCRIPT_DIR/common.sh" 'for table in "${tables[@]}"'

assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" '/app/node_modules/@sciforge/collaboration-server/dist/index.js'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'CREATE DATABASE ${quotedDatabaseIdentifier(databaseName)}'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'DROP DATABASE ${quotedDatabaseIdentifier(databaseName)}'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" '--production-snapshot'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'DECLARE "${cursor}" NO SCROLL CURSOR'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'FETCH FORWARD 512'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" "createHash('sha256')"
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'to_jsonb(row_value)::text'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'secretBuffer.fill(0)'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" "mode & 0o777, 0o440"
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'status: '\''passed'\'''
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'runtime.COLLABORATION_SCHEMA_VERSION, 10'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'versionsAtV5, [1, 2, 3, 4, 5]'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'versionsAtV10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'portalBoundedReadIndexes: outcome.portalBoundedReadIndexes'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'verifyPortalBoundedReadIndexes(databasePool)'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'verifyProjectContentSpaceTaskIoSchema(databasePool)'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" "assert.equal(actual.access_method, 'btree')"
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'assert.deepEqual(actual.key_columns, expected.keyColumns)'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'assert.equal(actual.predicate, expected.predicate)'
assert_not_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'SCIFORGE_POSTGRES_V5_ADMIN_URL'
assert_not_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'vitest'
assert_not_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'tsx'
assert_not_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'test-fixtures'
assert_not_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" '/src/'

assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'acquire_collaboration_deploy_lock'
assert_not_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" '/run/lock/'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'trap stop_unverified_app EXIT'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'app_launch_attempted=true'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'consume_postgres_v5_attestation "$image_id" "$expected_commit"'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'docker stop -t 20 "$candidate_app_container_id"'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'current_app_container_id" == "$candidate_app_container_id"'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'the unverified app was stopped'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'deployment_complete=true'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'RELEASE_MANIFEST_MODE" != a-https-test-edge'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'must not enable a public browser origin'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'assert_no_a_https_test_edge_container'

assert_contains "$SCRIPT_DIR/common.sh" 'a-https-test-edge)'
assert_contains "$SCRIPT_DIR/common.sh" 'public-https-core-only'
assert_contains "$SCRIPT_DIR/common.sh" 'A_HTTPS_TEST_EDGE_HOSTNAME=cloud-test.sciforge.cn'
assert_contains "$SCRIPT_DIR/common.sh" 'A_HTTPS_TEST_EDGE_PUBLIC_IPV4=47.76.230.118'
assert_contains "$SCRIPT_DIR/common.sh" 'A_HTTPS_TEST_EDGE_IMAGE_DIGEST=sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a'
assert_contains "$SCRIPT_DIR/common.sh" 'The A HTTPS test edge must not configure an OIDC issuer.'
assert_contains "$SCRIPT_DIR/common.sh" 'Provider environment is forbidden on this core-only edge.'
assert_contains "$SCRIPT_DIR/common.sh" 'Provider mounts are forbidden on this core-only edge.'
assert_contains "$SCRIPT_DIR/common.sh" 'app must remain published only on 127.0.0.1:8787'
assert_contains "$SCRIPT_DIR/common.sh" 'validate_local_docker_endpoint'
assert_contains "$SCRIPT_DIR/common.sh" 'COLLABORATION_RUNTIME_DIR=/run/sciforge-collaboration-private'
assert_contains "$SCRIPT_DIR/common.sh" 'collaboration runtime directory must be root:root mode 0700'
assert_contains "$SCRIPT_DIR/common.sh" 'collaboration deployment lock path is unsafe'
assert_contains "$SCRIPT_DIR/common.sh" '--project-name sciforge-collaboration-private'
assert_contains "$SCRIPT_DIR/common.sh" '--project-name sciforge-collaboration-a-https-test-edge'
assert_contains "$SCRIPT_DIR/common.sh" 'assert_a_https_test_edge_network_membership'
assert_contains "$SCRIPT_DIR/common.sh" 'assert_a_https_test_edge_backend_port_boundaries'
assert_contains "$SCRIPT_DIR/common.sh" '{{printf "%s|%s|%s\n" $port .HostIp .HostPort}}'
assert_contains "$SCRIPT_DIR/common.sh" 'The collaboration backend port must not listen outside host loopback.'
assert_contains "$SCRIPT_DIR/common.sh" 'Host UID 10002 must remain unassigned before preparing isolated edge state.'
assert_contains "$SCRIPT_DIR/common.sh" 'docker container ls -a --no-trunc -q'
assert_contains "$SCRIPT_DIR/common.sh" 'docker container ls --no-trunc -q'
assert_contains "$SCRIPT_DIR/common.sh" 'edgeDisableScriptSha256'
assert_contains "$SCRIPT_DIR/common.sh" 'edgePostgresV5IntegrationScriptSha256'
assert_contains "$SCRIPT_DIR/common.sh" 'edgePostgresRestartVerifyScriptSha256'
assert_contains "$SCRIPT_DIR/common.sh" 'edgeBackupRestoreVerifyScriptSha256'
assert_contains "$SCRIPT_DIR/deploy.sh" 'assert_no_a_https_test_edge_container'

assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" 'validate_a_https_test_edge_bundle'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" 'acquire_collaboration_deploy_lock'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" 'TCP port 443 is already in use'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" '--network none'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" '--user 10002:10002'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" '--cap-drop ALL'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" '/run/caddy-bin:rw,nosuid,nodev,exec,size=64m'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" 'cp /usr/bin/caddy /run/caddy-bin/caddy'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" 'docker stop -t 20 "$candidate_edge_id"'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" 'Certificate state, app, PostgreSQL, and networks were preserved.'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" 'prepare_a_https_test_edge_state_dirs'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" 'assert_a_https_test_edge_network_membership'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" 'create --no-build edge'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" 'rm seq sha256sum'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" 'docker update --restart=unless-stopped'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" '/approval/approved-'
assert_contains "$SCRIPT_DIR/deploy-a-https-test-edge.sh" 'verify-a-https-test-edge.sh'

assert_contains "$SCRIPT_DIR/disable-a-https-test-edge.sh" 'Usage: disable-a-https-test-edge.sh'
assert_contains "$SCRIPT_DIR/disable-a-https-test-edge.sh" 'validate_fixed_edge_release_ancestors'
assert_contains "$SCRIPT_DIR/disable-a-https-test-edge.sh" 'assert_no_a_https_test_edge_container'
assert_contains "$SCRIPT_DIR/disable-a-https-test-edge.sh" 'Every dedicated edge-project container was stopped'
assert_contains "$SCRIPT_DIR/disable-a-https-test-edge.sh" 'docker rm "$edge_id"'

assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'verify_hostname "$A_HTTPS_TEST_EDGE_HOSTNAME"'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'servername login-test.sciforge.cn'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'The unauthenticated WSS boundary must fail closed with 401.'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'An unapproved browser origin was not rejected.'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'The public HTTPS catalog is not exactly core-only.'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'tcp_80_count" == 0'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'udp_443_count" == 0'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" "--noproxy '*'"
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'assert_a_https_test_edge_network_membership "$edge_container_id"'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'health_status" == 200'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'ready_status" == 200'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'timeout 15 openssl s_client'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" '0:10002:440'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'edge revision header does not match the approved commit'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" 'The A-only console must remain unavailable'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge.sh" "| awk 'NF { print }'"

assert_contains "$SCRIPT_DIR/verify-a-https-test-edge-external.sh" "--noproxy '*'"
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge-external.sh" 'error?.code === "ENODATA"'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge-external.sh" 'manifest-script-sha256'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge-external.sh" 'health_status" == 200'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge-external.sh" 'dns_timeout'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge-external.sh" 'live public edge revision does not match the approved commit'
assert_contains "$SCRIPT_DIR/verify-a-https-test-edge-external.sh" 'no successful authenticated WSS or business E2E claimed'
udp_fixture_count="$(printf '%s\n' 'UNCONN 0 0 0.0.0.0:443 0.0.0.0:*' \
  | awk '$4 ~ /:443$/ { count += 1 } END { print count + 0 }')"
[[ "$udp_fixture_count" == 1 ]] || die "UDP 443 listener fixture is not detected from ss local-address column."
docker_endpoint_fixture="$(printf '%s\n\n' \
  '57c9e32c8b90e75aca48cdf447a69e4f7246f40e04af04b814ecaef6b0b0ce4a' \
  | awk 'NF { count += 1; value=$0 } END { print count ":" value }')"
[[ "$docker_endpoint_fixture" == \
    1:57c9e32c8b90e75aca48cdf447a69e4f7246f40e04af04b814ecaef6b0b0ce4a ]] \
  || die "Docker network endpoint filtering does not ignore the template's trailing blank line."
assert_contains "$SCRIPT_DIR/common.sh" '"$A_HTTPS_TEST_EDGE_NETWORK" | awk '\''NF { print }'\'''

assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'admin off'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'auto_https disable_redirects'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'https_port 8443'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'protocols h1 h2'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'strict_sni_host on'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'read_header 10s'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'X-SciForge-Edge-Revision "{$SCIFORGE_EDGE_COMMIT}"'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'Cache-Control "no-store"'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'dir https://acme-v02.api.letsencrypt.org/directory'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'disable_http_challenge'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'dynamic a app 8787'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'resolvers 127.0.0.11'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'lb_try_duration 5s'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'response_header_timeout 30s'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'respond /console* 404'
assert_not_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'login-test.sciforge.cn'
assert_not_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'debug'
assert_not_contains "$DEPLOY_DIR/Caddyfile.a-https-test-edge" 'log_credentials'

assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'caddy:2.11.4-alpine@sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'user: "10002:10002"'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'published: 443'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'target: 8443'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'create_host_path: false'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" '/tmp:rw,nosuid,nodev,noexec'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'restart: "no"'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" '/run/caddy-bin:rw,nosuid,nodev,exec,size=64m'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'cp /usr/bin/caddy /run/caddy-bin/caddy'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'target: /approval'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'read_only: true'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'no-new-privileges:true'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'cn.sciforge.edge.mode: public-https-core-only'
assert_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'name: sciforge-collaboration-private_private-edge'
assert_not_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'docker.sock'
assert_not_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" 'database'
assert_not_contains "$DEPLOY_DIR/compose.a-https-test-edge.yml" '8080'

assert_contains "$SCRIPT_DIR/common.sh" 'a-https-oidc-test)'
assert_contains "$SCRIPT_DIR/common.sh" 'public-https-oidc-test'
assert_contains "$SCRIPT_DIR/common.sh" 'A_HTTPS_OIDC_TEST_IDENTITY_HOSTNAME=login-test.sciforge.cn'
assert_contains "$SCRIPT_DIR/common.sh" 'A_HTTPS_OIDC_TEST_ISSUER=https://login-test.sciforge.cn/realms/SciForge'
assert_contains "$SCRIPT_DIR/common.sh" 'A_HTTPS_OIDC_TEST_IDENTITY_NETWORK=sciforge-keycloak_identity-edge'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_binding_confirm_mode" == disabled'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_provider_mode" == disabled'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_oidc_allow_insecure_loopback" == false'
assert_contains "$SCRIPT_DIR/common.sh" 'A_HTTPS_OIDC_TEST_AUTHORIZED_PARTIES=sciforge-desktop,sciforge-web-mobile'
assert_contains "$SCRIPT_DIR/common.sh" 'A_CLOUD_PORTAL_ASSET_DIR=/app/node_modules/@sciforge/collaboration-portal/dist'
assert_contains "$SCRIPT_DIR/common.sh" 'A_CLOUD_PORTAL_CLIENT_ID=sciforge-cloud-console'
assert_contains "$SCRIPT_DIR/common.sh" 'A_CLOUD_PORTAL_REDIRECT_URI=https://cloud-test.sciforge.cn/portal/auth/callback'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_schema_version" == 4'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_mode" == confidential-bff'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_base_path" == /portal/'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_auth_path_prefix" == /portal/auth/'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_api_path_prefix" == /portal/api/'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_events_path" == /portal/events'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_vite_manifest_path" == dist/.vite/manifest.json'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_integrity_manifest_path" == dist/ASSET_INTEGRITY.json'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_authorized_party" == "$A_CLOUD_PORTAL_CLIENT_ID"'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_human_needed_mode" == display-only'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_test_worker_directory_enabled" == true'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_session_idle_seconds" == 1800'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_session_absolute_seconds" == 28800'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_content_security_policy" == "$A_CLOUD_PORTAL_CSP"'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_compose_sha256'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_portal_asset_verify_script_sha256'
assert_contains "$SCRIPT_DIR/common.sh" 'portalOidcClientSecret|SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET|client_secret'
assert_contains "$SCRIPT_DIR/common.sh" 'SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET must be a non-placeholder Keycloak secret'
assert_contains "$SCRIPT_DIR/common.sh" 'docker exec "$app_container_id" node /app/verify-portal-assets.mjs'
assert_contains "$SCRIPT_DIR/common.sh" 'The OIDC test app does not contain exactly one bounded Portal client secret.'
assert_contains "$SCRIPT_DIR/common.sh" '$2 == "identityAcceptanceHarnessSha256" { print $4 }'
assert_contains "$SCRIPT_DIR/common.sh" '$2 == "multiWorkerAcceptanceHarnessSha256" { print $4 }'
assert_contains "$SCRIPT_DIR/common.sh" '$2 == "realFileRun0ReceiptHarnessSha256" { print $4 }'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_identity_acceptance_harness_sha256" =~ ^[0-9a-f]{64}$'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_multi_worker_acceptance_harness_sha256" =~ ^[0-9a-f]{64}$'
assert_contains "$SCRIPT_DIR/common.sh" 'manifest_real_file_run0_receipt_harness_sha256" =~ ^[0-9a-f]{64}$'
assert_not_contains "$SCRIPT_DIR/common.sh" 'dualPrincipalAcceptanceHarnessSha256'
assert_not_contains "$SCRIPT_DIR/common.sh" 'collaboration-a-identity-acceptance.mjs'
assert_contains "$SCRIPT_DIR/common.sh" 'assert_a_https_oidc_test_network_membership'
assert_contains "$SCRIPT_DIR/common.sh" 'The dedicated identity-edge network must contain exactly one Keycloak app plus the optional A edge.'
assert_contains "$SCRIPT_DIR/common.sh" 'Keycloak must never join a SciForge Cloud application or database network.'
assert_contains "$SCRIPT_DIR/common.sh" 'The OIDC edge must join exactly the Cloud private-edge and Keycloak identity-edge networks.'
assert_contains "$SCRIPT_DIR/common.sh" 'Provider environment is forbidden in A HTTPS OIDC test mode.'
assert_contains "$SCRIPT_DIR/common.sh" 'SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK|false'
assert_contains "$SCRIPT_DIR/common.sh" '--project-name sciforge-collaboration-a-https-oidc-test'

assert_contains "$SCRIPT_DIR/verify-portal-assets.mjs" "integrityManifest.schemaVersion !== 1 || integrityManifest.basePath !== '/portal/'"
assert_contains "$SCRIPT_DIR/verify-portal-assets.mjs" 'Portal asset inventory is not strictly sorted.'
assert_contains "$SCRIPT_DIR/verify-portal-assets.mjs" 'Installed Portal directory contains an unlisted or missing file.'
assert_contains "$SCRIPT_DIR/verify-portal-assets.mjs" 'schemaVersion: 4'
assert_contains "$SCRIPT_DIR/verify-portal-assets.mjs" "portalMode: 'confidential-bff'"
assert_contains "$SCRIPT_DIR/verify-portal-assets.mjs" "portalAuthorizedParty: 'sciforge-cloud-console'"
assert_contains "$SCRIPT_DIR/verify-portal-assets.mjs" 'portalViteManifestSha256: sha256(viteManifestContent)'
assert_contains "$SCRIPT_DIR/verify-portal-assets.mjs" 'portalIntegrityManifestSha256: sha256(integrityManifestContent)'
assert_contains "$SCRIPT_DIR/verify-portal-assets.mjs" 'portalContentSecurityPolicy:'
assert_contains "$SCRIPT_DIR/verify-portal-assets.mjs" 'SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET'

assert_contains "$DEPLOY_DIR/Dockerfile.runtime" 'COPY bundle/RELEASE_MANIFEST.json ./RELEASE_MANIFEST.json'
assert_contains "$DEPLOY_DIR/Dockerfile.runtime" 'COPY scripts/verify-portal-assets.mjs ./verify-portal-assets.mjs'
assert_contains "$DEPLOY_DIR/Dockerfile.runtime" 'node ./verify-portal-assets.mjs'
assert_contains "$DEPLOY_DIR/.dockerignore" '!bundle/RELEASE_MANIFEST.json'
assert_contains "$DEPLOY_DIR/.dockerignore" '!scripts/verify-portal-assets.mjs'

assert_contains "$DEPLOY_DIR/compose.a-cloud-portal.yml" 'SCIFORGE_COLLABORATION_PORTAL_ENABLED:'
assert_contains "$DEPLOY_DIR/compose.a-cloud-portal.yml" 'SCIFORGE_COLLABORATION_PORTAL_ASSET_DIR:'
assert_contains "$DEPLOY_DIR/compose.a-cloud-portal.yml" 'SCIFORGE_COLLABORATION_PORTAL_PUBLIC_ORIGIN:'
assert_contains "$DEPLOY_DIR/compose.a-cloud-portal.yml" 'SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_ID:'
assert_contains "$DEPLOY_DIR/compose.a-cloud-portal.yml" 'SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET:'
assert_contains "$DEPLOY_DIR/compose.a-cloud-portal.yml" 'SCIFORGE_COLLABORATION_PORTAL_OIDC_REDIRECT_URI:'
assert_contains "$DEPLOY_DIR/compose.a-cloud-portal.yml" 'SCIFORGE_COLLABORATION_PORTAL_TEST_WORKER_DIRECTORY_ENABLED:'
portal_overlay_services="$(awk '/^[[:space:]]{2}[A-Za-z0-9_-]+:$/ { sub(/^[[:space:]]+/, ""); sub(/:$/, ""); print }' \
  "$DEPLOY_DIR/compose.a-cloud-portal.yml")"
[[ "$portal_overlay_services" == app ]] \
  || die "The Portal Compose overlay must target only the app service."

assert_contains "$DEPLOY_DIR/.env.example" 'SCIFORGE_COLLABORATION_OIDC_AUTHORIZED_PARTIES=sciforge-desktop,sciforge-web-mobile'
assert_contains "$DEPLOY_DIR/.env.example" 'SCIFORGE_COLLABORATION_PORTAL_ENABLED=true'
assert_contains "$DEPLOY_DIR/.env.example" 'SCIFORGE_COLLABORATION_PORTAL_ASSET_DIR=/app/node_modules/@sciforge/collaboration-portal/dist'
assert_contains "$DEPLOY_DIR/.env.example" 'SCIFORGE_COLLABORATION_PORTAL_PUBLIC_ORIGIN=https://cloud-test.sciforge.cn'
assert_contains "$DEPLOY_DIR/.env.example" 'SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_ID=sciforge-cloud-console'
assert_contains "$DEPLOY_DIR/.env.example" 'SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET=replace_with_keycloak_generated_confidential_client_secret'
assert_contains "$DEPLOY_DIR/.env.example" 'SCIFORGE_COLLABORATION_PORTAL_OIDC_REDIRECT_URI=https://cloud-test.sciforge.cn/portal/auth/callback'
assert_contains "$DEPLOY_DIR/.env.example" 'SCIFORGE_COLLABORATION_PORTAL_TEST_WORKER_DIRECTORY_ENABLED=true'

assert_contains "$SCRIPT_DIR/deploy.sh" 'RELEASE_MANIFEST_MODE" == a-https-oidc-test'
assert_contains "$SCRIPT_DIR/deploy.sh" 'assert_no_a_https_test_edge_container'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'RELEASE_MANIFEST_MODE" != a-https-oidc-test'
assert_contains "$SCRIPT_DIR/verify-provider-zulip.sh" 'RELEASE_MANIFEST_MODE" != a-https-oidc-test'

assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" 'cloud-test.sciforge.cn:8443'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" 'login-test.sciforge.cn:8443'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" 'strict_sni_host on'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" 'protocols h1 h2'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" 'X-SciForge-Edge-Revision "{$SCIFORGE_EDGE_COMMIT}"'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" 'Cache-Control "no-store"'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" '@console path /console*'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" $'@console path /console*\n\thandle @console {\n\t\theader Cache-Control "no-store"\n\t\trespond 404\n\t}'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" '@portal path /portal /portal/*'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" 'X-SciForge-Portal-Mode "confidential-bff"'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" $'\thandle @portal {\n\t\theader {\n\t\t\tdefer'
[[ "$(grep -Fxc $'\t\t\theader_up X-Forwarded-For {remote_host}' \
  "$DEPLOY_DIR/Caddyfile.a-https-oidc-test")" == 1 ]] \
  || die "The Portal edge must overwrite X-Forwarded-For exactly once with remote_host."
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" "Content-Security-Policy \"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; manifest-src 'none'\""
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" $'@portal path /portal /portal/*\n\thandle @portal {'
portal_route_block="$(awk '
  $0 == "\t@portal path /portal /portal/*" { capture=1 }
  capture && $0 == "\thandle {" { exit }
  capture { print }
' "$DEPLOY_DIR/Caddyfile.a-https-oidc-test")"
[[ -n "$portal_route_block" ]] || die "The fixed Portal Caddy route could not be isolated."
if grep -Fq 'Cache-Control' <<< "$portal_route_block"; then
  die "The edge must preserve the Portal runtime immutable asset cache policy."
fi
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" $'\thandle {\n\t\theader Cache-Control "no-store"\n\t\treverse_proxy {'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" '@forbidden path /admin* /metrics* /health*'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" '@keycloak_public {'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" 'path /realms/SciForge /realms/SciForge/* /resources/*'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" 'path_regexp keycloak_public_case_sensitive ^(?:/realms/SciForge(?:/.*)?|/resources/.*)$'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" $'@keycloak_public {\n\t\tpath /realms/SciForge /realms/SciForge/* /resources/*\n\t\tpath_regexp keycloak_public_case_sensitive ^(?:/realms/SciForge(?:/.*)?|/resources/.*)$\n\t}'
assert_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" 'dynamic a keycloak 8080'
assert_not_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" '/realms/* /resources/*'
assert_not_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" 'debug'
assert_not_contains "$DEPLOY_DIR/Caddyfile.a-https-oidc-test" 'log_credentials'

assert_contains "$DEPLOY_DIR/compose.a-https-oidc-test.yml" 'cn.sciforge.edge.mode: public-https-oidc-test'
assert_contains "$DEPLOY_DIR/compose.a-https-oidc-test.yml" 'cn.sciforge.edge.identity-hostname: login-test.sciforge.cn'
assert_contains "$DEPLOY_DIR/compose.a-https-oidc-test.yml" 'cn.sciforge.edge.oidc-issuer: https://login-test.sciforge.cn/realms/SciForge'
assert_contains "$DEPLOY_DIR/compose.a-https-oidc-test.yml" 'name: sciforge-collaboration-private_private-edge'
assert_contains "$DEPLOY_DIR/compose.a-https-oidc-test.yml" 'name: sciforge-keycloak_identity-edge'
assert_contains "$DEPLOY_DIR/compose.a-https-oidc-test.yml" 'published: 443'
assert_contains "$DEPLOY_DIR/compose.a-https-oidc-test.yml" 'target: 8443'
assert_contains "$DEPLOY_DIR/compose.a-https-oidc-test.yml" 'restart: "no"'
assert_contains "$DEPLOY_DIR/compose.a-https-oidc-test.yml" 'user: "10002:10002"'
assert_contains "$DEPLOY_DIR/compose.a-https-oidc-test.yml" 'no-new-privileges:true'
assert_not_contains "$DEPLOY_DIR/compose.a-https-oidc-test.yml" 'docker.sock'
assert_not_contains "$DEPLOY_DIR/compose.a-https-oidc-test.yml" 'database:'

assert_contains "$SCRIPT_DIR/deploy-a-https-oidc-test.sh" 'validate_a_https_oidc_test_bundle'
assert_contains "$SCRIPT_DIR/deploy-a-https-oidc-test.sh" 'assert_no_a_https_test_edge_container'
assert_contains "$SCRIPT_DIR/deploy-a-https-oidc-test.sh" 'assert_a_https_oidc_test_network_membership'
assert_contains "$SCRIPT_DIR/deploy-a-https-oidc-test.sh" 'docker stop -t 20 "$candidate_edge_id"'
assert_contains "$SCRIPT_DIR/deploy-a-https-oidc-test.sh" 'verify-a-https-oidc-test.sh'
assert_contains "$SCRIPT_DIR/deploy-a-https-oidc-test.sh" 'docker update --restart=unless-stopped'
assert_contains "$SCRIPT_DIR/deploy-a-https-oidc-test.sh" 'Keycloak changed while deploying the independent A-owned ingress edge.'

assert_contains "$SCRIPT_DIR/disable-a-https-oidc-test.sh" 'Usage: disable-a-https-oidc-test.sh'
assert_contains "$SCRIPT_DIR/disable-a-https-oidc-test.sh" 'assert_no_a_https_oidc_test_edge_container'
assert_contains "$SCRIPT_DIR/disable-a-https-oidc-test.sh" 'docker rm "$edge_id"'
assert_contains "$SCRIPT_DIR/disable-a-https-oidc-test.sh" 'Keycloak, databases, and Docker networks were preserved.'

assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'verify_hostname "$hostname"'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" '/realms/master/.well-known/openid-configuration'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" '/realms/sciforge/.well-known/openid-configuration'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" '/REALMS/SciForge/.well-known/openid-configuration'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" '/realms/SciForgeX/.well-known/openid-configuration'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" '/realms/SciForge/%2e%2e/master/.well-known/openid-configuration'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" '--path-as-is --output /dev/null'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'Trusted Zulip binding confirm is not fail-closed with exact HTTP 401.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'Keycloak Discovery does not publish the exact HTTPS issuer/token/revocation endpoints and RS256/S256 support.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'revocation_endpoint: `${issuer}/protocol/openid-connect/revoke`'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'body.code_challenge_methods_supported.includes("S256")'
assert_not_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'end_session_endpoint:'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'Keycloak JWKS has no unique usable RSA/RS256 signing key.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'unexpected_identity_edge_response'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'published_443_count" == 1'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The A-only console must remain unavailable on the OIDC edge.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The fixed Portal entry did not return the exact relative /portal/ location.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'x-sciforge-portal-mode: confidential-bff'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The Portal HTML is not uniquely marked no-store.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The Portal HTML lacks frame denial.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The public Portal runtime asset does not match its fixed bytes and SHA-256.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The manifest-bound Portal runtime asset is not uniquely immutable-cacheable.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The Portal runtime asset did not honor its exact ETag with HTTP 304.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" '/portal/ASSET_INTEGRITY.json /portal/.vite/manifest.json'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'portal_authentication_required'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The Portal session endpoint accepted cross-site Fetch Metadata.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The Portal session rejection lacks its unique no-store/CSP boundary.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The removed raw Portal command relay is not a fixed HTTP 404 tombstone.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" '"$cloud_url/portal/api/commands")" == 404'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" '"$cloud_url/portal/api/projects")" == 401'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The anonymous typed Portal project view did not return HTTP 401.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The anonymous typed Portal project mutation did not return HTTP 401.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The typed Portal project mutation accepted a cross-site write.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The anonymous Portal logout boundary did not return HTTP 204.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'portal.websocket_required'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The Portal HTTP event response lacks Upgrade: websocket.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'Sec-WebSocket-Protocol: sciforge.portal.v1'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'portal_login_rejected'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The Portal callback replay did not remain fail-closed after consuming the transaction.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" '__Host-sciforge-portal-login='
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'value.searchParams.get("client_id") !== "sciforge-cloud-console"'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'X-Forwarded-For: 198.51.100.10, 127.0.0.1'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'after edge X-Forwarded-For canonicalization.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'The Portal login redirect lacks its unique no-store/CSP boundary.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET|KC_DB_'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test.sh" 'Real browser login and real-token acceptance remain separate maintenance-window gates.'

assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'identity_hostname=login-test.sciforge.cn'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" '/realms/master/.well-known/openid-configuration'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" '/realms/sciforge/.well-known/openid-configuration'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" '/REALMS/SciForge/.well-known/openid-configuration'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" '/realms/SciForgeX/.well-known/openid-configuration'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" '/realms/SciForge/%2e%2e/master/.well-known/openid-configuration'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" '--path-as-is --output /dev/null'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'expected_issuer=https://login-test.sciforge.cn/realms/SciForge'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'Public Keycloak Discovery does not publish the exact HTTPS issuer/token/revocation endpoints and RS256/S256 support.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'revocation_endpoint: `${issuer}/protocol/openid-connect/revoke`'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'body.code_challenge_methods_supported.includes("S256")'
assert_not_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'end_session_endpoint:'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'Forbidden public TCP port $forbidden_port is reachable.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public OIDC edge exposed the A-only console.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public Portal entry did not return the exact relative /portal/ location.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'x-sciforge-portal-mode: confidential-bff'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public Portal HTML is not uniquely marked no-store.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public Portal HTML lacks frame denial.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public Portal asset does not match the fixed manifest bytes and SHA-256.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public manifest-bound Portal asset is not uniquely immutable-cacheable.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public Portal asset did not honor its exact ETag with HTTP 304.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" '/portal/ASSET_INTEGRITY.json /portal/.vite/manifest.json'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'portal_authentication_required'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public Portal session endpoint accepted cross-site Fetch Metadata.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public Portal session rejection lacks its unique no-store/CSP boundary.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The removed public raw Portal command relay is not a fixed HTTP 404 tombstone.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" '"$cloud_url/portal/api/commands")" == 404'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" '"$cloud_url/portal/api/projects")" == 401'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The anonymous public typed Portal project view did not return HTTP 401.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The anonymous public typed Portal project mutation did not return HTTP 401.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public typed Portal project mutation accepted a cross-site write.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The anonymous public Portal logout boundary did not return HTTP 204.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'portal.websocket_required'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public Portal HTTP event response lacks Upgrade: websocket.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'Sec-WebSocket-Protocol: sciforge.portal.v1'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'portal_login_rejected'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public Portal callback replay did not remain fail-closed after consuming the transaction.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" '__Host-sciforge-portal-login='
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'value.searchParams.get("client_id") !== "sciforge-cloud-console"'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'The public Portal login redirect lacks its unique no-store/CSP boundary.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'No successful browser login, real-token, or cross-team E2E claim is made.'
assert_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'createHash("sha256").update(body).digest("hex")'
assert_not_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" "stat -c"
assert_not_contains "$SCRIPT_DIR/verify-a-https-oidc-test-external.sh" 'sha256sum'
assert_not_contains "$DEPLOY_DIR/.env.example" 'sciforge-desktop,sciforge-web-mobile,sciforge-cloud-console'

assert_contains "$DEPLOY_DIR/.env.example" 'SCIFORGE_A_HTTPS_OIDC_TEST_IPV4='
assert_contains "$DEPLOY_DIR/.env.example" 'SCIFORGE_A_HTTPS_OIDC_TEST_STATE_DIR=/srv/sciforge-collaboration/a-https-oidc-test'
assert_contains "$DEPLOY_DIR/.env.example" 'SCIFORGE_COLLABORATION_OIDC_ISSUER=https://login-test.sciforge.cn/realms/SciForge'
assert_contains "$DEPLOY_DIR/README.md" '--a-https-oidc-test'
assert_contains "$DEPLOY_DIR/README.md" 'sciforge-keycloak_identity-edge'
assert_contains "$DEPLOY_DIR/README.md" 'disable-a-https-oidc-test.sh'
assert_contains "$DEPLOY_DIR/README.md" 'identityEdgeExternalVerifyScriptSha256'
assert_contains "$DEPLOY_DIR/README.md" 'identityAcceptanceHarnessSha256'
assert_contains "$DEPLOY_DIR/README.md" 'multiWorkerAcceptanceHarnessSha256'
assert_contains "$DEPLOY_DIR/README.md" 'realFileRun0ReceiptHarnessSha256'
assert_contains "$DEPLOY_DIR/README.md" '${m.identityEdgeExternalVerifyScriptSha256}\t${m.identityAcceptanceHarnessSha256}\t${m.multiWorkerAcceptanceHarnessSha256}\t${m.realFileRun0ReceiptHarnessSha256}\n'
assert_contains "$DEPLOY_DIR/README.md" 'shasum -a 256 "$identity_harness"'
assert_contains "$DEPLOY_DIR/README.md" 'shasum -a 256 "$multi_worker_harness"'
assert_contains "$DEPLOY_DIR/README.md" 'shasum -a 256 "$real_file_receipt_harness"'
assert_contains "$DEPLOY_DIR/README.md" 'unset NODE_OPTIONS NODE_PATH NODE_DEBUG NODE_DEBUG_NATIVE NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED NODE_USE_ENV_PROXY'
assert_contains "$DEPLOY_DIR/README.md" 'unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy NO_PROXY no_proxy'
assert_contains "$DEPLOY_DIR/README.md" 'unset SSL_CERT_FILE ssl_cert_file SSL_CERT_DIR ssl_cert_dir CURL_CA_BUNDLE curl_ca_bundle'
assert_contains "$DEPLOY_DIR/README.md" 'node "$multi_worker_harness"'
assert_contains "$DEPLOY_DIR/README.md" 'scripts/collaboration-a-multi-worker-acceptance.mjs'
assert_contains "$DEPLOY_DIR/README.md" 'scripts/collaboration-real-file-task-loop-run-0.mjs'
assert_not_contains "$DEPLOY_DIR/README.md" 'scripts/collaboration-a-dual-principal-acceptance.mjs'
assert_contains "$DEPLOY_DIR/README.md" '--expected-identity-harness-sha256 "$identity_harness_sha"'
assert_contains "$DEPLOY_DIR/README.md" '--expected-multi-worker-harness-sha256 "$multi_worker_harness_sha"'
assert_contains "$DEPLOY_DIR/README.md" '--worker-descriptor-file "$worker_descriptor_file_1"'
assert_contains "$DEPLOY_DIR/README.md" '--worker-descriptor-file "$worker_descriptor_file_2"'
assert_contains "$DEPLOY_DIR/README.md" '`auth_time` 在 multi-worker harness preflight 时不得超过 120 秒'
assert_contains "$DEPLOY_DIR/README.md" '1 个 Orchestrator → 2–8 个独立 Worker'
assert_not_contains "$DEPLOY_DIR/README.md" 'dualPrincipalAcceptanceHarnessSha256'
assert_not_contains "$DEPLOY_DIR/README.md" '--worker-token-file'
assert_not_contains "$DEPLOY_DIR/README.md" '--worker-revoke-token-file'
assert_contains "$DEPLOY_DIR/README.md" $'(\n  set -euo pipefail\n  unset NODE_OPTIONS NODE_PATH NODE_DEBUG NODE_DEBUG_NATIVE NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED NODE_USE_ENV_PROXY'
assert_not_contains "$DEPLOY_DIR/README.md" 'npm run collaboration:a:identity:acceptance --'
assert_not_contains "$DEPLOY_DIR/README.md" 'auth_time` 在运行时仍不超过 240 秒'
acceptance_block_order="$(awk '
  $0 == "(" { candidate_open=NR }
  index($0, "set -euo pipefail") && candidate_open > 0 { strict=candidate_open == NR - 1 ? NR : strict }
  index($0, "unset NODE_OPTIONS NODE_PATH NODE_DEBUG NODE_DEBUG_NATIVE NODE_EXTRA_CA_CERTS") { open=candidate_open; sanitize=NR }
  index($0, "read -r external_sha identity_harness_sha multi_worker_harness_sha") { extract=NR }
  index($0, "\"$external_verifier\" \"$release_commit\" \"$external_sha\"") { external=NR }
  index($0, "shasum -a 256 \"$multi_worker_harness\"") { hash=NR }
  index($0, "node \"$multi_worker_harness\"") { run=NR }
  $0 == ")" && run > 0 && closing_line == 0 { closing_line=NR }
  END {
    if (open > 0 && open < strict && strict < sanitize && sanitize < extract && extract < external &&
        external < hash && hash < run && run < closing_line) print "pass"
  }
' "$DEPLOY_DIR/README.md")"
[[ "$acceptance_block_order" == pass ]] \
  || die "Manifest extraction, external verification, harness hashing, and harness execution must remain ordered inside one sanitized subshell."

assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_OIDC_ISSUER: ${SCIFORGE_COLLABORATION_OIDC_ISSUER:-}'
assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_ALLOWED_ORIGINS: ${SCIFORGE_COLLABORATION_ALLOWED_ORIGINS:-}'
assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_OIDC_AUDIENCE: ${SCIFORGE_COLLABORATION_OIDC_AUDIENCE:-sciforge-cloud-api}'
assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_OIDC_AUTHORIZED_PARTIES: ${SCIFORGE_COLLABORATION_OIDC_AUTHORIZED_PARTIES:-sciforge-desktop,sciforge-web-mobile}'
assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK: ${SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK:-false}'
assert_contains "$SCRIPT_DIR/verify.sh" 'zulip_binding_requests'
assert_contains "$SCRIPT_DIR/verify.sh" "pairingResponse.status !== 401"
assert_contains "$SCRIPT_DIR/verify.sh" "meResponse.status !== 401"
assert_contains "$SCRIPT_DIR/verify.sh" "confirmResponse.status !== 401"
assert_contains "$SCRIPT_DIR/verify.sh" 'node /app/verify-portal-assets.mjs'
assert_contains "$SCRIPT_DIR/verify.sh" 'expected_schema_version" == 10'
assert_contains "$SCRIPT_DIR/verify.sh" 'portal_bounded_read_index_receipt'
assert_contains "$SCRIPT_DIR/verify.sh" 'portal_hard_cap_violation_count'
assert_contains "$SCRIPT_DIR/verify.sh" 'HAVING count(*)>1000'
assert_contains "$SCRIPT_DIR/verify.sh" 'HAVING count(*)>50000'
assert_contains "$SCRIPT_DIR/verify.sh" 'HAVING count(*)>10000'
assert_contains "$SCRIPT_DIR/verify.sh" 'actual.predicate IS NOT DISTINCT FROM expected.predicate'
assert_contains "$SCRIPT_DIR/verify.sh" 'ten exact Portal/coordination bounded-read indexes'
assert_contains "$SCRIPT_DIR/verify.sh" 'human_answers_project_created_answer_idx'
assert_contains "$SCRIPT_DIR/verify.sh" 'project_content_space_bindings_active_root_unique'
assert_contains "$SCRIPT_DIR/verify.sh" "column_name='file_intent'"

assert_contains "$DEPLOY_DIR/README.md" 'AllowStreamLocalForwarding no'
assert_contains "$DEPLOY_DIR/README.md" '精确返回 `503`'
assert_contains "$DEPLOY_DIR/README.md" '未获验证的 app'
assert_contains "$DEPLOY_DIR/README.md" 'verify-postgres-v5-integration.sh'
assert_contains "$DEPLOY_DIR/README.md" 'CREATE/DROP DATABASE'
assert_contains "$DEPLOY_DIR/README.md" 'COPYFILE_DISABLE=1 tar -C "$package_root" -czf "$archive" deploy'

echo "Static deployment policy verification passed."
