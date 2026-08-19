#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

(( $# == 0 )) || die "Usage: disable-a-https-test-edge.sh"

for command in awk chmod docker flock install readlink ss stat; do
  require_command "$command"
done
require_root
acquire_collaboration_deploy_lock

[[ "$PRIVATE_DEPLOY_DIR" =~ ^/srv/sciforge-collaboration/releases/([0-9a-f]{40})/deploy/collaboration-private$ ]] \
  || die "Emergency edge disable must run from a fixed release path."
release_commit="${BASH_REMATCH[1]}"
validate_fixed_edge_release_ancestors "$release_commit"
for fixed_script in "$SCRIPT_DIR/common.sh" "$SCRIPT_DIR/disable-a-https-test-edge.sh"; do
  [[ -f "$fixed_script" && ! -L "$fixed_script" \
      && "$(stat -c '%u:%g' "$fixed_script")" == 0:0 ]] \
    || die "Emergency edge disable scripts must be root-owned regular files."
  fixed_mode="$(stat -c '%a' "$fixed_script")"
  (( (8#$fixed_mode & 022) == 0 )) \
    || die "Emergency edge disable scripts must not be group/other writable."
done
validate_local_docker_endpoint

mapfile -t edge_ids < <(docker container ls -a --no-trunc -q \
  --filter "label=com.docker.compose.project=$A_HTTPS_TEST_EDGE_PROJECT")
if (( ${#edge_ids[@]} == 0 )); then
  assert_no_a_https_test_edge_container
  echo "No HTTPS edge container exists; persistent certificate state was preserved."
  exit 0
fi
unexpected_service=false
for edge_id in "${edge_ids[@]}"; do
  edge_project="$(docker container inspect --format \
    '{{index .Config.Labels "com.docker.compose.project"}}' "$edge_id")"
  edge_service="$(docker container inspect --format \
    '{{index .Config.Labels "com.docker.compose.service"}}' "$edge_id")"
  [[ "$edge_project" == "$A_HTTPS_TEST_EDGE_PROJECT" ]] \
    || die "Refusing to act on a container outside the fixed edge project identity."
  if [[ "$edge_service" != edge ]]; then
    unexpected_service=true
    echo "WARNING: Stopping an unexpected container in the dedicated edge project fail-closed; it will be preserved for inspection: $edge_id" >&2
  else
    edge_business_identity="$(docker container inspect --format \
      '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "cn.sciforge.edge.mode"}}|{{index .Config.Labels "cn.sciforge.edge.hostname"}}' \
      "$edge_id")"
    if [[ ! "$edge_business_identity" =~ ^[0-9a-f]{40}\|public-https-core-only\|cloud-test\.sciforge\.cn$ ]]; then
      echo "WARNING: The edge business labels drifted; stopping the exact fixed-project container fail-closed." >&2
    fi
  fi

  if [[ "$(docker container inspect --format '{{.State.Running}}' "$edge_id")" == true ]]; then
    docker stop -t 20 "$edge_id" >/dev/null \
      || die "A fixed-project HTTPS edge container could not be stopped: $edge_id"
  fi
  if [[ "$edge_service" == edge ]]; then
    docker rm "$edge_id" >/dev/null \
      || die "An exact HTTPS edge container could not be removed: $edge_id"
  fi
done
[[ "$unexpected_service" == false ]] \
  || die "Every dedicated edge-project container was stopped, but an unexpected service was preserved for operator inspection."
assert_no_a_https_test_edge_container

echo "HTTPS edge containers were stopped and removed. Certificate state, app, PostgreSQL, and Docker networks were preserved."
