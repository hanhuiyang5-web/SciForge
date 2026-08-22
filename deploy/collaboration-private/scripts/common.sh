#!/usr/bin/env bash

set -euo pipefail

COMMON_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PRIVATE_DEPLOY_DIR="$(cd "$COMMON_SCRIPT_DIR/.." && pwd -P)"
COMPOSE_FILE="$PRIVATE_DEPLOY_DIR/compose.yml"
PROVIDER_COMPOSE_FILE="$PRIVATE_DEPLOY_DIR/compose.provider-zulip.yml"
A_HTTPS_TEST_EDGE_COMPOSE_FILE="$PRIVATE_DEPLOY_DIR/compose.a-https-test-edge.yml"
A_HTTPS_TEST_EDGE_CADDYFILE="$PRIVATE_DEPLOY_DIR/Caddyfile.a-https-test-edge"
A_HTTPS_OIDC_TEST_COMPOSE_FILE="$PRIVATE_DEPLOY_DIR/compose.a-https-oidc-test.yml"
A_HTTPS_OIDC_TEST_CADDYFILE="$PRIVATE_DEPLOY_DIR/Caddyfile.a-https-oidc-test"
A_CLOUD_PORTAL_COMPOSE_FILE="$PRIVATE_DEPLOY_DIR/compose.a-cloud-portal.yml"
BUNDLE_DIR="$PRIVATE_DEPLOY_DIR/bundle"
RELEASE_EXPECTED_SCHEMA_VERSION=""
RELEASE_EXPECTED_TABLES=""
RELEASE_MANIFEST_MODE=""
RELEASE_MANIFEST_HOSTNAME=""
RELEASE_MANIFEST_DEPLOYMENT_BOUNDARY=""
RELEASE_MANIFEST_IDENTITY_HOSTNAME=""
RELEASE_MANIFEST_OIDC_ISSUER=""
A_HTTPS_TEST_EDGE_HOSTNAME=cloud-test.sciforge.cn
A_HTTPS_TEST_EDGE_ORIGIN=https://cloud-test.sciforge.cn
A_HTTPS_TEST_EDGE_PUBLIC_IPV4=47.76.230.118
A_HTTPS_TEST_EDGE_NETWORK=sciforge-collaboration-private_private-edge
A_HTTPS_TEST_EDGE_DATABASE_NETWORK=sciforge-collaboration-private_database
A_HTTPS_TEST_EDGE_PROJECT=sciforge-collaboration-a-https-test-edge
A_HTTPS_TEST_EDGE_STATE_DIR=/srv/sciforge-collaboration/a-https-test-edge
A_HTTPS_TEST_EDGE_IMAGE_DIGEST=sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a
A_HTTPS_TEST_EDGE_IMAGE="caddy:2.11.4-alpine@$A_HTTPS_TEST_EDGE_IMAGE_DIGEST"
A_HTTPS_TEST_EDGE_IMAGE_ID=""
A_HTTPS_TEST_EDGE_APP_CONTAINER_ID=""
A_HTTPS_OIDC_TEST_HOSTNAME=cloud-test.sciforge.cn
A_HTTPS_OIDC_TEST_ORIGIN=https://cloud-test.sciforge.cn
A_HTTPS_OIDC_TEST_IDENTITY_HOSTNAME=login-test.sciforge.cn
A_HTTPS_OIDC_TEST_ISSUER=https://login-test.sciforge.cn/realms/SciForge
A_HTTPS_OIDC_TEST_AUDIENCE=sciforge-cloud-api
A_HTTPS_OIDC_TEST_AUTHORIZED_PARTIES=sciforge-desktop,sciforge-web-mobile
A_CLOUD_PORTAL_ASSET_DIR=/app/node_modules/@sciforge/collaboration-portal/dist
A_CLOUD_PORTAL_CLIENT_ID=sciforge-cloud-console
A_CLOUD_PORTAL_REDIRECT_URI=https://cloud-test.sciforge.cn/portal/auth/callback
A_CLOUD_PORTAL_CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; manifest-src 'none'"
A_HTTPS_OIDC_TEST_PUBLIC_IPV4=47.76.230.118
A_HTTPS_OIDC_TEST_APP_NETWORK=sciforge-collaboration-private_private-edge
A_HTTPS_OIDC_TEST_DATABASE_NETWORK=sciforge-collaboration-private_database
A_HTTPS_OIDC_TEST_IDENTITY_NETWORK=sciforge-keycloak_identity-edge
A_HTTPS_OIDC_TEST_PROJECT=sciforge-collaboration-a-https-oidc-test
A_HTTPS_OIDC_TEST_STATE_DIR=/srv/sciforge-collaboration/a-https-oidc-test
A_HTTPS_OIDC_TEST_IMAGE_DIGEST=sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a
A_HTTPS_OIDC_TEST_IMAGE="caddy:2.11.4-alpine@$A_HTTPS_OIDC_TEST_IMAGE_DIGEST"
A_HTTPS_OIDC_TEST_IMAGE_ID=""
A_HTTPS_OIDC_TEST_APP_CONTAINER_ID=""
A_HTTPS_OIDC_TEST_KEYCLOAK_CONTAINER_ID=""
PRIVATE_ROOT=/srv/sciforge-collaboration
PRIVATE_ENV_DIR=/srv/sciforge-collaboration/secrets
PRIVATE_ENV_FILE="$PRIVATE_ENV_DIR/collaboration.env"
COLLABORATION_RUNTIME_DIR=/run/sciforge-collaboration-private

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1"
}

require_root() {
  [[ "$(id -u)" == 0 ]] || die "This deployment command must run as root."
}

