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
for edge_script in deploy-a-https-test-edge.sh disable-a-https-test-edge.sh \
    verify-a-https-test-edge.sh verify-a-https-test-edge-external.sh; do
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

assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '[[ "$ready_status" == 503 ]]'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'running_contract_commit'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'running_image_id'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'approved_image_revision'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '--core-only'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '--provider-zulip'
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
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '^sciforge_identity_v5_it_[0-9]+_[0-9a-f]{12}$'
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

assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_OIDC_ISSUER: ${SCIFORGE_COLLABORATION_OIDC_ISSUER:-}'
assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_ALLOWED_ORIGINS: ${SCIFORGE_COLLABORATION_ALLOWED_ORIGINS:-}'
assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_OIDC_AUDIENCE: ${SCIFORGE_COLLABORATION_OIDC_AUDIENCE:-sciforge-cloud-api}'
assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_OIDC_AUTHORIZED_PARTIES: ${SCIFORGE_COLLABORATION_OIDC_AUTHORIZED_PARTIES:-sciforge-desktop,sciforge-web-mobile}'
assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK: ${SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK:-false}'
assert_contains "$SCRIPT_DIR/verify.sh" 'zulip_binding_requests'
assert_contains "$SCRIPT_DIR/verify.sh" "pairingResponse.status !== 401"
assert_contains "$SCRIPT_DIR/verify.sh" "meResponse.status !== 401"
assert_contains "$SCRIPT_DIR/verify.sh" "confirmResponse.status !== 401"

assert_contains "$DEPLOY_DIR/README.md" 'AllowStreamLocalForwarding no'
assert_contains "$DEPLOY_DIR/README.md" '精确返回 `503`'
assert_contains "$DEPLOY_DIR/README.md" '未获验证的 app'
assert_contains "$DEPLOY_DIR/README.md" 'verify-postgres-v5-integration.sh'
assert_contains "$DEPLOY_DIR/README.md" 'CREATE/DROP DATABASE'
assert_contains "$DEPLOY_DIR/README.md" 'COPYFILE_DISABLE=1 tar -C "$package_root" -czf "$archive" deploy'

echo "Static deployment policy verification passed."
