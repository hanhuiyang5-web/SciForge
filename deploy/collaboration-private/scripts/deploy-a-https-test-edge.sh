#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

expected_commit="${1:-}"
env_input="${2:-$PRIVATE_DEPLOY_DIR/.env}"
[[ -n "$expected_commit" ]] \
  || die "Usage: deploy-a-https-test-edge.sh <approved-40-character-contract-commit> [env-file]"

for command in awk chmod chown curl docker flock getent grep install mktemp mv openssl readlink rm seq sha256sum sleep sort ss stat tar; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable."
require_root
acquire_collaboration_deploy_lock

validate_a_https_test_edge_bundle "$expected_commit"
prepare_a_https_test_edge_environment "$expected_commit" "$env_input"
validate_local_docker_endpoint
assert_no_a_https_test_edge_container
prepare_a_https_test_edge_state_dirs
approval_marker="$A_HTTPS_TEST_EDGE_STATE_DIR/approval/approved-$expected_commit"
[[ ! -L "$approval_marker" && ! -d "$approval_marker" ]] \
  || die "The edge approval marker path is unsafe."
rm -f -- "$approval_marker"
validate_a_https_test_edge_host
validate_a_https_test_edge_core_app "$expected_commit"
assert_a_https_test_edge_network_membership
app_snapshot_before="$(a_https_test_edge_app_snapshot)"
inspect_a_https_test_edge_image
"${EDGE_COMPOSE[@]}" config --quiet

listener_443_count="$(ss -H -ltn | awk '$4 ~ /:443$/ { count += 1 } END { print count + 0 }')"
[[ "$listener_443_count" == 0 ]] || die "TCP port 443 is already in use on the ECS."

docker run --rm \
  --network none \
  --read-only \
  --user 10002:10002 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
  --tmpfs /run/caddy-bin:rw,nosuid,nodev,exec,size=64m,uid=10002,gid=10002,mode=0700 \
  --tmpfs /data:rw,nosuid,nodev,noexec,size=16m,uid=10002,gid=10002,mode=0700 \
  --tmpfs /config:rw,nosuid,nodev,noexec,size=16m,uid=10002,gid=10002,mode=0700 \
  --mount "type=bind,src=$A_HTTPS_TEST_EDGE_CADDYFILE,dst=/etc/caddy/Caddyfile,readonly" \
  --entrypoint /bin/sh \
  "$A_HTTPS_TEST_EDGE_IMAGE_ID" \
  -eu -c 'cp /usr/bin/caddy /run/caddy-bin/caddy; chmod 0500 /run/caddy-bin/caddy; exec /run/caddy-bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile' >/dev/null

deployment_complete=false
edge_launch_attempted=false
candidate_edge_id=""
stop_unverified_edge() {
  local exit_code=$?
  local candidate_image=""
  local candidate_project=""
  local candidate_service=""
  local candidate_port_bindings=""
  trap - EXIT INT TERM
  if [[ "$deployment_complete" == true ]]; then
    exit "$exit_code"
  fi
  if ! rm -f -- "$approval_marker"; then
    echo "ERROR: The edge approval marker could not be removed; continuing fail-closed candidate shutdown." >&2
    exit_code=1
  fi
  if [[ "$edge_launch_attempted" == true && -z "$candidate_edge_id" ]]; then
    candidate_edge_id="$("${EDGE_COMPOSE[@]}" ps -a -q edge 2>/dev/null || true)"
  fi
  if [[ "$edge_launch_attempted" == true && -n "$candidate_edge_id" ]]; then
    candidate_project="$(docker container inspect --format \
      '{{index .Config.Labels "com.docker.compose.project"}}' \
      "$candidate_edge_id" 2>/dev/null || true)"
    candidate_service="$(docker container inspect --format \
      '{{index .Config.Labels "com.docker.compose.service"}}' \
      "$candidate_edge_id" 2>/dev/null || true)"
    candidate_image="$(docker container inspect --format '{{.Image}}' \
      "$candidate_edge_id" 2>/dev/null || true)"
    candidate_port_bindings="$(docker container inspect --format '{{json .HostConfig.PortBindings}}' \
      "$candidate_edge_id" 2>/dev/null || true)"
    if [[ "$candidate_project" == "$A_HTTPS_TEST_EDGE_PROJECT" \
        && "$candidate_service" == edge ]]; then
      if docker stop -t 20 "$candidate_edge_id" >/dev/null 2>&1; then
        if [[ "$candidate_image" != "$A_HTTPS_TEST_EDGE_IMAGE_ID" ]]; then
          echo "ERROR: HTTPS edge verification failed with an unexpected image; the exact unverified candidate was stopped." >&2
        else
          echo "ERROR: HTTPS edge verification failed; the exact unverified candidate was stopped." >&2
        fi
        [[ "$candidate_port_bindings" == '{"8443/tcp":[{"HostIp":"0.0.0.0","HostPort":"443"}]}' ]] \
          || echo "ERROR: The stopped candidate also had an unexpected port-binding configuration." >&2
        echo "ERROR: Certificate state, app, PostgreSQL, and networks were preserved." >&2
      else
        echo "ERROR: HTTPS edge verification failed and the exact candidate could not be stopped; operator intervention is required." >&2
        exit_code=1
      fi
    else
      echo "ERROR: HTTPS edge verification failed, but the exact candidate no longer has this deployment's fixed project/service identity. Operator intervention is required." >&2
      exit_code=1
    fi
  fi
  (( exit_code != 0 )) || exit_code=1
  exit "$exit_code"
}
trap stop_unverified_edge EXIT
trap 'exit 130' INT TERM