validate_local_docker_endpoint() {
  local active_context
  local endpoint

  [[ -z "${DOCKER_HOST:-}" ]] \
    || die "DOCKER_HOST is forbidden; edge operations must use the local ECS Docker daemon."
  [[ -S /var/run/docker.sock ]] \
    || die "The local ECS Docker socket is unavailable."
  active_context="$(docker context show)"
  endpoint="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}' "$active_context")"
  [[ "$endpoint" == unix:///var/run/docker.sock ]] \
    || die "The active Docker context is not the local ECS Unix socket."
}

acquire_collaboration_deploy_lock() {
  local lock_path="$COLLABORATION_RUNTIME_DIR/deploy.lock"
  local inherited_target=""
  local permissions

  require_root
  [[ -d /run && ! -L /run && "$(readlink -f /run)" == /run \
      && "$(stat -c '%u:%g' /run)" == 0:0 ]] \
    || die "The runtime root must be the physical root-owned /run directory."
  permissions="$(stat -c '%a' /run)"
  (( (8#$permissions & 022) == 0 )) \
    || die "The runtime root must not be writable by group or other."
  [[ ! -L "$COLLABORATION_RUNTIME_DIR" ]] \
    || die "The collaboration runtime directory must not be a symlink."
  install -d -o root -g root -m 0700 "$COLLABORATION_RUNTIME_DIR"
  [[ "$(readlink -f "$COLLABORATION_RUNTIME_DIR")" == "$COLLABORATION_RUNTIME_DIR" \
      && "$(stat -c '%u:%g:%a' "$COLLABORATION_RUNTIME_DIR")" == 0:0:700 ]] \
    || die "The collaboration runtime directory must be root:root mode 0700."

  if [[ -e /proc/self/fd/8 ]]; then
    inherited_target="$(readlink -f /proc/self/fd/8 2>/dev/null || true)"
  fi
  if [[ "$inherited_target" == "$lock_path" ]]; then
    flock -n 8 || die "The inherited collaboration deployment lock is invalid."
    return
  fi
  if [[ -e "$lock_path" || -L "$lock_path" ]]; then
    [[ -f "$lock_path" && ! -L "$lock_path" \
        && "$(stat -c '%u:%g' "$lock_path")" == 0:0 ]] \
      || die "The collaboration deployment lock path is unsafe."
    permissions="$(stat -c '%a' "$lock_path")"
    (( (8#$permissions & 022) == 0 )) \
      || die "The collaboration deployment lock is writable by group or other."
  fi
  exec 8>"$lock_path"
  chmod 0600 "$lock_path"
  flock -n 8 \
    || die "Another collaboration deployment or verification is already running."
}

canonical_regular_file() {
  local input="$1"
  local candidate
  if [[ "$input" = /* ]]; then
    candidate="$input"
  else
    candidate="$PWD/$input"
  fi
  [[ -f "$candidate" && ! -L "$candidate" ]] || die "Expected a regular, non-symlink file: $candidate"
  printf '%s/%s\n' "$(cd "$(dirname "$candidate")" && pwd -P)" "$(basename "$candidate")"
}

canonical_directory() {
  local input="$1"
  local candidate
  if [[ "$input" = /* ]]; then
    candidate="$input"
  else
    candidate="$PWD/$input"
  fi
  [[ -d "$candidate" && ! -L "$candidate" ]] || die "Expected a directory, not a symlink: $candidate"
  (cd "$candidate" && pwd -P)
}

validate_private_env_file() {
  local file="$1"
  local root_permissions

  [[ "$file" == "$PRIVATE_ENV_FILE" ]] \
    || die "Production env must be the fixed $PRIVATE_ENV_FILE file."
  [[ -d "$PRIVATE_ROOT" && ! -L "$PRIVATE_ROOT" \
      && "$(cd "$PRIVATE_ROOT" && pwd -P)" == "$PRIVATE_ROOT" \
      && "$(stat -c '%u:%g' "$PRIVATE_ROOT")" == 0:0 ]] \
    || die "Production root must be the physical root-owned $PRIVATE_ROOT directory."
  root_permissions="$(stat -c '%a' "$PRIVATE_ROOT")"
  (( (8#$root_permissions & 022) == 0 )) \
    || die "Production root must not be writable by group or other."
  [[ -d "$PRIVATE_ENV_DIR" && ! -L "$PRIVATE_ENV_DIR" \
      && "$(cd "$PRIVATE_ENV_DIR" && pwd -P)" == "$PRIVATE_ENV_DIR" ]] \
    || die "Production secrets directory must be the physical $PRIVATE_ENV_DIR directory."
  [[ "$(stat -c '%u:%g:%a' "$PRIVATE_ENV_DIR")" == 0:0:700 ]] \
    || die "Production secrets directory must be root:root mode 0700."
  [[ -f "$file" && ! -L "$file" \
      && "$(stat -c '%u:%g:%a' "$file")" == 0:0:600 ]] \
    || die "Production env must be a root:root regular file with mode 0600."
}

fixed_compose_value() {
  local file="$1"
  local key="$2"
  local expected="$3"
  local value

  value="$(dotenv_value "$file" "$key" optional)"
  value="${value:-$expected}"
  [[ "$value" == "$expected" ]] \
    || die "$key must retain the fixed A ECS value $expected."
  printf '%s' "$value"
}

dotenv_value() {
  local file="$1"
  local key="$2"
  local required="${3:-required}"
  local matches=()
  local value
  mapfile -t matches < <(awk -v prefix="${key}=" 'index($0, prefix) == 1 { sub(/\r$/, ""); print }' "$file")
  (( ${#matches[@]} <= 1 )) || die "Env file contains duplicate $key entries."
  if (( ${#matches[@]} == 0 )); then
    [[ "$required" == optional ]] && return 0
    die "Env file is missing $key."
  fi
  value="${matches[0]#*=}"
  if [[ "$value" == \"*\" && ${#value} -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  fi
  [[ -n "$value" || "$required" == optional ]] || die "Env value $key must not be empty."
  printf '%s' "$value"
}

validate_commit() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "A full lowercase 40-character contract commit is required."
}

bundle_contract_commit() {
  local commit_file="$BUNDLE_DIR/CONTRACT_COMMIT"
  local commit
  local commit_lines=()
  [[ -f "$commit_file" && ! -L "$commit_file" ]] || die "Bundle is missing regular CONTRACT_COMMIT."
  mapfile -t commit_lines < "$commit_file"
  (( ${#commit_lines[@]} == 1 )) || die "CONTRACT_COMMIT must contain exactly one line."
  commit="${commit_lines[0]%$'\r'}"
  validate_commit "$commit"
  printf '%s' "$commit"
}

validate_fixed_edge_asset() {
  local path="$1"
  local expected_digest="$2"
  local executable="${3:-false}"
  local permissions

  [[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]] || die "The edge asset digest is malformed."
  [[ -f "$path" && ! -L "$path" ]] || die "A fixed edge asset is missing or unsafe: $path"
  [[ "$(stat -c '%u:%g' "$path")" == 0:0 ]] || die "Every fixed edge asset must be root-owned."
  permissions="$(stat -c '%a' "$path")"
  (( (8#$permissions & 022) == 0 )) || die "A fixed edge asset is writable by group/other."
  if [[ "$executable" == true ]]; then
    [[ -x "$path" ]] || die "A fixed edge script is not executable."
  fi
  [[ "$(sha256sum "$path" | awk '{print $1}')" == "$expected_digest" ]] \
    || die "A fixed edge asset does not match the release manifest."
}

validate_fixed_edge_release_ancestors() {
  local expected_commit="$1"
  local expected_deploy_dir="/srv/sciforge-collaboration/releases/$expected_commit/deploy/collaboration-private"
  local path
  local permissions

  [[ "$(readlink -f "$PRIVATE_DEPLOY_DIR")" == "$expected_deploy_dir" ]] \
    || die "The HTTPS edge must run from the fixed root-owned release path."
  for path in /srv/sciforge-collaboration \
      /srv/sciforge-collaboration/releases \
      "/srv/sciforge-collaboration/releases/$expected_commit" \
      "/srv/sciforge-collaboration/releases/$expected_commit/deploy" \
      "$expected_deploy_dir" "$expected_deploy_dir/scripts"; do
    [[ -d "$path" && ! -L "$path" ]] \
      || die "A fixed release ancestor is missing or is a symlink: $path"
    [[ "$(stat -c '%u:%g' "$path")" == 0:0 ]] \
      || die "Every fixed release ancestor must be root-owned."
    permissions="$(stat -c '%a' "$path")"
    (( (8#$permissions & 022) == 0 )) \
      || die "A fixed release ancestor is writable by group/other."
  done
}

validate_fixed_edge_release_path() {
  local expected_commit="$1"
  local entry
  local permissions

  validate_fixed_edge_release_ancestors "$expected_commit"
  [[ -d "$PRIVATE_DEPLOY_DIR/postgres-init" && ! -L "$PRIVATE_DEPLOY_DIR/postgres-init" \
      && "$(stat -c '%u:%g' "$PRIVATE_DEPLOY_DIR/postgres-init")" == 0:0 ]] \
    || die "The fixed postgres-init directory must be root-owned and non-symlinked."
  permissions="$(stat -c '%a' "$PRIVATE_DEPLOY_DIR/postgres-init")"
  (( (8#$permissions & 022) == 0 )) \
    || die "The fixed postgres-init directory is writable by group/other."
  [[ -d "$BUNDLE_DIR" && ! -L "$BUNDLE_DIR" \
      && "$(stat -c '%u:%g' "$BUNDLE_DIR")" == 0:0 ]] \
    || die "The fixed bundle directory must be root-owned and non-symlinked."
  permissions="$(stat -c '%a' "$BUNDLE_DIR")"
  (( (8#$permissions & 022) == 0 )) \
    || die "The fixed bundle directory is writable by group/other."
  shopt -s nullglob dotglob
  for entry in "$BUNDLE_DIR"/*; do
    [[ -f "$entry" && ! -L "$entry" && "$(stat -c '%u:%g' "$entry")" == 0:0 ]] \
      || die "Every fixed bundle entry must be a root-owned regular file."
    permissions="$(stat -c '%a' "$entry")"
    (( (8#$permissions & 022) == 0 )) \
      || die "A fixed bundle entry is writable by group/other."
  done
  shopt -u nullglob dotglob
}

consume_postgres_v5_attestation() {
  local candidate_image_id="$1"
  local expected_commit="$2"
  local attestation_path=/run/sciforge-collaboration-private-postgres-v5.attestation
  local claimed_path="${attestation_path}.claimed.$$"
  local lines=()
  local release_manifest_digest
  local bundle_sums_digest
  local bundle_commit_digest
  local runner_script_digest
  local verifier_script_digest
  local verified_epoch
  local verified_utc
  local now_epoch
  local expected_utc

  validate_commit "$expected_commit"
  [[ "$candidate_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "The PostgreSQL current-schema attestation candidate image ID is invalid."
  [[ -f "$attestation_path" && ! -L "$attestation_path" \
      && "$(stat -c '%u:%g:%a' "$attestation_path")" == 0:0:600 ]] \
    || die "A root-only PostgreSQL current-schema integration attestation is required before deployment."
  [[ ! -e "$claimed_path" && ! -L "$claimed_path" ]] \
    || die "The PostgreSQL current-schema attestation claim path already exists."
  mv -- "$attestation_path" "$claimed_path"
  [[ -f "$claimed_path" && ! -L "$claimed_path" \
      && "$(stat -c '%u:%g:%a' "$claimed_path")" == 0:0:600 ]] \
    || die "The claimed PostgreSQL current-schema attestation is unsafe."

  mapfile -t lines < "$claimed_path"
  (( ${#lines[@]} == 11 )) \
    || die "The PostgreSQL current-schema attestation has an invalid field set."
  [[ "${lines[0]}" == schemaVersion=1 \
      && "${lines[1]}" == status=passed \
      && "${lines[2]}" == "contractCommit=$expected_commit" \
      && "${lines[3]}" == "candidateImageId=$candidate_image_id" \
      && "${lines[4]}" =~ ^releaseManifestSha256=[0-9a-f]{64}$ \
      && "${lines[5]}" =~ ^bundleSumsSha256=[0-9a-f]{64}$ \
      && "${lines[6]}" =~ ^bundleCommitSha256=[0-9a-f]{64}$ \
      && "${lines[7]}" =~ ^runnerScriptSha256=[0-9a-f]{64}$ \
      && "${lines[8]}" =~ ^verifierScriptSha256=[0-9a-f]{64}$ \
      && "${lines[9]}" =~ ^verifiedEpoch=[0-9]{10,}$ \
      && "${lines[10]}" =~ ^verifiedAtUtc=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || die "The PostgreSQL current-schema attestation is malformed or belongs to another candidate."

  release_manifest_digest="$(sha256sum "$BUNDLE_DIR/RELEASE_MANIFEST.json" | awk '{print $1}')"
  bundle_sums_digest="$(sha256sum "$BUNDLE_DIR/SHA256SUMS" | awk '{print $1}')"
  bundle_commit_digest="$(sha256sum "$BUNDLE_DIR/CONTRACT_COMMIT" | awk '{print $1}')"
  runner_script_digest="$(sha256sum "$COMMON_SCRIPT_DIR/postgres-v5-integration.mjs" | awk '{print $1}')"
  verifier_script_digest="$(sha256sum "$COMMON_SCRIPT_DIR/verify-postgres-v5-integration.sh" | awk '{print $1}')"
  [[ "${lines[4]#*=}" == "$release_manifest_digest" \
      && "${lines[5]#*=}" == "$bundle_sums_digest" \
      && "${lines[6]#*=}" == "$bundle_commit_digest" \
      && "${lines[7]#*=}" == "$runner_script_digest" \
      && "${lines[8]#*=}" == "$verifier_script_digest" ]] \
    || die "The candidate image, release bundle, or integration runner changed after v5 verification."

  verified_epoch="${lines[9]#*=}"
  verified_utc="${lines[10]#*=}"
  now_epoch="$(date -u +%s)"
  expected_utc="$(date -u -d "@$verified_epoch" +%Y-%m-%dT%H:%M:%SZ)"
  [[ "$now_epoch" =~ ^[0-9]{10,}$ && "$expected_utc" == "$verified_utc" ]] \
    || die "The PostgreSQL current-schema attestation time is invalid."
  (( verified_epoch <= now_epoch + 60 && now_epoch - verified_epoch <= 1800 )) \
    || die "The PostgreSQL current-schema attestation is expired or from the future."

  rm -f -- "$claimed_path"
  echo "Consumed one-time PostgreSQL current-schema integration attestation for $expected_commit."
}

validate_release_bundle() {
  local expected_commit="$1"
  local required_file
  local manifest_file="$BUNDLE_DIR/RELEASE_MANIFEST.json"
  local manifest_commit
  local manifest_artifact
  local manifest_schema_version
  local manifest_release_mode
  local manifest_base_commit
  local manifest_deployment_boundary
  local manifest_hostname
  local manifest_identity_hostname
  local manifest_oidc_issuer
  local manifest_oidc_audience
  local manifest_oidc_authorized_parties
  local manifest_oidc_allow_insecure_loopback
  local manifest_binding_confirm_mode
  local manifest_provider_mode
  local manifest_identity_edge_network
  local manifest_identity_acceptance_harness_sha256
  local manifest_multi_worker_acceptance_harness_sha256
  local manifest_portal_enabled
  local manifest_portal_mode
  local manifest_portal_package_archive
  local manifest_portal_package_sha256
  local manifest_portal_base_path
  local manifest_portal_auth_path_prefix
  local manifest_portal_api_path_prefix
  local manifest_portal_events_path
  local manifest_portal_asset_directory
  local manifest_portal_vite_manifest_path
  local manifest_portal_vite_manifest_sha256
  local manifest_portal_integrity_manifest_path
  local manifest_portal_integrity_manifest_sha256
  local manifest_portal_public_origin
  local manifest_portal_authorized_party
  local manifest_portal_oidc_client_id
  local manifest_portal_oidc_redirect_uri
  local manifest_portal_human_needed_mode
  local manifest_portal_test_worker_directory_enabled
  local manifest_portal_session_idle_seconds
  local manifest_portal_session_absolute_seconds
  local manifest_portal_content_security_policy
  local manifest_portal_compose_sha256
  local manifest_portal_asset_verify_script_sha256
  local manifest_edge_caddy_image
  local manifest_edge_backup_script_sha256
  local manifest_edge_backup_restore_verify_script_sha256
  local manifest_edge_base_compose_sha256
  local manifest_edge_base_deploy_script_sha256
  local manifest_edge_base_verify_script_sha256
  local manifest_edge_caddyfile_sha256
  local manifest_edge_common_script_sha256
  local manifest_edge_compose_sha256
  local manifest_edge_deploy_script_sha256
  local manifest_edge_disable_script_sha256
  local manifest_edge_dockerignore_sha256
  local manifest_edge_external_verify_script_sha256
  local manifest_edge_postgres_init_script_sha256
  local manifest_edge_postgres_restart_verify_script_sha256
  local manifest_edge_postgres_v5_integration_script_sha256
  local manifest_edge_postgres_v5_verify_script_sha256
  local manifest_edge_runtime_dockerfile_sha256
  local manifest_edge_verify_script_sha256
  local manifest_identity_edge_caddyfile_sha256
  local manifest_identity_edge_compose_sha256
  local manifest_identity_edge_deploy_script_sha256
  local manifest_identity_edge_disable_script_sha256
  local manifest_identity_edge_external_verify_script_sha256
  local manifest_identity_edge_verify_script_sha256
  local manifest_filename
  local manifest_filenames=()
  local bundle_entries=()
  local bundle_entry
  local tarballs=()
  local domain_sdk_packages=0
  local contract_packages=0
  local provider_packages=0
  local portal_packages=0
  local server_packages=0
  local tarball
  local basename
  local line
  local digest
  local filename
  local extra
  local line_count=0
  local preliminary_release_mode
  declare -A allowed_files=()
  declare -A allowed_bundle_files=()
  declare -A manifest_seen_files=()
  declare -A seen_files=()

  validate_commit "$expected_commit"
  [[ -d "$BUNDLE_DIR" && ! -L "$BUNDLE_DIR" ]] || die "Bundle directory is missing or is a symlink: $BUNDLE_DIR"
  for required_file in package.json package-lock.json CONTRACT_COMMIT RELEASE_MANIFEST.json SHA256SUMS; do
    [[ -f "$BUNDLE_DIR/$required_file" && ! -L "$BUNDLE_DIR/$required_file" ]] \
      || die "Bundle is missing regular $required_file."
  done
  preliminary_release_mode="$(awk -F'"' '$2 == "releaseMode" { print $4 }' "$manifest_file")"
  if [[ "$preliminary_release_mode" == a-https-test-edge \
      || "$preliminary_release_mode" == a-https-oidc-test ]]; then
    validate_fixed_edge_release_path "$expected_commit"
  fi
  [[ "$(bundle_contract_commit)" == "$expected_commit" ]] \
    || die "Bundle CONTRACT_COMMIT does not match the approved commit."

  shopt -s nullglob
  tarballs=("$BUNDLE_DIR"/*.tgz)
  shopt -u nullglob
  (( ${#tarballs[@]} == 5 )) || die "Bundle must contain exactly five tarballs."
  for tarball in "${tarballs[@]}"; do
    [[ -f "$tarball" && ! -L "$tarball" ]] || die "Tarball must be a regular, non-symlink file."
    basename="$(basename "$tarball")"
    case "$basename" in
      sciforge-domain-sdk-*.tgz) ((domain_sdk_packages += 1)) ;;
      sciforge-collaboration-contracts-*.tgz) ((contract_packages += 1)) ;;
      sciforge-collaboration-provider-zulip-*.tgz) ((provider_packages += 1)) ;;
      sciforge-collaboration-portal-*.tgz) ((portal_packages += 1)) ;;
      sciforge-collaboration-server-*.tgz) ((server_packages += 1)) ;;
      *) die "Unexpected tarball in release bundle: $basename" ;;
    esac
    tar -tzf "$tarball" | awk '$0 == "package/package.json" { found=1 } END { exit(found ? 0 : 1) }' \
      || die "Tarball does not contain package/package.json: $basename"
    allowed_files["$basename"]=1
  done
  (( domain_sdk_packages == 1 && contract_packages == 1 && provider_packages == 1 \
      && portal_packages == 1 && server_packages == 1 )) \
    || die "Bundle must contain one domain SDK, one contracts, one Zulip provider, one Portal, and one server tarball."

  manifest_schema_version="$(awk '$1 == "\"schemaVersion\":" { gsub(/,/, "", $2); print $2 }' "$manifest_file")"
  manifest_artifact="$(awk -F'"' '$2 == "artifact" { print $4 }' "$manifest_file")"
  manifest_commit="$(awk -F'"' '$2 == "contractCommit" { print $4 }' "$manifest_file")"
  manifest_release_mode="$(awk -F'"' '$2 == "releaseMode" { print $4 }' "$manifest_file")"
  manifest_base_commit="$(awk -F'"' '$2 == "baseCommit" { print $4 }' "$manifest_file")"
  manifest_deployment_boundary="$(awk -F'"' '$2 == "deploymentBoundary" { print $4 }' "$manifest_file")"
  manifest_hostname="$(awk -F'"' '$2 == "hostname" { print $4 }' "$manifest_file")"
  manifest_identity_hostname="$(awk -F'"' '$2 == "identityHostname" { print $4 }' "$manifest_file")"
  manifest_oidc_issuer="$(awk -F'"' '$2 == "oidcIssuer" { print $4 }' "$manifest_file")"
  manifest_oidc_audience="$(awk -F'"' '$2 == "oidcAudience" { print $4 }' "$manifest_file")"
  manifest_oidc_authorized_parties="$(awk -F'"' '$2 == "oidcAuthorizedParties" { print $4 }' "$manifest_file")"
  manifest_oidc_allow_insecure_loopback="$(awk '$1 == "\"oidcAllowInsecureLoopback\":" { gsub(/,/, "", $2); print $2 }' "$manifest_file")"
  manifest_binding_confirm_mode="$(awk -F'"' '$2 == "bindingConfirmMode" { print $4 }' "$manifest_file")"
  manifest_provider_mode="$(awk -F'"' '$2 == "providerMode" { print $4 }' "$manifest_file")"
  manifest_identity_edge_network="$(awk -F'"' '$2 == "identityEdgeNetwork" { print $4 }' "$manifest_file")"
  manifest_identity_acceptance_harness_sha256="$(awk -F'"' '$2 == "identityAcceptanceHarnessSha256" { print $4 }' "$manifest_file")"
  manifest_multi_worker_acceptance_harness_sha256="$(awk -F'"' '$2 == "multiWorkerAcceptanceHarnessSha256" { print $4 }' "$manifest_file")"
  manifest_portal_enabled="$(awk '$1 == "\"portalEnabled\":" { gsub(/,/, "", $2); print $2 }' "$manifest_file")"
  manifest_portal_mode="$(awk -F'"' '$2 == "portalMode" { print $4 }' "$manifest_file")"
  manifest_portal_package_archive="$(awk -F'"' '$2 == "portalPackageArchive" { print $4 }' "$manifest_file")"
  manifest_portal_package_sha256="$(awk -F'"' '$2 == "portalPackageSha256" { print $4 }' "$manifest_file")"
  manifest_portal_base_path="$(awk -F'"' '$2 == "portalBasePath" { print $4 }' "$manifest_file")"
  manifest_portal_auth_path_prefix="$(awk -F'"' '$2 == "portalAuthPathPrefix" { print $4 }' "$manifest_file")"
  manifest_portal_api_path_prefix="$(awk -F'"' '$2 == "portalApiPathPrefix" { print $4 }' "$manifest_file")"
  manifest_portal_events_path="$(awk -F'"' '$2 == "portalEventsPath" { print $4 }' "$manifest_file")"
  manifest_portal_asset_directory="$(awk -F'"' '$2 == "portalAssetDirectory" { print $4 }' "$manifest_file")"
  manifest_portal_vite_manifest_path="$(awk -F'"' '$2 == "portalViteManifestPath" { print $4 }' "$manifest_file")"
  manifest_portal_vite_manifest_sha256="$(awk -F'"' '$2 == "portalViteManifestSha256" { print $4 }' "$manifest_file")"
  manifest_portal_integrity_manifest_path="$(awk -F'"' '$2 == "portalIntegrityManifestPath" { print $4 }' "$manifest_file")"
  manifest_portal_integrity_manifest_sha256="$(awk -F'"' '$2 == "portalIntegrityManifestSha256" { print $4 }' "$manifest_file")"
  manifest_portal_public_origin="$(awk -F'"' '$2 == "portalPublicOrigin" { print $4 }' "$manifest_file")"
  manifest_portal_authorized_party="$(awk -F'"' '$2 == "portalAuthorizedParty" { print $4 }' "$manifest_file")"
  manifest_portal_oidc_client_id="$(awk -F'"' '$2 == "portalOidcClientId" { print $4 }' "$manifest_file")"
  manifest_portal_oidc_redirect_uri="$(awk -F'"' '$2 == "portalOidcRedirectUri" { print $4 }' "$manifest_file")"
  manifest_portal_human_needed_mode="$(awk -F'"' '$2 == "portalHumanNeededMode" { print $4 }' "$manifest_file")"
  manifest_portal_test_worker_directory_enabled="$(awk '$1 == "\"portalTestWorkerDirectoryEnabled\":" { gsub(/,/, "", $2); print $2 }' "$manifest_file")"
  manifest_portal_session_idle_seconds="$(awk '$1 == "\"portalSessionIdleSeconds\":" { gsub(/,/, "", $2); print $2 }' "$manifest_file")"
  manifest_portal_session_absolute_seconds="$(awk '$1 == "\"portalSessionAbsoluteSeconds\":" { gsub(/,/, "", $2); print $2 }' "$manifest_file")"
  manifest_portal_content_security_policy="$(awk -F'"' '$2 == "portalContentSecurityPolicy" { print $4 }' "$manifest_file")"
  manifest_edge_caddy_image="$(awk -F'"' '$2 == "edgeCaddyImage" { print $4 }' "$manifest_file")"
  manifest_edge_backup_script_sha256="$(awk -F'"' '$2 == "edgeBackupScriptSha256" { print $4 }' "$manifest_file")"
  manifest_edge_backup_restore_verify_script_sha256="$(awk -F'"' '$2 == "edgeBackupRestoreVerifyScriptSha256" { print $4 }' "$manifest_file")"
  manifest_edge_base_compose_sha256="$(awk -F'"' '$2 == "edgeBaseComposeSha256" { print $4 }' "$manifest_file")"
  manifest_edge_base_deploy_script_sha256="$(awk -F'"' '$2 == "edgeBaseDeployScriptSha256" { print $4 }' "$manifest_file")"
  manifest_edge_base_verify_script_sha256="$(awk -F'"' '$2 == "edgeBaseVerifyScriptSha256" { print $4 }' "$manifest_file")"
  manifest_edge_caddyfile_sha256="$(awk -F'"' '$2 == "edgeCaddyfileSha256" { print $4 }' "$manifest_file")"
  manifest_edge_common_script_sha256="$(awk -F'"' '$2 == "edgeCommonScriptSha256" { print $4 }' "$manifest_file")"
  manifest_edge_compose_sha256="$(awk -F'"' '$2 == "edgeComposeSha256" { print $4 }' "$manifest_file")"
  manifest_edge_deploy_script_sha256="$(awk -F'"' '$2 == "edgeDeployScriptSha256" { print $4 }' "$manifest_file")"
  manifest_edge_disable_script_sha256="$(awk -F'"' '$2 == "edgeDisableScriptSha256" { print $4 }' "$manifest_file")"
  manifest_edge_dockerignore_sha256="$(awk -F'"' '$2 == "edgeDockerignoreSha256" { print $4 }' "$manifest_file")"
  manifest_edge_external_verify_script_sha256="$(awk -F'"' '$2 == "edgeExternalVerifyScriptSha256" { print $4 }' "$manifest_file")"
  manifest_edge_postgres_init_script_sha256="$(awk -F'"' '$2 == "edgePostgresInitScriptSha256" { print $4 }' "$manifest_file")"
  manifest_edge_postgres_restart_verify_script_sha256="$(awk -F'"' '$2 == "edgePostgresRestartVerifyScriptSha256" { print $4 }' "$manifest_file")"
  manifest_edge_postgres_v5_integration_script_sha256="$(awk -F'"' '$2 == "edgePostgresV5IntegrationScriptSha256" { print $4 }' "$manifest_file")"
  manifest_edge_postgres_v5_verify_script_sha256="$(awk -F'"' '$2 == "edgePostgresV5VerifyScriptSha256" { print $4 }' "$manifest_file")"
  manifest_edge_runtime_dockerfile_sha256="$(awk -F'"' '$2 == "edgeRuntimeDockerfileSha256" { print $4 }' "$manifest_file")"
  manifest_edge_verify_script_sha256="$(awk -F'"' '$2 == "edgeVerifyScriptSha256" { print $4 }' "$manifest_file")"
  manifest_identity_edge_caddyfile_sha256="$(awk -F'"' '$2 == "identityEdgeCaddyfileSha256" { print $4 }' "$manifest_file")"
  manifest_identity_edge_compose_sha256="$(awk -F'"' '$2 == "identityEdgeComposeSha256" { print $4 }' "$manifest_file")"
  manifest_identity_edge_deploy_script_sha256="$(awk -F'"' '$2 == "identityEdgeDeployScriptSha256" { print $4 }' "$manifest_file")"
  manifest_identity_edge_disable_script_sha256="$(awk -F'"' '$2 == "identityEdgeDisableScriptSha256" { print $4 }' "$manifest_file")"
  manifest_identity_edge_external_verify_script_sha256="$(awk -F'"' '$2 == "identityEdgeExternalVerifyScriptSha256" { print $4 }' "$manifest_file")"
  manifest_identity_edge_verify_script_sha256="$(awk -F'"' '$2 == "identityEdgeVerifyScriptSha256" { print $4 }' "$manifest_file")"
  manifest_portal_compose_sha256="$(awk -F'"' '$2 == "portalComposeSha256" { print $4 }' "$manifest_file")"
  manifest_portal_asset_verify_script_sha256="$(awk -F'"' '$2 == "portalAssetVerifyScriptSha256" { print $4 }' "$manifest_file")"
  mapfile -t manifest_filenames < <(awk -F'"' '$2 == "filename" { print $4 }' "$manifest_file")
  [[ "$manifest_artifact" == sciforge-collaboration-server-bundle \
      && "$manifest_commit" == "$expected_commit" ]] \
    || die "RELEASE_MANIFEST.json metadata does not match the approved release."
  case "$manifest_release_mode" in
    origin-gui)
      [[ "$manifest_schema_version" == 1 \
          && -z "$manifest_base_commit" && -z "$manifest_deployment_boundary" \
          && -z "$manifest_hostname" ]] \
        || die "origin-gui manifest must not carry private-release metadata."
      ;;
    private-test)
      validate_commit "$manifest_base_commit"
      [[ "$manifest_schema_version" == 1 \
          && -z "$manifest_deployment_boundary" && -z "$manifest_hostname" ]] \
        || die "private-test manifest contains an unexpected deployment boundary."
      ;;
    team-private-acceptance)
      validate_commit "$manifest_base_commit"
      [[ "$manifest_schema_version" == 1 \
          && "$manifest_deployment_boundary" == loopback-ssh-tunnel-only \
          && -z "$manifest_hostname" ]] \
        || die "Team private acceptance must retain the loopback/SSH-tunnel boundary."
      ;;
    a-https-test-edge)
      validate_commit "$manifest_base_commit"
      [[ "$manifest_schema_version" == 1 \
          && "$manifest_deployment_boundary" == public-https-core-only \
          && "$manifest_hostname" == "$A_HTTPS_TEST_EDGE_HOSTNAME" \
          && "$manifest_edge_caddy_image" == "$A_HTTPS_TEST_EDGE_IMAGE" ]] \
        || die "A HTTPS test edge manifest must retain its exact core-only hostname boundary."
      validate_fixed_edge_asset "$A_HTTPS_TEST_EDGE_CADDYFILE" \
        "$manifest_edge_caddyfile_sha256"
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/common.sh" \
        "$manifest_edge_common_script_sha256"
      validate_fixed_edge_asset "$A_HTTPS_TEST_EDGE_COMPOSE_FILE" \
        "$manifest_edge_compose_sha256"
      validate_fixed_edge_asset "$PRIVATE_DEPLOY_DIR/.dockerignore" \
        "$manifest_edge_dockerignore_sha256"
      validate_fixed_edge_asset "$COMPOSE_FILE" \
        "$manifest_edge_base_compose_sha256"
      validate_fixed_edge_asset "$PRIVATE_DEPLOY_DIR/Dockerfile.runtime" \
        "$manifest_edge_runtime_dockerfile_sha256"
      validate_fixed_edge_asset "$PRIVATE_DEPLOY_DIR/postgres-init/001-create-application-role.sh" \
        "$manifest_edge_postgres_init_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/deploy.sh" \
        "$manifest_edge_base_deploy_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify.sh" \
        "$manifest_edge_base_verify_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/backup.sh" \
        "$manifest_edge_backup_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify-backup-restore.sh" \
        "$manifest_edge_backup_restore_verify_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify-postgres-restart.sh" \
        "$manifest_edge_postgres_restart_verify_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify-postgres-v5-integration.sh" \
        "$manifest_edge_postgres_v5_verify_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/postgres-v5-integration.mjs" \
        "$manifest_edge_postgres_v5_integration_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/deploy-a-https-test-edge.sh" \
        "$manifest_edge_deploy_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/disable-a-https-test-edge.sh" \
        "$manifest_edge_disable_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify-a-https-test-edge-external.sh" \
        "$manifest_edge_external_verify_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify-a-https-test-edge.sh" \
        "$manifest_edge_verify_script_sha256" true
      ;;
    a-https-oidc-test)
      validate_commit "$manifest_base_commit"
      [[ "$manifest_schema_version" == 4 \
          && "$manifest_deployment_boundary" == public-https-oidc-test \
          && "$manifest_hostname" == "$A_HTTPS_OIDC_TEST_HOSTNAME" \
          && "$manifest_identity_hostname" == "$A_HTTPS_OIDC_TEST_IDENTITY_HOSTNAME" \
          && "$manifest_oidc_issuer" == "$A_HTTPS_OIDC_TEST_ISSUER" \
          && "$manifest_oidc_audience" == "$A_HTTPS_OIDC_TEST_AUDIENCE" \
          && "$manifest_oidc_authorized_parties" == "$A_HTTPS_OIDC_TEST_AUTHORIZED_PARTIES" \
          && "$manifest_oidc_allow_insecure_loopback" == false \
          && "$manifest_binding_confirm_mode" == disabled \
          && "$manifest_provider_mode" == disabled \
          && "$manifest_identity_edge_network" == "$A_HTTPS_OIDC_TEST_IDENTITY_NETWORK" \
          && "$manifest_identity_acceptance_harness_sha256" =~ ^[0-9a-f]{64}$ \
          && "$manifest_multi_worker_acceptance_harness_sha256" =~ ^[0-9a-f]{64}$ \
          && "$manifest_portal_enabled" == true \
          && "$manifest_portal_mode" == confidential-bff \
          && "$manifest_portal_package_archive" == sciforge-collaboration-portal-*.tgz \
          && "$manifest_portal_package_sha256" =~ ^[0-9a-f]{64}$ \
          && "$manifest_portal_base_path" == /portal/ \
          && "$manifest_portal_auth_path_prefix" == /portal/auth/ \
          && "$manifest_portal_api_path_prefix" == /portal/api/ \
          && "$manifest_portal_events_path" == /portal/events \
          && "$manifest_portal_asset_directory" == "$A_CLOUD_PORTAL_ASSET_DIR" \
          && "$manifest_portal_vite_manifest_path" == dist/.vite/manifest.json \
          && "$manifest_portal_vite_manifest_sha256" =~ ^[0-9a-f]{64}$ \
          && "$manifest_portal_integrity_manifest_path" == dist/ASSET_INTEGRITY.json \
          && "$manifest_portal_integrity_manifest_sha256" =~ ^[0-9a-f]{64}$ \
          && "$manifest_portal_public_origin" == "$A_HTTPS_OIDC_TEST_ORIGIN" \
          && "$manifest_portal_authorized_party" == "$A_CLOUD_PORTAL_CLIENT_ID" \
          && "$manifest_portal_oidc_client_id" == "$A_CLOUD_PORTAL_CLIENT_ID" \
          && "$manifest_portal_oidc_redirect_uri" == "$A_CLOUD_PORTAL_REDIRECT_URI" \
          && "$manifest_portal_human_needed_mode" == display-only \
          && "$manifest_portal_test_worker_directory_enabled" == true \
          && "$manifest_portal_session_idle_seconds" == 1800 \
          && "$manifest_portal_session_absolute_seconds" == 28800 \
          && "$manifest_portal_content_security_policy" == "$A_CLOUD_PORTAL_CSP" \
          && "$manifest_edge_caddy_image" == "$A_HTTPS_OIDC_TEST_IMAGE" ]] \
        || die "A HTTPS OIDC test manifest must retain its exact dual-SNI Portal identity boundary."
      [[ -f "$BUNDLE_DIR/$manifest_portal_package_archive" \
          && ! -L "$BUNDLE_DIR/$manifest_portal_package_archive" \
          && "$(sha256sum "$BUNDLE_DIR/$manifest_portal_package_archive" | awk '{print $1}')" == \
            "$manifest_portal_package_sha256" ]] \
        || die "The fixed Portal package archive does not match the release manifest."
      [[ "$(awk -F'"' '$2 == "path" { count += 1 } END { print count + 0 }' "$manifest_file")" -gt 0 ]] \
        || die "The fixed Portal asset inventory is empty."
      if grep -Eiq 'portalOidcClientSecret|SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET|client_secret' \
          "$manifest_file"; then
        die "The release manifest contains forbidden Portal secret material."
      fi
      validate_fixed_edge_asset "$A_HTTPS_OIDC_TEST_CADDYFILE" \
        "$manifest_identity_edge_caddyfile_sha256"
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/common.sh" \
        "$manifest_edge_common_script_sha256"
      validate_fixed_edge_asset "$A_HTTPS_OIDC_TEST_COMPOSE_FILE" \
        "$manifest_identity_edge_compose_sha256"
      validate_fixed_edge_asset "$A_CLOUD_PORTAL_COMPOSE_FILE" \
        "$manifest_portal_compose_sha256"
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify-portal-assets.mjs" \
        "$manifest_portal_asset_verify_script_sha256" true
      validate_fixed_edge_asset "$PRIVATE_DEPLOY_DIR/.dockerignore" \
        "$manifest_edge_dockerignore_sha256"
      validate_fixed_edge_asset "$COMPOSE_FILE" \
        "$manifest_edge_base_compose_sha256"
      validate_fixed_edge_asset "$PRIVATE_DEPLOY_DIR/Dockerfile.runtime" \
        "$manifest_edge_runtime_dockerfile_sha256"
      validate_fixed_edge_asset "$PRIVATE_DEPLOY_DIR/postgres-init/001-create-application-role.sh" \
        "$manifest_edge_postgres_init_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/deploy.sh" \
        "$manifest_edge_base_deploy_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify.sh" \
        "$manifest_edge_base_verify_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/backup.sh" \
        "$manifest_edge_backup_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify-backup-restore.sh" \
        "$manifest_edge_backup_restore_verify_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify-postgres-restart.sh" \
        "$manifest_edge_postgres_restart_verify_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify-postgres-v5-integration.sh" \
        "$manifest_edge_postgres_v5_verify_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/postgres-v5-integration.mjs" \
        "$manifest_edge_postgres_v5_integration_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/deploy-a-https-oidc-test.sh" \
        "$manifest_identity_edge_deploy_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/disable-a-https-oidc-test.sh" \
        "$manifest_identity_edge_disable_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify-a-https-oidc-test-external.sh" \
        "$manifest_identity_edge_external_verify_script_sha256" true
      validate_fixed_edge_asset "$COMMON_SCRIPT_DIR/verify-a-https-oidc-test.sh" \
        "$manifest_identity_edge_verify_script_sha256" true
      ;;
    *) die "RELEASE_MANIFEST.json contains an unsupported release mode." ;;
  esac
  (( ${#manifest_filenames[@]} == 5 )) \
    || die "RELEASE_MANIFEST.json must describe exactly five packages."
  for manifest_filename in "${manifest_filenames[@]}"; do
    [[ -n "${allowed_files[$manifest_filename]:-}" ]] \
      || die "RELEASE_MANIFEST.json references an unexpected package archive."
    [[ -z "${manifest_seen_files[$manifest_filename]:-}" ]] \
      || die "RELEASE_MANIFEST.json contains a duplicate package archive."
    manifest_seen_files["$manifest_filename"]=1
  done
  for tarball in "${tarballs[@]}"; do
    basename="$(basename "$tarball")"
    [[ -n "${manifest_seen_files[$basename]:-}" ]] \
      || die "RELEASE_MANIFEST.json does not describe every package archive."
  done
  allowed_files[package.json]=1
  allowed_files[package-lock.json]=1
  allowed_files[CONTRACT_COMMIT]=1
  allowed_files[RELEASE_MANIFEST.json]=1

  for filename in "${!allowed_files[@]}"; do
    allowed_bundle_files["$filename"]=1
  done
  allowed_bundle_files[SHA256SUMS]=1
  allowed_bundle_files[.gitignore]=1
  shopt -s nullglob dotglob
  bundle_entries=("$BUNDLE_DIR"/*)
  shopt -u nullglob dotglob
  for bundle_entry in "${bundle_entries[@]}"; do
    basename="$(basename "$bundle_entry")"
    [[ -f "$bundle_entry" && ! -L "$bundle_entry" ]] \
      || die "Release bundle may contain only regular, non-symlink files."
    [[ -n "${allowed_bundle_files[$basename]:-}" ]] \
      || die "Release bundle contains an unexpected file: $basename"
  done

  while IFS= read -r line || [[ -n "$line" ]]; do
    ((line_count += 1))
    read -r digest filename extra <<< "$line"
    filename="${filename#\*}"
    [[ "$digest" =~ ^[0-9a-f]{64}$ && -n "$filename" && -z "${extra:-}" ]] \
      || die "SHA256SUMS contains an invalid line."
    [[ -n "${allowed_files[$filename]:-}" ]] || die "SHA256SUMS references an unexpected file."
    [[ -z "${seen_files[$filename]:-}" ]] || die "SHA256SUMS contains a duplicate file entry."
    seen_files["$filename"]=1
  done < "$BUNDLE_DIR/SHA256SUMS"
  (( line_count == 9 && ${#seen_files[@]} == 9 )) || die "SHA256SUMS must cover exactly all nine release inputs."
  for filename in "${!allowed_files[@]}"; do
    [[ -n "${seen_files[$filename]:-}" ]] || die "SHA256SUMS does not cover every release input."
  done
  (cd "$BUNDLE_DIR" && sha256sum --check --strict --status SHA256SUMS) \
    || die "Release bundle checksum verification failed."
  RELEASE_MANIFEST_MODE="$manifest_release_mode"
  RELEASE_MANIFEST_HOSTNAME="$manifest_hostname"
  RELEASE_MANIFEST_DEPLOYMENT_BOUNDARY="$manifest_deployment_boundary"
  RELEASE_MANIFEST_IDENTITY_HOSTNAME="$manifest_identity_hostname"
  RELEASE_MANIFEST_OIDC_ISSUER="$manifest_oidc_issuer"
  derive_release_schema_truth
}

validate_a_https_test_edge_bundle() {
  local expected_commit="$1"

  validate_release_bundle "$expected_commit"
  [[ "$RELEASE_MANIFEST_MODE" == a-https-test-edge \
      && "$RELEASE_MANIFEST_DEPLOYMENT_BOUNDARY" == public-https-core-only \
      && "$RELEASE_MANIFEST_HOSTNAME" == "$A_HTTPS_TEST_EDGE_HOSTNAME" ]] \
    || die "The release bundle is not approved for the A HTTPS test edge."
}

validate_a_https_oidc_test_bundle() {
  local expected_commit="$1"

  validate_release_bundle "$expected_commit"
  [[ "$RELEASE_MANIFEST_MODE" == a-https-oidc-test \
      && "$RELEASE_MANIFEST_DEPLOYMENT_BOUNDARY" == public-https-oidc-test \
      && "$RELEASE_MANIFEST_HOSTNAME" == "$A_HTTPS_OIDC_TEST_HOSTNAME" \
      && "$RELEASE_MANIFEST_IDENTITY_HOSTNAME" == "$A_HTTPS_OIDC_TEST_IDENTITY_HOSTNAME" \
      && "$RELEASE_MANIFEST_OIDC_ISSUER" == "$A_HTTPS_OIDC_TEST_ISSUER" ]] \
    || die "The release bundle is not approved for the A HTTPS OIDC test."
}

derive_release_schema_truth() {
  local server_tarballs=()
  local server_tarball
  local archive_entries=()
  local archive_entry
  local migration_paths=()
  local migration_path
  local migration_filename
  local migration_version
  local expected_version
  local migration_index=1
  local entry_type
  local migration_sql
  local parsed_tables
  local table
  local tables=()
  declare -A seen_migration_paths=()
  declare -A seen_tables=()

  shopt -s nullglob
  server_tarballs=("$BUNDLE_DIR"/sciforge-collaboration-server-*.tgz)
  shopt -u nullglob
  (( ${#server_tarballs[@]} == 1 )) || die "Could not identify exactly one validated server tarball."
  server_tarball="${server_tarballs[0]}"

  mapfile -t archive_entries < <(tar -tzf "$server_tarball")
  (( ${#archive_entries[@]} > 0 )) || die "Server tarball is empty."
  for archive_entry in "${archive_entries[@]}"; do
    case "$archive_entry" in
      package/migrations|package/migrations/) ;;
      package/migrations/*)
        [[ "$archive_entry" =~ ^package/migrations/[0-9]{4}_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$ ]] \
          || die "Server tarball contains an invalid migration path."
        [[ -z "${seen_migration_paths[$archive_entry]:-}" ]] \
          || die "Server tarball contains a duplicate migration path."
        seen_migration_paths["$archive_entry"]=1
        migration_paths+=("$archive_entry")
        ;;
    esac
  done
  (( ${#migration_paths[@]} > 0 )) || die "Server tarball does not contain any migration SQL files."
  mapfile -t migration_paths < <(printf '%s\n' "${migration_paths[@]}" | LC_ALL=C sort)

  for migration_path in "${migration_paths[@]}"; do
    migration_filename="${migration_path##*/}"
    migration_version="${migration_filename%%_*}"
    printf -v expected_version '%04d' "$migration_index"
    [[ "$migration_version" == "$expected_version" ]] \
      || die "Server migration filenames must form a continuous sequence beginning at 0001."

    if ! entry_type="$(tar -tvzf "$server_tarball" "$migration_path" \
      | awk 'NR == 1 { print substr($1, 1, 1) } END { if (NR != 1) exit 1 }')"; then
      die "Could not inspect a server migration archive entry."
    fi
    [[ "$entry_type" == - ]] || die "Every server migration must be a regular archive file."
    if ! migration_sql="$(tar -xOzf "$server_tarball" "$migration_path")"; then
      die "Could not read a server migration from the validated tarball."
    fi
    [[ -n "${migration_sql//[[:space:]]/}" ]] || die "Server migration SQL must not be empty."
    [[ "$migration_sql" != *'/*'* && "$migration_sql" != *'*/'* ]] \
      || die "Server migration block comments are unsupported by the strict table parser."

    if ! parsed_tables="$(printf '%s\n' "$migration_sql" | awk '
      {
        line = $0
        sub(/\r$/, "", line)
        sub(/--.*/, "", line)
        sql = sql " " line
      }
      END {
        gsub(/[[:space:]]+/, " ", sql)
        remaining = sql
        while (match(toupper(remaining), /CREATE TABLE/)) {
          statement = substr(remaining, RSTART)
          if (statement !~ /^CREATE TABLE (IF NOT EXISTS )?sciforge_collaboration\.[a-z][a-z0-9_]*[[:space:]]*\(/) exit 42
          name = statement
          sub(/^CREATE TABLE (IF NOT EXISTS )?sciforge_collaboration\./, "", name)
          if (!match(name, /^[a-z][a-z0-9_]*/)) exit 42
          print substr(name, RSTART, RLENGTH)
          remaining = substr(statement, length("CREATE TABLE") + 1)
        }
      }
    ')"; then
      die "Server migration contains a CREATE TABLE statement that cannot be parsed safely."
    fi
    while IFS= read -r table; do
      [[ -n "$table" ]] || continue
      seen_tables["$table"]=1
    done <<< "$parsed_tables"
    (( migration_index += 1 ))
  done

  (( ${#seen_tables[@]} > 0 )) || die "Server migrations do not define any collaboration tables."
  [[ -n "${seen_tables[schema_migrations]:-}" ]] \
    || die "Server migrations do not define the required schema_migrations table."
  mapfile -t tables < <(printf '%s\n' "${!seen_tables[@]}" | LC_ALL=C sort)
  RELEASE_EXPECTED_SCHEMA_VERSION="$((migration_index - 1))"
  RELEASE_EXPECTED_TABLES="$(printf '%s\n' "${tables[@]}")"
}

expected_collaboration_schema_version() {
  [[ "$RELEASE_EXPECTED_SCHEMA_VERSION" =~ ^[1-9][0-9]*$ ]] \
    || die "Release-derived migration truth has not been initialized."
  printf '%s' "$RELEASE_EXPECTED_SCHEMA_VERSION"
}

prepare_compose_environment() {
  local expected_commit="$1"
  local env_input="$2"
  local admin_db_value
  local allowed_origins_value
  local app_db_value
  local app_cpus
  local app_memory
  local app_pids
  local compose_project_name
  local deployment_mode
  local edge_cpus
  local edge_memory
  local edge_pids
  local host_port
  local log_max_files
  local log_max_size
  local oidc_allow_insecure_loopback
  local oidc_audience
  local oidc_authorized_parties
  local oidc_issuer
  local portal_asset_dir=""
  local portal_client_id=""
  local portal_client_secret=""
  local portal_enabled=""
  local portal_public_origin=""
  local portal_redirect_uri=""
  local portal_test_worker_directory_enabled=""
  local postgres_cpus
  local postgres_memory
  local postgres_pids

  validate_commit "$expected_commit"
  ENV_FILE="$(canonical_regular_file "$env_input")"
  validate_private_env_file "$ENV_FILE"
  admin_db_value="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLAB_DB_ADMIN_PASSWORD)"
  [[ "$admin_db_value" =~ ^[0-9A-Fa-f]{64}$ ]] \
    || die "SCIFORGE_COLLAB_DB_ADMIN_PASSWORD must be exactly 64 hexadecimal characters."
  app_db_value="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLAB_DB_PASSWORD)"
  [[ "$app_db_value" =~ ^[0-9A-Fa-f]{64}$ ]] \
    || die "SCIFORGE_COLLAB_DB_PASSWORD must be exactly 64 hexadecimal characters."
  [[ "$admin_db_value" != "$app_db_value" ]] \
    || die "Database admin and application passwords must be different."
  host_port="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLAB_HOST_PORT optional)"
  host_port="${host_port:-8787}"
  [[ "$host_port" =~ ^[0-9]+$ ]] || die "SCIFORGE_COLLAB_HOST_PORT must be an integer."
  (( host_port >= 1024 && host_port <= 65535 )) || die "SCIFORGE_COLLAB_HOST_PORT must be between 1024 and 65535."
  allowed_origins_value="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLABORATION_ALLOWED_ORIGINS optional)"
  compose_project_name="$(dotenv_value "$ENV_FILE" COMPOSE_PROJECT_NAME optional)"
  [[ -z "$compose_project_name" ]] \
    || die "COMPOSE_PROJECT_NAME is forbidden; deployment project names are fixed by the scripts."
  oidc_issuer="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLABORATION_OIDC_ISSUER optional)"
  oidc_audience="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLABORATION_OIDC_AUDIENCE optional)"
  oidc_audience="${oidc_audience:-sciforge-cloud-api}"
  oidc_authorized_parties="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLABORATION_OIDC_AUTHORIZED_PARTIES optional)"
  oidc_authorized_parties="${oidc_authorized_parties:-sciforge-desktop,sciforge-web-mobile}"
  oidc_allow_insecure_loopback="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK optional)"
  oidc_allow_insecure_loopback="${oidc_allow_insecure_loopback:-false}"
  deployment_mode=core-only-private
  if [[ "$RELEASE_MANIFEST_MODE" == a-https-oidc-test ]]; then
    deployment_mode=oidc-test-private
    [[ -f "$A_CLOUD_PORTAL_COMPOSE_FILE" && ! -L "$A_CLOUD_PORTAL_COMPOSE_FILE" ]] \
      || die "The fixed A Cloud Portal Compose overlay is missing or unsafe."
    portal_enabled="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLABORATION_PORTAL_ENABLED true)"
    portal_asset_dir="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLABORATION_PORTAL_ASSET_DIR \
      "$A_CLOUD_PORTAL_ASSET_DIR")"
    portal_public_origin="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLABORATION_PORTAL_PUBLIC_ORIGIN \
      "$A_HTTPS_OIDC_TEST_ORIGIN")"
    portal_client_id="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_ID \
      "$A_CLOUD_PORTAL_CLIENT_ID")"
    portal_redirect_uri="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLABORATION_PORTAL_OIDC_REDIRECT_URI \
      "$A_CLOUD_PORTAL_REDIRECT_URI")"
    portal_test_worker_directory_enabled="$(fixed_compose_value "$ENV_FILE" \
      SCIFORGE_COLLABORATION_PORTAL_TEST_WORKER_DIRECTORY_ENABLED true)"
    printf -v portal_client_secret '%s' \
      "$(dotenv_value "$ENV_FILE" SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET)"
    [[ ${#portal_client_secret} -ge 32 && ${#portal_client_secret} -le 512 \
        && "$portal_client_secret" != *[[:space:]]* \
        && "$portal_client_secret" != replace_* ]] \
      || die "SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET must be a non-placeholder Keycloak secret of 32-512 non-whitespace characters."
  fi
  postgres_cpus="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_POSTGRES_CPUS 1.5)"
  postgres_memory="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_POSTGRES_MEMORY 2g)"
  postgres_pids="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_POSTGRES_PIDS 256)"
  app_cpus="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_APP_CPUS 1.0)"
  app_memory="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_APP_MEMORY 768m)"
  app_pids="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_APP_PIDS 256)"
  edge_cpus="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_EDGE_CPUS 0.5)"
  edge_memory="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_EDGE_MEMORY 256m)"
  edge_pids="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_EDGE_PIDS 128)"
  log_max_size="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_LOG_MAX_SIZE 10m)"
  log_max_files="$(fixed_compose_value "$ENV_FILE" SCIFORGE_COLLAB_LOG_MAX_FILES 5)"

  # Export the validated values so shell variables cannot override the selected
  # env file or the approved bundle revision during Compose interpolation.
  printf -v SCIFORGE_COLLAB_DB_ADMIN_PASSWORD '%s' "$admin_db_value"
  printf -v SCIFORGE_COLLAB_DB_PASSWORD '%s' "$app_db_value"
  export SCIFORGE_COLLAB_DB_ADMIN_PASSWORD
  export SCIFORGE_COLLAB_DB_PASSWORD
  export SCIFORGE_COLLAB_HOST_PORT="$host_port"
  export SCIFORGE_COLLAB_CONTRACT_COMMIT="$expected_commit"
  export SCIFORGE_COLLABORATION_ALLOWED_ORIGINS="$allowed_origins_value"
  export SCIFORGE_COLLABORATION_OIDC_ISSUER="$oidc_issuer"
  export SCIFORGE_COLLABORATION_OIDC_AUDIENCE="$oidc_audience"
  export SCIFORGE_COLLABORATION_OIDC_AUTHORIZED_PARTIES="$oidc_authorized_parties"
  export SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK="$oidc_allow_insecure_loopback"
  if [[ "$RELEASE_MANIFEST_MODE" == a-https-oidc-test ]]; then
    export SCIFORGE_COLLABORATION_PORTAL_ENABLED="$portal_enabled"
    export SCIFORGE_COLLABORATION_PORTAL_ASSET_DIR="$portal_asset_dir"
    export SCIFORGE_COLLABORATION_PORTAL_PUBLIC_ORIGIN="$portal_public_origin"
    export SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_ID="$portal_client_id"
    printf -v SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET '%s' "$portal_client_secret"
    export SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET
    export SCIFORGE_COLLABORATION_PORTAL_OIDC_REDIRECT_URI="$portal_redirect_uri"
    export SCIFORGE_COLLABORATION_PORTAL_TEST_WORKER_DIRECTORY_ENABLED="$portal_test_worker_directory_enabled"
  fi
  export SCIFORGE_COLLAB_DEPLOYMENT_MODE="$deployment_mode"
  export SCIFORGE_COLLAB_POSTGRES_CPUS="$postgres_cpus"
  export SCIFORGE_COLLAB_POSTGRES_MEMORY="$postgres_memory"
  export SCIFORGE_COLLAB_POSTGRES_PIDS="$postgres_pids"
  export SCIFORGE_COLLAB_APP_CPUS="$app_cpus"
  export SCIFORGE_COLLAB_APP_MEMORY="$app_memory"
  export SCIFORGE_COLLAB_APP_PIDS="$app_pids"
  export SCIFORGE_COLLAB_EDGE_CPUS="$edge_cpus"
  export SCIFORGE_COLLAB_EDGE_MEMORY="$edge_memory"
  export SCIFORGE_COLLAB_EDGE_PIDS="$edge_pids"
  export SCIFORGE_COLLAB_LOG_MAX_SIZE="$log_max_size"
  export SCIFORGE_COLLAB_LOG_MAX_FILES="$log_max_files"
  COMPOSE=(docker compose --project-name sciforge-collaboration-private \
    --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  if [[ "$RELEASE_MANIFEST_MODE" == a-https-oidc-test ]]; then
    COMPOSE+=(-f "$A_CLOUD_PORTAL_COMPOSE_FILE")
  fi
}

prepare_a_https_test_edge_environment() {
  local expected_commit="$1"
  local env_input="$2"
  local configured_ipv4
  local configured_state_dir

  prepare_compose_environment "$expected_commit" "$env_input"
  [[ "$SCIFORGE_COLLAB_HOST_PORT" == 8787 ]] \
    || die "The A HTTPS test edge requires the app to remain on 127.0.0.1:8787."
  [[ "$SCIFORGE_COLLABORATION_ALLOWED_ORIGINS" == "$A_HTTPS_TEST_EDGE_ORIGIN" ]] \
    || die "The A HTTPS test edge requires the one exact cloud-test HTTPS origin."
  [[ -z "$SCIFORGE_COLLABORATION_OIDC_ISSUER" ]] \
    || die "The A HTTPS test edge must not configure an OIDC issuer."
  [[ "$SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK" == false ]] \
    || die "The A HTTPS test edge must keep insecure loopback OIDC disabled."
  configured_ipv4="$(dotenv_value "$ENV_FILE" SCIFORGE_A_HTTPS_TEST_EDGE_IPV4)"
  [[ "$configured_ipv4" == "$A_HTTPS_TEST_EDGE_PUBLIC_IPV4" ]] \
    || die "The A HTTPS test edge IPv4 must match the approved ECS address."
  configured_state_dir="$(dotenv_value "$ENV_FILE" SCIFORGE_A_HTTPS_TEST_EDGE_STATE_DIR)"
  [[ "$configured_state_dir" == "$A_HTTPS_TEST_EDGE_STATE_DIR" ]] \
    || die "The A HTTPS test edge state path must remain outside the fixed release directory."
  [[ -f "$A_HTTPS_TEST_EDGE_COMPOSE_FILE" && ! -L "$A_HTTPS_TEST_EDGE_COMPOSE_FILE" ]] \
    || die "The A HTTPS test edge Compose file is missing or unsafe."
  [[ -f "$A_HTTPS_TEST_EDGE_CADDYFILE" && ! -L "$A_HTTPS_TEST_EDGE_CADDYFILE" ]] \
    || die "The A HTTPS test edge Caddyfile is missing or unsafe."

  export SCIFORGE_A_HTTPS_TEST_EDGE_COMMIT="$expected_commit"
  export SCIFORGE_A_HTTPS_TEST_EDGE_HOSTNAME="$A_HTTPS_TEST_EDGE_HOSTNAME"
  export SCIFORGE_A_HTTPS_TEST_EDGE_IMAGE="$A_HTTPS_TEST_EDGE_IMAGE"
  export SCIFORGE_A_HTTPS_TEST_EDGE_NETWORK="$A_HTTPS_TEST_EDGE_NETWORK"
  export SCIFORGE_A_HTTPS_TEST_EDGE_STATE_DIR="$A_HTTPS_TEST_EDGE_STATE_DIR"
  EDGE_COMPOSE=(docker compose --project-name sciforge-collaboration-a-https-test-edge \
    --env-file "$ENV_FILE" -f "$A_HTTPS_TEST_EDGE_COMPOSE_FILE")
}

prepare_a_https_oidc_test_environment() {
  local expected_commit="$1"
  local env_input="$2"
  local configured_ipv4
  local configured_state_dir

  prepare_compose_environment "$expected_commit" "$env_input"
  [[ "$RELEASE_MANIFEST_MODE" == a-https-oidc-test ]] \
    || die "Only the explicit A HTTPS OIDC test release may configure the test issuer."
  [[ "$SCIFORGE_COLLAB_HOST_PORT" == 8787 ]] \
    || die "The A HTTPS OIDC test requires the app to remain on 127.0.0.1:8787."
  [[ "$SCIFORGE_COLLABORATION_ALLOWED_ORIGINS" == "$A_HTTPS_OIDC_TEST_ORIGIN" ]] \
    || die "The A HTTPS OIDC test requires the one exact cloud-test HTTPS origin."
  [[ "$SCIFORGE_COLLABORATION_OIDC_ISSUER" == "$A_HTTPS_OIDC_TEST_ISSUER" \
      && "$SCIFORGE_COLLABORATION_OIDC_AUDIENCE" == "$A_HTTPS_OIDC_TEST_AUDIENCE" \
      && "$SCIFORGE_COLLABORATION_OIDC_AUTHORIZED_PARTIES" == "$A_HTTPS_OIDC_TEST_AUTHORIZED_PARTIES" \
      && "$SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK" == false ]] \
    || die "The A HTTPS OIDC test requires its exact issuer, audience, authorized parties, and secure transport."
  [[ "$SCIFORGE_COLLAB_DEPLOYMENT_MODE" == oidc-test-private ]] \
    || die "The A HTTPS OIDC test app mode is invalid."
  configured_ipv4="$(dotenv_value "$ENV_FILE" SCIFORGE_A_HTTPS_OIDC_TEST_IPV4)"
  [[ "$configured_ipv4" == "$A_HTTPS_OIDC_TEST_PUBLIC_IPV4" ]] \
    || die "The A HTTPS OIDC test IPv4 must match the approved ECS address."
  configured_state_dir="$(dotenv_value "$ENV_FILE" SCIFORGE_A_HTTPS_OIDC_TEST_STATE_DIR)"
  [[ "$configured_state_dir" == "$A_HTTPS_OIDC_TEST_STATE_DIR" ]] \
    || die "The A HTTPS OIDC test state path must remain outside the fixed release directory."
  [[ -f "$A_HTTPS_OIDC_TEST_COMPOSE_FILE" && ! -L "$A_HTTPS_OIDC_TEST_COMPOSE_FILE" ]] \
    || die "The A HTTPS OIDC test Compose file is missing or unsafe."
  [[ -f "$A_HTTPS_OIDC_TEST_CADDYFILE" && ! -L "$A_HTTPS_OIDC_TEST_CADDYFILE" ]] \
    || die "The A HTTPS OIDC test Caddyfile is missing or unsafe."

  export SCIFORGE_A_HTTPS_OIDC_TEST_COMMIT="$expected_commit"
  export SCIFORGE_A_HTTPS_OIDC_TEST_STATE_DIR="$A_HTTPS_OIDC_TEST_STATE_DIR"
  OIDC_EDGE_COMPOSE=(docker compose --project-name sciforge-collaboration-a-https-oidc-test \
    --env-file "$ENV_FILE" -f "$A_HTTPS_OIDC_TEST_COMPOSE_FILE")
}

validate_a_https_test_edge_host() {
  local resolved_ipv4=()
  local database_network_properties
  local network_internal
  local network_properties

  require_root
  if getent passwd 10002 >/dev/null; then
    die "Host UID 10002 must remain unassigned for the isolated edge runtime."
  fi
  if getent group 10002 >/dev/null; then
    die "Host GID 10002 must remain unassigned for the isolated edge runtime."
  fi
  mapfile -t resolved_ipv4 < <(
    getent ahostsv4 "$A_HTTPS_TEST_EDGE_HOSTNAME" | awk 'NF { print $1 }' | LC_ALL=C sort -u
  )
  (( ${#resolved_ipv4[@]} == 1 )) \
    || die "The A HTTPS test hostname must resolve to exactly one IPv4 address."
  [[ "${resolved_ipv4[0]}" == "$A_HTTPS_TEST_EDGE_PUBLIC_IPV4" ]] \
    || die "The A HTTPS test hostname does not resolve to the approved ECS address."
  network_internal="$(docker network inspect --format '{{.Internal}}' "$A_HTTPS_TEST_EDGE_NETWORK")" \
    || die "The approved application edge network does not exist."
  [[ "$network_internal" == false ]] \
    || die "The application edge network must support the dedicated ingress container."
  network_properties="$(docker network inspect --format \
    '{{.Driver}}|{{.Scope}}|{{index .Labels "com.docker.compose.project"}}' \
    "$A_HTTPS_TEST_EDGE_NETWORK")"
  [[ "$network_properties" == bridge\|local\|sciforge-collaboration-private ]] \
    || die "The private edge network is not the fixed local collaboration bridge."
  database_network_properties="$(docker network inspect --format \
    '{{.Internal}}|{{.Driver}}|{{.Scope}}|{{index .Labels "com.docker.compose.project"}}' \
    "$A_HTTPS_TEST_EDGE_DATABASE_NETWORK")"
  [[ "$database_network_properties" == true\|bridge\|local\|sciforge-collaboration-private ]] \
    || die "The database network is not the fixed internal collaboration bridge."
  validate_a_https_test_edge_state_dirs
}

validate_a_https_test_edge_state_dirs() {
  local path

  [[ "$(readlink -f /srv/sciforge-collaboration)" == /srv/sciforge-collaboration ]] \
    || die "The collaboration service root must be a physical directory."
  for path in "$A_HTTPS_TEST_EDGE_STATE_DIR" \
      "$A_HTTPS_TEST_EDGE_STATE_DIR/data" "$A_HTTPS_TEST_EDGE_STATE_DIR/config" \
      "$A_HTTPS_TEST_EDGE_STATE_DIR/approval"; do
    [[ -d "$path" && ! -L "$path" ]] \
      || die "The persistent edge state directory is missing or is a symlink: $path"
  done
  [[ "$(readlink -f "$A_HTTPS_TEST_EDGE_STATE_DIR")" == "$A_HTTPS_TEST_EDGE_STATE_DIR" \
      && "$(readlink -f "$A_HTTPS_TEST_EDGE_STATE_DIR/data")" == "$A_HTTPS_TEST_EDGE_STATE_DIR/data" \
      && "$(readlink -f "$A_HTTPS_TEST_EDGE_STATE_DIR/config")" == "$A_HTTPS_TEST_EDGE_STATE_DIR/config" \
      && "$(readlink -f "$A_HTTPS_TEST_EDGE_STATE_DIR/approval")" == "$A_HTTPS_TEST_EDGE_STATE_DIR/approval" ]] \
    || die "The persistent edge state escaped its fixed physical path."
  [[ "$(stat -c '%u:%g:%a' "$A_HTTPS_TEST_EDGE_STATE_DIR")" == 0:0:750 \
      && "$(stat -c '%u:%g:%a' "$A_HTTPS_TEST_EDGE_STATE_DIR/data")" == 10002:10002:700 \
      && "$(stat -c '%u:%g:%a' "$A_HTTPS_TEST_EDGE_STATE_DIR/config")" == 10002:10002:700 \
      && "$(stat -c '%u:%g:%a' "$A_HTTPS_TEST_EDGE_STATE_DIR/approval")" == 0:10002:750 ]] \
    || die "The persistent edge state directories have unsafe ownership or permissions."
}

prepare_a_https_test_edge_state_dirs() {
  local path

  if getent passwd 10002 >/dev/null; then
    die "Host UID 10002 must remain unassigned before preparing isolated edge state."
  fi
  if getent group 10002 >/dev/null; then
    die "Host GID 10002 must remain unassigned before preparing isolated edge state."
  fi
  [[ "$(readlink -f /srv/sciforge-collaboration)" == /srv/sciforge-collaboration ]] \
    || die "The collaboration service root must be a physical directory."
  for path in "$A_HTTPS_TEST_EDGE_STATE_DIR" \
      "$A_HTTPS_TEST_EDGE_STATE_DIR/data" "$A_HTTPS_TEST_EDGE_STATE_DIR/config" \
      "$A_HTTPS_TEST_EDGE_STATE_DIR/approval"; do
    [[ ! -L "$path" ]] || die "Refusing a symlinked persistent edge state path: $path"
  done
  install -d -o root -g root -m 0750 "$A_HTTPS_TEST_EDGE_STATE_DIR"
  install -d -o 10002 -g 10002 -m 0700 \
    "$A_HTTPS_TEST_EDGE_STATE_DIR/data" "$A_HTTPS_TEST_EDGE_STATE_DIR/config"
  install -d -o root -g 10002 -m 0750 "$A_HTTPS_TEST_EDGE_STATE_DIR/approval"
  validate_a_https_test_edge_state_dirs
}

assert_no_a_https_test_edge_container() {
  local all_container_ids=()
  local app_ids=()
  local endpoint_ids=()
  local edge_ids=()
  local oidc_edge_ids=()
  local expected_endpoint=""
  local id
  local port_bindings

  mapfile -t edge_ids < <(docker container ls -a --no-trunc -q \
    --filter "label=com.docker.compose.project=$A_HTTPS_TEST_EDGE_PROJECT")
  (( ${#edge_ids[@]} == 0 )) \
    || die "An HTTPS edge container still exists. Disable and remove the exact edge before changing the app or Provider mode."
  mapfile -t oidc_edge_ids < <(docker container ls -a --no-trunc -q \
    --filter "label=com.docker.compose.project=$A_HTTPS_OIDC_TEST_PROJECT")
  (( ${#oidc_edge_ids[@]} == 0 )) \
    || die "An HTTPS OIDC edge container still exists. Disable and remove the exact edge before changing the app or Provider mode."
  [[ "$(ss -H -ltn | awk '$4 ~ /:443$/ { count += 1 } END { print count + 0 }')" == 0 \
      && "$(ss -H -lun | awk '$4 ~ /:443$/ { count += 1 } END { print count + 0 }')" == 0 ]] \
    || die "A host TCP/UDP 443 listener exists; the app cannot be changed behind an active public edge."
  mapfile -t all_container_ids < <(docker container ls -a --no-trunc -q)
  for id in "${all_container_ids[@]}"; do
    port_bindings="$(docker container inspect --format '{{json .HostConfig.PortBindings}}' "$id")"
    [[ "$port_bindings" != *'"HostPort":"443"'* ]] \
      || die "A Docker container still publishes host port 443; disable the public edge before changing the app."
  done
  mapfile -t app_ids < <(docker container ls --no-trunc -q \
    --filter label=com.docker.compose.project=sciforge-collaboration-private \
    --filter label=com.docker.compose.service=app)
  (( ${#app_ids[@]} <= 1 )) || die "The collaboration project has multiple app containers."
  if (( ${#app_ids[@]} == 1 )); then
    expected_endpoint="${app_ids[0]}"
  fi
  if docker network inspect "$A_HTTPS_TEST_EDGE_NETWORK" >/dev/null 2>&1; then
    mapfile -t endpoint_ids < <(docker network inspect --format \
      '{{range $id, $_ := .Containers}}{{println $id}}{{end}}' \
      "$A_HTTPS_TEST_EDGE_NETWORK" | awk 'NF { print }')
    if [[ -n "$expected_endpoint" ]]; then
      (( ${#endpoint_ids[@]} == 1 )) && [[ "${endpoint_ids[0]}" == "$expected_endpoint" ]] \
        || die "The private edge network contains an endpoint other than the current collaboration app."
    else
      (( ${#endpoint_ids[@]} == 0 )) \
        || die "The private edge network contains an endpoint without a current collaboration app."
    fi
  fi
}

assert_a_https_test_edge_network_membership() {
  local expected_edge_id="${1:-}"
  local endpoint_ids=()
  local app_networks=()
  local expected_endpoints=()
  local app_aliases
  local edge_aliases=""

  [[ "$A_HTTPS_TEST_EDGE_APP_CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]] \
    || die "The approved app identity is unavailable for edge network validation."
  mapfile -t app_networks < <(docker container inspect --format \
    '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
    "$A_HTTPS_TEST_EDGE_APP_CONTAINER_ID" | awk 'NF { print }' | LC_ALL=C sort)
  [[ "$(printf '%s\n' "${app_networks[@]}")" == \
      "$(printf '%s\n' "$A_HTTPS_TEST_EDGE_DATABASE_NETWORK" "$A_HTTPS_TEST_EDGE_NETWORK" | LC_ALL=C sort)" ]] \
    || die "The collaboration app must join exactly the database and private-edge networks."

  mapfile -t endpoint_ids < <(docker network inspect --format \
    '{{range $id, $_ := .Containers}}{{println $id}}{{end}}' \
    "$A_HTTPS_TEST_EDGE_NETWORK" | awk 'NF { print }' | LC_ALL=C sort)
  expected_endpoints=("$A_HTTPS_TEST_EDGE_APP_CONTAINER_ID")
  if [[ -n "$expected_edge_id" ]]; then
    [[ "$expected_edge_id" =~ ^[0-9a-f]{64}$ ]] || die "The edge identity is invalid."
    expected_endpoints+=("$expected_edge_id")
  fi
  [[ "$(printf '%s\n' "${endpoint_ids[@]}")" == \
      "$(printf '%s\n' "${expected_endpoints[@]}" | LC_ALL=C sort)" ]] \
    || die "The private edge network contains an unapproved endpoint."

  app_aliases="$(docker container inspect --format \
    "{{range (index .NetworkSettings.Networks \"$A_HTTPS_TEST_EDGE_NETWORK\").Aliases}}{{println .}}{{end}}" \
    "$A_HTTPS_TEST_EDGE_APP_CONTAINER_ID")"
  [[ "$(grep -Fxc app <<< "$app_aliases")" == 1 ]] \
    || die "Exactly the approved app must own the private-edge 'app' alias."
  if [[ -n "$expected_edge_id" ]]; then
    edge_aliases="$(docker container inspect --format \
      "{{range (index .NetworkSettings.Networks \"$A_HTTPS_TEST_EDGE_NETWORK\").Aliases}}{{println .}}{{end}}" \
      "$expected_edge_id")"
    ! grep -Fxq app <<< "$edge_aliases" \
      || die "The edge container must not own the upstream 'app' alias."
  fi
}

inspect_a_https_test_edge_image() {
  local mode="${1:-pull}"
  local image_id
  local image_platform
  local repo_digests
  local caddy_version

  [[ "$mode" == pull || "$mode" == local ]] || die "Unknown edge image inspection mode."
  if [[ "$mode" == pull ]]; then
    docker pull --platform linux/amd64 "$A_HTTPS_TEST_EDGE_IMAGE" >/dev/null
  fi
  image_id="$(docker image inspect --format '{{.Id}}' "$A_HTTPS_TEST_EDGE_IMAGE")" \
    || die "The fixed Caddy image is unavailable."
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "The fixed Caddy image has an invalid image ID."
  image_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image_id")"
  [[ "$image_platform" == linux/amd64 ]] \
    || die "The fixed Caddy image must be linux/amd64."
  repo_digests="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id")"
  grep -Fxq "caddy@$A_HTTPS_TEST_EDGE_IMAGE_DIGEST" <<< "$repo_digests" \
    || die "The local Caddy image does not retain the approved registry digest."
  caddy_version="$(docker run --rm --network none --entrypoint caddy "$image_id" version)"
  [[ "$caddy_version" == v2.11.4* ]] || die "The fixed edge binary is not Caddy v2.11.4."
  A_HTTPS_TEST_EDGE_IMAGE_ID="$image_id"
}

a_https_test_edge_app_snapshot() {
  local container_id="${1:-$A_HTTPS_TEST_EDGE_APP_CONTAINER_ID}"
  local image_id
  local pid
  local restarts
  local started_at

  [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || die "Cannot snapshot an unknown app container."
  image_id="$(docker container inspect --format '{{.Image}}' "$container_id")"
  pid="$(docker container inspect --format '{{.State.Pid}}' "$container_id")"
  restarts="$(docker container inspect --format '{{.RestartCount}}' "$container_id")"
  started_at="$(docker container inspect --format '{{.State.StartedAt}}' "$container_id")"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ && "$pid" =~ ^[1-9][0-9]*$ \
      && "$restarts" =~ ^[0-9]+$ && "$started_at" == *T*Z ]] \
    || die "The app container snapshot is invalid."
  printf '%s|%s|%s|%s|%s' "$container_id" "$image_id" "$pid" "$restarts" "$started_at"
}

assert_a_https_test_edge_backend_port_boundaries() {
  local all_container_ids=()
  local bindings
  local container_id
  local host_ip
  local host_port
  local published_port
  local tcp_listeners

  tcp_listeners="$(ss -H -ltn)"
  [[ "$(awk '$4 ~ /:80$/ || $4 ~ /:5432$/ { count += 1 } END { print count + 0 }' \
      <<< "$tcp_listeners")" == 0 ]] \
    || die "HTTP or PostgreSQL must not have a host TCP listener."
  [[ "$(awk '$4 ~ /:8080$/ && $4 != "127.0.0.1:8080" && $4 != "[::1]:8080" { count += 1 } END { print count + 0 }' \
      <<< "$tcp_listeners")" == 0 ]] \
    || die "The Keycloak test port must not listen outside host loopback."
  [[ "$(awk '$4 ~ /:8787$/ && $4 != "127.0.0.1:8787" && $4 != "[::1]:8787" { count += 1 } END { print count + 0 }' \
      <<< "$tcp_listeners")" == 0 ]] \
    || die "The collaboration backend port must not listen outside host loopback."

  mapfile -t all_container_ids < <(docker container ls -a --no-trunc -q)
  for container_id in "${all_container_ids[@]}"; do
    bindings="$(docker container inspect --format \
      '{{range $port, $items := .HostConfig.PortBindings}}{{range $items}}{{printf "%s|%s|%s\n" $port .HostIp .HostPort}}{{end}}{{end}}' \
      "$container_id")"
    while IFS='|' read -r published_port host_ip host_port; do
      [[ -n "$host_port" ]] || continue
      case "$host_port" in
        80|5432)
          die "A Docker container publishes forbidden host TCP port $host_port."
          ;;
        8080|8787)
          [[ "$host_ip" == 127.0.0.1 ]] \
            || die "Docker host port $host_port must be bound only to 127.0.0.1."
          ;;
      esac
    done <<< "$bindings"
  done
}

validate_a_https_test_edge_core_app() {
  local expected_commit="$1"
  local app_container_id
  local app_environment
  local app_image_id
  local app_mode
  local app_networks
  local app_revision
  local app_state
  local catalog_body
  local container_revision
  local origin_count
  local origin_value
  local oidc_count
  local oidc_value
  local postgres_endpoint
  local provider_env_count
  local provider_mount_count
  local published_endpoint
  local running_services

  running_services="$("${COMPOSE[@]}" ps --status running --services)"
  grep -qx postgres <<< "$running_services" || die "PostgreSQL is not running."
  grep -qx app <<< "$running_services" || die "The collaboration app is not running."
  app_container_id="$("${COMPOSE[@]}" ps -q app)"
  [[ "$app_container_id" =~ ^[0-9a-f]{64}$ ]] || die "Could not identify the collaboration app."
  app_state="$(docker container inspect --format \
    '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$app_container_id")"
  [[ "$app_state" == running\|healthy ]] || die "The collaboration app is not healthy."
  app_revision="$(docker container inspect --format \
    '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$app_container_id")"
  [[ "$app_revision" == "$expected_commit" ]] || die "The running app revision is not approved."
  app_mode="$(docker container inspect --format \
    '{{index .Config.Labels "cn.sciforge.deployment.mode"}}' "$app_container_id")"
  [[ "$app_mode" == core-only-private ]] || die "The public test edge requires core-only mode."
  [[ "$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' \
    "$app_container_id")" == sciforge-collaboration-private ]] \
    || die "The collaboration app belongs to an unexpected Compose project."
  app_image_id="$(docker container inspect --format '{{.Image}}' "$app_container_id")"
  [[ "$app_image_id" == "$(docker image inspect --format '{{.Id}}' \
    "sciforge-collaboration-runtime:$expected_commit")" ]] \
    || die "The running app does not use the approved image ID."
  container_revision="$(docker exec "$app_container_id" sh -c \
    'tr -d "\r\n" < /app/CONTRACT_COMMIT')"
  [[ "$container_revision" == "$expected_commit" ]] \
    || die "The app container commit proof is invalid."
  published_endpoint="$("${COMPOSE[@]}" port app 8787)"
  [[ "$published_endpoint" == 127.0.0.1:8787 ]] \
    || die "The app must remain published only on 127.0.0.1:8787."
  postgres_endpoint="$("${COMPOSE[@]}" port postgres 5432 2>/dev/null || true)"
  [[ -z "$postgres_endpoint" ]] || die "PostgreSQL must not publish a host port."
  assert_a_https_test_edge_backend_port_boundaries

  app_environment="$(docker container inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
    "$app_container_id")"
  origin_count="$(printf '%s\n' "$app_environment" | awk -F= \
    '$1 == "SCIFORGE_COLLABORATION_ALLOWED_ORIGINS" { count += 1 } END { print count + 0 }')"
  origin_value="$(printf '%s\n' "$app_environment" | awk -F= \
    '$1 == "SCIFORGE_COLLABORATION_ALLOWED_ORIGINS" { print substr($0, index($0, "=") + 1) }')"
  [[ "$origin_count" == 1 && "$origin_value" == "$A_HTTPS_TEST_EDGE_ORIGIN" ]] \
    || die "The app does not have the exact cloud-test origin allowlist."
  oidc_count="$(printf '%s\n' "$app_environment" | awk -F= \
    '$1 == "SCIFORGE_COLLABORATION_OIDC_ISSUER" { count += 1 } END { print count + 0 }')"
  oidc_value="$(printf '%s\n' "$app_environment" | awk -F= \
    '$1 == "SCIFORGE_COLLABORATION_OIDC_ISSUER" { print substr($0, index($0, "=") + 1) }')"
  [[ "$oidc_count" == 1 && -z "$oidc_value" ]] \
    || die "The A HTTPS test edge must not expose a configured OIDC issuer."
  provider_env_count="$(printf '%s\n' "$app_environment" | awk -F= '
    $1 == "SCIFORGE_COLLABORATION_PROVIDER_CONFIG_FILE" ||
    $1 == "SCIFORGE_COLLABORATION_SECRET_DIRECTORY" { count += 1 }
    END { print count + 0 }
  ')"
  [[ "$provider_env_count" == 0 ]] || die "Provider environment is forbidden on this core-only edge."
  provider_mount_count="$(docker container inspect --format \
    '{{range .Mounts}}{{println .Destination}}{{end}}' "$app_container_id" | awk '
      $0 == "/run/sciforge-provider" || index($0, "/run/sciforge-provider/") == 1 { count += 1 }
      END { print count + 0 }
    ')"
  [[ "$provider_mount_count" == 0 ]] || die "Provider mounts are forbidden on this core-only edge."
  app_networks="$(docker container inspect --format \
    '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$app_container_id")"
  grep -Fxq "$A_HTTPS_TEST_EDGE_NETWORK" <<< "$app_networks" \
    || die "The app is not attached to the approved private edge network."

  catalog_body="$(curl --disable --noproxy '*' --proto '=http' \
    --fail --silent --show-error --max-time 5 \
    --header 'content-type: application/json' \
    --data '{"protocolVersion":"1.0","requestId":"req_ahttpsedgecatalog0001","type":"endpoint.catalog.get"}' \
    http://127.0.0.1:8787/v1/commands)"
  printf '%s' "$catalog_body" | docker exec -i "$app_container_id" node -e '
    let input = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => { input += chunk })
    process.stdin.on("end", () => {
      try {
        const body = JSON.parse(input)
        if (body?.type !== "endpoint.catalog" || !Array.isArray(body.providers) || body.providers.length !== 0) process.exit(1)
      } catch { process.exit(1) }
    })
  ' || die "The core-only provider catalog is not exactly empty."
  A_HTTPS_TEST_EDGE_APP_CONTAINER_ID="$app_container_id"
}

enable_zulip_provider_compose() {
  local config_input
  local secret_input
  local config_file
  local secret_directory
  local permissions
  local owner_id
  local group_id
  local secret_entries=()
  local secret_file
  local secret_name
  local secret_size

  [[ -n "${ENV_FILE:-}" ]] || die "Provider overlay requires a prepared Compose environment."
  validate_provider_secret_group_isolation
  [[ -f "$PROVIDER_COMPOSE_FILE" && ! -L "$PROVIDER_COMPOSE_FILE" ]] \
    || die "Zulip provider Compose overlay is missing."
  config_input="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLAB_PROVIDER_CONFIG_FILE)"
  secret_input="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLAB_PROVIDER_SECRET_DIR)"
  config_file="$(canonical_regular_file "$config_input")"
  secret_directory="$(canonical_directory "$secret_input")"
  [[ "$config_file" == /srv/sciforge-collaboration/provider/providers.json ]] \
    || die "Provider config must resolve to /srv/sciforge-collaboration/provider/providers.json."
  [[ "$secret_directory" == /srv/sciforge-collaboration/provider/secrets ]] \
    || die "Provider secrets must resolve to /srv/sciforge-collaboration/provider/secrets."

  permissions="$(stat -c '%a' "$config_file")"
  owner_id="$(stat -c '%u' "$config_file")"
  group_id="$(stat -c '%g' "$config_file")"
  [[ "$permissions" == 640 && "$owner_id" == 0 && "$group_id" == 10001 ]] \
    || die "Provider config must be root:10001 mode 0640."
  permissions="$(stat -c '%a' "$secret_directory")"
  owner_id="$(stat -c '%u' "$secret_directory")"
  group_id="$(stat -c '%g' "$secret_directory")"
  [[ "$permissions" == 750 && "$owner_id" == 0 && "$group_id" == 10001 ]] \
    || die "Provider secret directory must be root:10001 mode 0750."

  shopt -s nullglob dotglob
  secret_entries=("$secret_directory"/*)
  shopt -u nullglob dotglob
  (( ${#secret_entries[@]} > 0 )) || die "Provider secret directory must contain at least one secret file."
  for secret_file in "${secret_entries[@]}"; do
    [[ -f "$secret_file" && ! -L "$secret_file" ]] \
      || die "Provider secret directory may contain only regular, non-symlink files."
    secret_name="$(basename "$secret_file")"
    [[ "$secret_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
      || die "Provider secret filename is outside the runtime reference contract."
    permissions="$(stat -c '%a' "$secret_file")"
    owner_id="$(stat -c '%u' "$secret_file")"
    group_id="$(stat -c '%g' "$secret_file")"
    [[ "$permissions" == 640 && "$owner_id" == 0 && "$group_id" == 10001 ]] \
      || die "Every provider secret must be root:10001 mode 0640."
    secret_size="$(stat -c '%s' "$secret_file")"
    [[ "$secret_size" =~ ^[0-9]+$ ]] || die "Could not inspect provider secret size."
    (( secret_size > 0 && secret_size <= 65536 )) \
      || die "Every provider secret must be non-empty and no larger than 64 KiB."
  done

  export SCIFORGE_COLLAB_PROVIDER_CONFIG_FILE="$config_file"
  export SCIFORGE_COLLAB_PROVIDER_SECRET_DIR="$secret_directory"
  COMPOSE+=( -f "$PROVIDER_COMPOSE_FILE" )
}

validate_provider_secret_group_isolation() {
  local protected_gid=10001
  local account
  local account_gid
  local account_group_list

  require_command getent
  require_command id

  # The container can read numeric-GID bind mounts without a host NSS group.
  # Keep that GID completely unassigned on the host so no host service or
  # login account inherits access to provider credentials.
  if getent group "$protected_gid" > /dev/null; then
    die "Provider runtime GID $protected_gid must not be assigned to a host group."
  fi
  while IFS=: read -r account _ _ account_gid _ _ _; do
    [[ -n "$account" ]] || continue
    [[ "$account_gid" != "$protected_gid" ]] \
      || die "Host account $account must not use provider runtime GID $protected_gid."
    account_group_list="$(id -G "$account")" \
      || die "Could not resolve supplementary groups for host account $account."
    [[ ! "$account_group_list" =~ (^|[[:space:]])${protected_gid}($|[[:space:]]) ]] \
      || die "Host account $account must not belong to provider runtime GID $protected_gid."
  done < <(getent passwd)
}

backup_directory_from_env() {
  local env_file="$1"
  local backup_dir
  backup_dir="$(dotenv_value "$env_file" SCIFORGE_COLLAB_BACKUP_DIR optional)"
  backup_dir="${backup_dir:-/srv/sciforge-collaboration/backups}"
  [[ "$backup_dir" == /srv/sciforge-collaboration/backups ]] \
    || die "SCIFORGE_COLLAB_BACKUP_DIR must be /srv/sciforge-collaboration/backups."
  printf '%s' "$backup_dir"
}

validate_database_role_layout() {
  local application_role_attributes
  local database_owner

  if ! application_role_attributes="$("${COMPOSE[@]}" exec -T postgres \
    psql -U sciforge_admin -d postgres --tuples-only --no-align \
    --command="SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = 'sciforge_collab';")"; then
    die "Could not inspect the dedicated database roles. Refusing to use a legacy or partially initialized volume."
  fi
  [[ "$application_role_attributes" == "f|f|f|f|t" ]] \
    || die "Application database role does not have the required least-privilege attributes."

  if ! database_owner="$("${COMPOSE[@]}" exec -T postgres \
    psql -U sciforge_admin -d postgres --tuples-only --no-align \
    --command="SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'sciforge_collaboration';")"; then
    die "Could not inspect the collaboration database owner."
  fi
  [[ "$database_owner" == sciforge_collab ]] \
    || die "Application database is not owned by the least-privilege application role."
}

expected_collaboration_tables() {
  [[ -n "$RELEASE_EXPECTED_TABLES" ]] \
    || die "Release-derived table truth has not been initialized."
  printf '%s\n' "$RELEASE_EXPECTED_TABLES"
}

database_table_row_counts() {
  local database="$1"
  local database_user="$2"
  local table
  local count
  local tables=()

  [[ "$database" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "Unsafe database name in row-count verification."
  [[ "$database_user" == sciforge_admin || "$database_user" == sciforge_collab ]] \
    || die "Unexpected database user in row-count verification."
  mapfile -t tables < <(expected_collaboration_tables)
  (( ${#tables[@]} > 0 )) || die "Release-derived table truth is empty."
  for table in "${tables[@]}"; do
    [[ "$table" =~ ^[a-z][a-z0-9_]*$ ]] || die "Unsafe table name in row-count verification."
    if ! count="$("${COMPOSE[@]}" exec -T postgres \
      psql -U "$database_user" -d "$database" --tuples-only --no-align \
      --command="SELECT count(*) FROM sciforge_collaboration.${table};")"; then
      die "Could not count a collaboration table during restore verification."
    fi
    [[ "$count" =~ ^[0-9]+$ ]] || die "Database returned an invalid table row count."
    printf '%s=%s\n' "$table" "$count"
  done
}

# The OIDC test edge is deliberately separate from the legacy core-only edge.
# These helpers validate only A-owned ingress/application facts and the narrow
# Docker attachment contract offered by the independently managed Keycloak
# container. They never inspect Keycloak credentials, realm exports, or its
# database network.
validate_a_https_oidc_test_state_dirs() {
  local path

  [[ "$(readlink -f /srv/sciforge-collaboration)" == /srv/sciforge-collaboration ]] \
    || die "The collaboration service root must be a physical directory."
  for path in "$A_HTTPS_OIDC_TEST_STATE_DIR" \
      "$A_HTTPS_OIDC_TEST_STATE_DIR/data" "$A_HTTPS_OIDC_TEST_STATE_DIR/config" \
      "$A_HTTPS_OIDC_TEST_STATE_DIR/approval"; do
    [[ -d "$path" && ! -L "$path" ]] \
      || die "The persistent OIDC edge state directory is missing or is a symlink: $path"
  done
  [[ "$(readlink -f "$A_HTTPS_OIDC_TEST_STATE_DIR")" == "$A_HTTPS_OIDC_TEST_STATE_DIR" \
      && "$(readlink -f "$A_HTTPS_OIDC_TEST_STATE_DIR/data")" == "$A_HTTPS_OIDC_TEST_STATE_DIR/data" \
      && "$(readlink -f "$A_HTTPS_OIDC_TEST_STATE_DIR/config")" == "$A_HTTPS_OIDC_TEST_STATE_DIR/config" \
      && "$(readlink -f "$A_HTTPS_OIDC_TEST_STATE_DIR/approval")" == "$A_HTTPS_OIDC_TEST_STATE_DIR/approval" ]] \
    || die "The persistent OIDC edge state escaped its fixed physical path."
  [[ "$(stat -c '%u:%g:%a' "$A_HTTPS_OIDC_TEST_STATE_DIR")" == 0:0:750 \
      && "$(stat -c '%u:%g:%a' "$A_HTTPS_OIDC_TEST_STATE_DIR/data")" == 10002:10002:700 \
      && "$(stat -c '%u:%g:%a' "$A_HTTPS_OIDC_TEST_STATE_DIR/config")" == 10002:10002:700 \
      && "$(stat -c '%u:%g:%a' "$A_HTTPS_OIDC_TEST_STATE_DIR/approval")" == 0:10002:750 ]] \
    || die "The persistent OIDC edge state directories have unsafe ownership or permissions."
}

prepare_a_https_oidc_test_state_dirs() {
  local path

  if getent passwd 10002 >/dev/null; then
    die "Host UID 10002 must remain unassigned before preparing isolated OIDC edge state."
  fi
  if getent group 10002 >/dev/null; then
    die "Host GID 10002 must remain unassigned before preparing isolated OIDC edge state."
  fi
  [[ "$(readlink -f /srv/sciforge-collaboration)" == /srv/sciforge-collaboration ]] \
    || die "The collaboration service root must be a physical directory."
  for path in "$A_HTTPS_OIDC_TEST_STATE_DIR" \
      "$A_HTTPS_OIDC_TEST_STATE_DIR/data" "$A_HTTPS_OIDC_TEST_STATE_DIR/config" \
      "$A_HTTPS_OIDC_TEST_STATE_DIR/approval"; do
    [[ ! -L "$path" ]] || die "Refusing a symlinked persistent OIDC edge state path: $path"
  done
  install -d -o root -g root -m 0750 "$A_HTTPS_OIDC_TEST_STATE_DIR"
  install -d -o 10002 -g 10002 -m 0700 \
    "$A_HTTPS_OIDC_TEST_STATE_DIR/data" "$A_HTTPS_OIDC_TEST_STATE_DIR/config"
  install -d -o root -g 10002 -m 0750 "$A_HTTPS_OIDC_TEST_STATE_DIR/approval"
  validate_a_https_oidc_test_state_dirs
}

validate_a_https_oidc_test_host() {
  local database_network_properties
  local hostname
  local identity_network_properties
  local network_properties
  local resolved_ipv4=()

  require_root
  if getent passwd 10002 >/dev/null; then
    die "Host UID 10002 must remain unassigned for the isolated OIDC edge runtime."
  fi
  if getent group 10002 >/dev/null; then
    die "Host GID 10002 must remain unassigned for the isolated OIDC edge runtime."
  fi
  for hostname in "$A_HTTPS_OIDC_TEST_HOSTNAME" "$A_HTTPS_OIDC_TEST_IDENTITY_HOSTNAME"; do
    mapfile -t resolved_ipv4 < <(
      getent ahostsv4 "$hostname" | awk 'NF { print $1 }' | LC_ALL=C sort -u
    )
    (( ${#resolved_ipv4[@]} == 1 )) \
      || die "$hostname must resolve to exactly one IPv4 address."
    [[ "${resolved_ipv4[0]}" == "$A_HTTPS_OIDC_TEST_PUBLIC_IPV4" ]] \
      || die "$hostname does not resolve to the approved ECS address."
  done
  network_properties="$(docker network inspect --format \
    '{{.Internal}}|{{.Driver}}|{{.Scope}}|{{index .Labels "com.docker.compose.project"}}' \
    "$A_HTTPS_OIDC_TEST_APP_NETWORK")"
  [[ "$network_properties" == false\|bridge\|local\|sciforge-collaboration-private ]] \
    || die "The private application edge network is not the fixed local collaboration bridge."
  database_network_properties="$(docker network inspect --format \
    '{{.Internal}}|{{.Driver}}|{{.Scope}}|{{index .Labels "com.docker.compose.project"}}' \
    "$A_HTTPS_OIDC_TEST_DATABASE_NETWORK")"
  [[ "$database_network_properties" == true\|bridge\|local\|sciforge-collaboration-private ]] \
    || die "The collaboration database network is not the fixed internal bridge."
  identity_network_properties="$(docker network inspect --format \
    '{{.Internal}}|{{.Driver}}|{{.Scope}}' "$A_HTTPS_OIDC_TEST_IDENTITY_NETWORK")" \
    || die "The dedicated Keycloak identity-edge network does not exist."
  [[ "$identity_network_properties" == false\|bridge\|local ]] \
    || die "The Keycloak identity-edge network must be a dedicated local bridge."
  validate_a_https_oidc_test_state_dirs
}

assert_no_a_https_oidc_test_edge_container() {
  local edge_ids=()

  mapfile -t edge_ids < <(docker container ls -a --no-trunc -q \
    --filter "label=com.docker.compose.project=$A_HTTPS_OIDC_TEST_PROJECT")
  (( ${#edge_ids[@]} == 0 )) \
    || die "An A HTTPS OIDC edge container still exists."
}

assert_a_https_oidc_test_network_membership() {
  local expected_edge_id="${1:-}"
  local app_aliases
  local app_networks=()
  local edge_aliases
  local edge_networks=()
  local endpoint_id
  local identity_endpoint_ids=()
  local keycloak_aliases
  local keycloak_candidates=()
  local keycloak_id
  local keycloak_networks=()
  local keycloak_state
  local private_endpoint_ids=()
  local expected_private_endpoints=()

  [[ "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]] \
    || die "The approved OIDC test app identity is unavailable."
  mapfile -t app_networks < <(docker container inspect --format \
    '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
    "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" | awk 'NF { print }' | LC_ALL=C sort)
  [[ "$(printf '%s\n' "${app_networks[@]}")" == \
      "$(printf '%s\n' "$A_HTTPS_OIDC_TEST_DATABASE_NETWORK" "$A_HTTPS_OIDC_TEST_APP_NETWORK" | LC_ALL=C sort)" ]] \
    || die "The OIDC test app must join exactly its database and private-edge networks."

  mapfile -t private_endpoint_ids < <(docker network inspect --format \
    '{{range $id, $_ := .Containers}}{{println $id}}{{end}}' \
    "$A_HTTPS_OIDC_TEST_APP_NETWORK" | awk 'NF { print }' | LC_ALL=C sort)
  expected_private_endpoints=("$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID")
  if [[ -n "$expected_edge_id" ]]; then
    [[ "$expected_edge_id" =~ ^[0-9a-f]{64}$ ]] || die "The OIDC edge identity is invalid."
    expected_private_endpoints+=("$expected_edge_id")
  fi
  [[ "$(printf '%s\n' "${private_endpoint_ids[@]}")" == \
      "$(printf '%s\n' "${expected_private_endpoints[@]}" | LC_ALL=C sort)" ]] \
    || die "The private application edge network contains an unapproved endpoint."
  app_aliases="$(docker container inspect --format \
    "{{range (index .NetworkSettings.Networks \"$A_HTTPS_OIDC_TEST_APP_NETWORK\").Aliases}}{{println .}}{{end}}" \
    "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID")"
  [[ "$(grep -Fxc app <<< "$app_aliases")" == 1 ]] \
    || die "Exactly the approved application must own the private-edge app alias."

  mapfile -t identity_endpoint_ids < <(docker network inspect --format \
    '{{range $id, $_ := .Containers}}{{println $id}}{{end}}' \
    "$A_HTTPS_OIDC_TEST_IDENTITY_NETWORK" | awk 'NF { print }' | LC_ALL=C sort)
  for endpoint_id in "${identity_endpoint_ids[@]}"; do
    [[ -n "$expected_edge_id" && "$endpoint_id" == "$expected_edge_id" ]] && continue
    keycloak_candidates+=("$endpoint_id")
  done
  (( ${#keycloak_candidates[@]} == 1 )) \
    || die "The dedicated identity-edge network must contain exactly one Keycloak app plus the optional A edge."
  keycloak_id="${keycloak_candidates[0]}"
  [[ "$keycloak_id" != "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" ]] \
    || die "The SciForge Cloud app must never join the Keycloak identity-edge network."
  keycloak_state="$(docker container inspect --format '{{.State.Status}}' "$keycloak_id")"
  [[ "$keycloak_state" == running ]] || die "The Keycloak identity-edge endpoint is not running."
  keycloak_aliases="$(docker container inspect --format \
    "{{range (index .NetworkSettings.Networks \"$A_HTTPS_OIDC_TEST_IDENTITY_NETWORK\").Aliases}}{{println .}}{{end}}" \
    "$keycloak_id")"
  [[ "$(grep -Fxc keycloak <<< "$keycloak_aliases")" == 1 ]] \
    || die "Exactly one identity-edge endpoint must own the keycloak alias."
  if grep -Eq '^(app|postgres|database)$' <<< "$keycloak_aliases"; then
    die "The Keycloak endpoint owns a forbidden application or database alias."
  fi
  mapfile -t keycloak_networks < <(docker container inspect --format \
    '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
    "$keycloak_id" | awk 'NF { print }')
  grep -Fxq "$A_HTTPS_OIDC_TEST_IDENTITY_NETWORK" <<< "$(printf '%s\n' "${keycloak_networks[@]}")" \
    || die "The selected Keycloak endpoint is not attached to identity-edge."
  if printf '%s\n' "${keycloak_networks[@]}" | grep -Eq \
      "^($A_HTTPS_OIDC_TEST_DATABASE_NETWORK|$A_HTTPS_OIDC_TEST_APP_NETWORK)$"; then
    die "Keycloak must never join a SciForge Cloud application or database network."
  fi

  if [[ -n "$expected_edge_id" ]]; then
    (( ${#identity_endpoint_ids[@]} == 2 )) \
      || die "The identity-edge network must contain only Keycloak and the A edge."
    mapfile -t edge_networks < <(docker container inspect --format \
      '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
      "$expected_edge_id" | awk 'NF { print }' | LC_ALL=C sort)
    [[ "$(printf '%s\n' "${edge_networks[@]}")" == \
        "$(printf '%s\n' "$A_HTTPS_OIDC_TEST_APP_NETWORK" "$A_HTTPS_OIDC_TEST_IDENTITY_NETWORK" | LC_ALL=C sort)" ]] \
      || die "The OIDC edge must join exactly the Cloud private-edge and Keycloak identity-edge networks."
    edge_aliases="$(docker container inspect --format \
      "{{range (index .NetworkSettings.Networks \"$A_HTTPS_OIDC_TEST_IDENTITY_NETWORK\").Aliases}}{{println .}}{{end}}" \
      "$expected_edge_id")"
    if grep -Eq '^(keycloak|app|postgres|database)$' <<< "$edge_aliases"; then
      die "The A edge must not own an upstream or database alias."
    fi
  else
    (( ${#identity_endpoint_ids[@]} == 1 )) \
      || die "The pre-deployment identity-edge network must contain only Keycloak."
  fi
  A_HTTPS_OIDC_TEST_KEYCLOAK_CONTAINER_ID="$keycloak_id"
}

inspect_a_https_oidc_test_image() {
  inspect_a_https_test_edge_image "${1:-pull}"
  A_HTTPS_OIDC_TEST_IMAGE_ID="$A_HTTPS_TEST_EDGE_IMAGE_ID"
}

a_https_oidc_test_app_snapshot() {
  a_https_test_edge_app_snapshot "${1:-$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID}"
}

a_https_oidc_test_keycloak_snapshot() {
  a_https_test_edge_app_snapshot "${1:-$A_HTTPS_OIDC_TEST_KEYCLOAK_CONTAINER_ID}"
}

validate_a_https_oidc_test_app() {
  local expected_commit="$1"
  local app_container_id
  local app_environment
  local app_image_id
  local app_mode
  local app_revision
  local app_state
  local catalog_body
  local container_revision
  local expected_value
  local key
  local key_count
  local key_value
  local postgres_endpoint
  local portal_secret_count
  local portal_secret_length
  local provider_env_count
  local provider_mount_count
  local published_endpoint
  local running_services

  running_services="$("${COMPOSE[@]}" ps --status running --services)"
  grep -qx postgres <<< "$running_services" || die "PostgreSQL is not running."
  grep -qx app <<< "$running_services" || die "The OIDC test app is not running."
  app_container_id="$("${COMPOSE[@]}" ps -q app)"
  [[ "$app_container_id" =~ ^[0-9a-f]{64}$ ]] || die "Could not identify the OIDC test app."
  app_state="$(docker container inspect --format \
    '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$app_container_id")"
  [[ "$app_state" == running\|healthy ]] || die "The OIDC test app is not healthy."
  app_revision="$(docker container inspect --format \
    '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$app_container_id")"
  [[ "$app_revision" == "$expected_commit" ]] || die "The running OIDC test app revision is not approved."
  app_mode="$(docker container inspect --format \
    '{{index .Config.Labels "cn.sciforge.deployment.mode"}}' "$app_container_id")"
  [[ "$app_mode" == oidc-test-private ]] || die "The public OIDC edge requires explicit oidc-test-private mode."
  [[ "$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' \
    "$app_container_id")" == sciforge-collaboration-private ]] \
    || die "The OIDC test app belongs to an unexpected Compose project."
  app_image_id="$(docker container inspect --format '{{.Image}}' "$app_container_id")"
  [[ "$app_image_id" == "$(docker image inspect --format '{{.Id}}' \
    "sciforge-collaboration-runtime:$expected_commit")" ]] \
    || die "The running OIDC test app does not use the approved image ID."
  container_revision="$(docker exec "$app_container_id" sh -c \
    'tr -d "\r\n" < /app/CONTRACT_COMMIT')"
  [[ "$container_revision" == "$expected_commit" ]] \
    || die "The OIDC test app container commit proof is invalid."
  docker exec "$app_container_id" node /app/verify-portal-assets.mjs \
    /app/RELEASE_MANIFEST.json "$A_CLOUD_PORTAL_ASSET_DIR" >/dev/null \
    || die "The OIDC test app does not retain the fixed Portal package and asset inventory."
  published_endpoint="$("${COMPOSE[@]}" port app 8787)"
  [[ "$published_endpoint" == 127.0.0.1:8787 ]] \
    || die "The OIDC test app must remain published only on 127.0.0.1:8787."
  postgres_endpoint="$("${COMPOSE[@]}" port postgres 5432 2>/dev/null || true)"
  [[ -z "$postgres_endpoint" ]] || die "PostgreSQL must not publish a host port."
  assert_a_https_test_edge_backend_port_boundaries

  app_environment="$(docker container inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
    "$app_container_id")"
  while IFS='|' read -r key expected_value; do
    key_count="$(printf '%s\n' "$app_environment" | awk -F= -v key="$key" \
      '$1 == key { count += 1 } END { print count + 0 }')"
    key_value="$(printf '%s\n' "$app_environment" | awk -F= -v key="$key" \
      '$1 == key { print substr($0, index($0, "=") + 1) }')"
    [[ "$key_count" == 1 && "$key_value" == "$expected_value" ]] \
      || die "The OIDC test app has an invalid $key value."
  done <<EOF
SCIFORGE_COLLABORATION_ALLOWED_ORIGINS|$A_HTTPS_OIDC_TEST_ORIGIN
SCIFORGE_COLLABORATION_OIDC_ISSUER|$A_HTTPS_OIDC_TEST_ISSUER
SCIFORGE_COLLABORATION_OIDC_AUDIENCE|$A_HTTPS_OIDC_TEST_AUDIENCE
SCIFORGE_COLLABORATION_OIDC_AUTHORIZED_PARTIES|$A_HTTPS_OIDC_TEST_AUTHORIZED_PARTIES
SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK|false
SCIFORGE_COLLABORATION_PORTAL_ENABLED|true
SCIFORGE_COLLABORATION_PORTAL_ASSET_DIR|$A_CLOUD_PORTAL_ASSET_DIR
SCIFORGE_COLLABORATION_PORTAL_PUBLIC_ORIGIN|$A_HTTPS_OIDC_TEST_ORIGIN
SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_ID|$A_CLOUD_PORTAL_CLIENT_ID
SCIFORGE_COLLABORATION_PORTAL_OIDC_REDIRECT_URI|$A_CLOUD_PORTAL_REDIRECT_URI
SCIFORGE_COLLABORATION_PORTAL_TEST_WORKER_DIRECTORY_ENABLED|true
EOF
  portal_secret_count="$(printf '%s\n' "$app_environment" | awk -F= '
    $1 == "SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET" { count += 1 }
    END { print count + 0 }
  ')"
  portal_secret_length="$(printf '%s\n' "$app_environment" | awk -F= '
    $1 == "SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET" {
      print length(substr($0, index($0, "=") + 1))
    }
  ')"
  [[ "$portal_secret_count" == 1 && "$portal_secret_length" =~ ^[0-9]+$ \
      && "$portal_secret_length" -ge 32 && "$portal_secret_length" -le 512 ]] \
    || die "The OIDC test app does not contain exactly one bounded Portal client secret."
  provider_env_count="$(printf '%s\n' "$app_environment" | awk -F= '
    $1 == "SCIFORGE_COLLABORATION_PROVIDER_CONFIG_FILE" ||
    $1 == "SCIFORGE_COLLABORATION_SECRET_DIRECTORY" { count += 1 }
    END { print count + 0 }
  ')"
  [[ "$provider_env_count" == 0 ]] || die "Provider environment is forbidden in A HTTPS OIDC test mode."
  provider_mount_count="$(docker container inspect --format \
    '{{range .Mounts}}{{println .Destination}}{{end}}' "$app_container_id" | awk '
      $0 == "/run/sciforge-provider" || index($0, "/run/sciforge-provider/") == 1 { count += 1 }
      END { print count + 0 }
    ')"
  [[ "$provider_mount_count" == 0 ]] || die "Provider mounts are forbidden in A HTTPS OIDC test mode."

  catalog_body="$(curl --disable --noproxy '*' --proto '=http' \
    --fail --silent --show-error --max-time 5 \
    --header 'content-type: application/json' \
    --data '{"protocolVersion":"1.0","requestId":"req_ahttpsoidccatalog0001","type":"endpoint.catalog.get"}' \
    http://127.0.0.1:8787/v1/commands)"
  printf '%s' "$catalog_body" | docker exec -i "$app_container_id" node -e '
    let input = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => { input += chunk })
    process.stdin.on("end", () => {
      try {
        const body = JSON.parse(input)
        if (body?.type !== "endpoint.catalog" || !Array.isArray(body.providers) || body.providers.length !== 0) process.exit(1)
      } catch { process.exit(1) }
    })
  ' || die "The OIDC test Provider catalog is not exactly empty."
  A_HTTPS_OIDC_TEST_APP_CONTAINER_ID="$app_container_id"
}