edge_launch_attempted=true
"${EDGE_COMPOSE[@]}" create --no-build edge >/dev/null
candidate_edge_id="$("${EDGE_COMPOSE[@]}" ps -a -q edge)"
[[ "$candidate_edge_id" =~ ^[0-9a-f]{64}$ ]] || die "Could not identify the edge candidate container."
[[ "$(docker container inspect --format '{{.Image}}' "$candidate_edge_id")" == "$A_HTTPS_TEST_EDGE_IMAGE_ID" ]] \
  || die "The edge candidate does not use the approved Caddy image ID."
[[ "$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{json .HostConfig.PortBindings}}' \
  "$candidate_edge_id")" == "$A_HTTPS_TEST_EDGE_PROJECT|edge|{\"8443/tcp\":[{\"HostIp\":\"0.0.0.0\",\"HostPort\":\"443\"}]}" ]] \
  || die "The created edge candidate does not have the fixed project/service/port identity."
docker start "$candidate_edge_id" >/dev/null
edge_healthy=false
for _ in $(seq 1 60); do
  if [[ "$(docker container inspect --format \
      '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      "$candidate_edge_id" 2>/dev/null || true)" == running\|healthy ]]; then
    edge_healthy=true
    break
  fi
  sleep 3
done
[[ "$edge_healthy" == true ]] || die "The exact edge candidate did not become healthy."

"$SCRIPT_DIR/verify-a-https-test-edge.sh" "$expected_commit" "$ENV_FILE" --candidate
[[ "$(a_https_test_edge_app_snapshot)" == "$app_snapshot_before" ]] \
  || die "The collaboration app changed while deploying the independent HTTPS edge."

approval_temporary="$(mktemp "$A_HTTPS_TEST_EDGE_STATE_DIR/approval/.approved-$expected_commit.XXXXXX")"
chmod 0440 "$approval_temporary"
chown root:10002 "$approval_temporary"
printf '%s\n' "$expected_commit" > "$approval_temporary"
mv -f -- "$approval_temporary" "$approval_marker"
docker update --restart=unless-stopped "$candidate_edge_id" >/dev/null
[[ "$(docker container inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$candidate_edge_id")" == unless-stopped ]] \
  || die "The verified edge candidate did not enter the stable restart policy."
"$SCRIPT_DIR/verify-a-https-test-edge.sh" "$expected_commit" "$ENV_FILE"

deployment_complete=true
echo "A HTTPS test edge passed local ECS verification for $A_HTTPS_TEST_EDGE_HOSTNAME at contract commit $expected_commit. Run verify-a-https-test-edge-external.sh from an independent public network before declaring public availability; authenticated WSS and business E2E remain unverified."
