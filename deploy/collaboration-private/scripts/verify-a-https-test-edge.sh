#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

expected_commit="${1:-}"
env_input="${2:-$PRIVATE_DEPLOY_DIR/.env}"
verification_mode="${3:-stable}"
[[ -n "$expected_commit" ]] \
  || die "Usage: verify-a-https-test-edge.sh <approved-40-character-contract-commit> [env-file] [--candidate]"
[[ "$verification_mode" == stable || "$verification_mode" == --candidate ]] \
  || die "Unknown HTTPS edge verification mode."

for command in awk chmod curl docker flock getent grep install openssl readlink seq sha256sum sleep sort ss stat tar timeout tr; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable."
require_root
acquire_collaboration_deploy_lock
for unsafe_probe_variable in CURL_CA_BUNDLE NODE_EXTRA_CA_CERTS NODE_OPTIONS NODE_PATH \
    NODE_TLS_REJECT_UNAUTHORIZED OPENSSL_CONF OPENSSL_MODULES SSL_CERT_DIR SSL_CERT_FILE; do
  [[ -z "${!unsafe_probe_variable:-}" ]] \
    || die "Probe environment variable $unsafe_probe_variable is forbidden."
done

validate_a_https_test_edge_bundle "$expected_commit"
prepare_a_https_test_edge_environment "$expected_commit" "$env_input"
validate_local_docker_endpoint
validate_a_https_test_edge_host
validate_a_https_test_edge_core_app "$expected_commit"
app_snapshot_before="$(a_https_test_edge_app_snapshot)"
inspect_a_https_test_edge_image local
"${EDGE_COMPOSE[@]}" config --quiet

edge_container_id="$("${EDGE_COMPOSE[@]}" ps -q edge)"
[[ "$edge_container_id" =~ ^[0-9a-f]{64}$ ]] || die "Could not identify one running HTTPS edge."
assert_a_https_test_edge_network_membership "$edge_container_id"
edge_state="$(docker container inspect --format \
  '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$edge_container_id")"
[[ "$edge_state" == running\|healthy ]] || die "The HTTPS edge is not running and healthy."
restart_policy="$(docker container inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$edge_container_id")"
approval_marker="$A_HTTPS_TEST_EDGE_STATE_DIR/approval/approved-$expected_commit"
if [[ "$verification_mode" == --candidate ]]; then
  [[ "$restart_policy" == no && ! -e "$approval_marker" && ! -L "$approval_marker" ]] \
    || die "An unverified edge candidate must have no restart policy or approval marker."
else
  [[ "$restart_policy" == unless-stopped \
      && -f "$approval_marker" && ! -L "$approval_marker" \
      && "$(stat -c '%u:%g:%a' "$approval_marker")" == 0:10002:440 \
      && "$(tr -d '\r\n' < "$approval_marker")" == "$expected_commit" ]] \
    || die "The stable edge lacks its exact verified approval marker or restart policy."
fi
[[ "$(docker container inspect --format '{{.Image}}' "$edge_container_id")" == "$A_HTTPS_TEST_EDGE_IMAGE_ID" ]] \
  || die "The HTTPS edge does not use the approved image ID."
[[ "$(docker container inspect --format '{{.Config.User}}' "$edge_container_id")" == 10002:10002 ]] \
  || die "The HTTPS edge does not use the fixed non-root UID/GID."
[[ "$(docker container inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$edge_container_id")" == true ]] \
  || die "The HTTPS edge root filesystem is not read-only."
[[ "$(docker container inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$edge_container_id")" == "$expected_commit" ]] \
  || die "The HTTPS edge revision label is invalid."
[[ "$(docker container inspect --format '{{index .Config.Labels "cn.sciforge.edge.mode"}}' \
  "$edge_container_id")" == public-https-core-only ]] \
  || die "The HTTPS edge mode label is invalid."
[[ "$(docker container inspect --format '{{index .Config.Labels "cn.sciforge.edge.hostname"}}' \
  "$edge_container_id")" == "$A_HTTPS_TEST_EDGE_HOSTNAME" ]] \
  || die "The HTTPS edge hostname label is invalid."
[[ "$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' \
  "$edge_container_id")" == sciforge-collaboration-a-https-test-edge ]] \
  || die "The HTTPS edge belongs to an unexpected Compose project."

security_options="$(docker container inspect --format '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' \
  "$edge_container_id")"
grep -Fxq no-new-privileges:true <<< "$security_options" \
  || die "The HTTPS edge lacks no-new-privileges."
capability_drops="$(docker container inspect --format '{{range .HostConfig.CapDrop}}{{println .}}{{end}}' \
  "$edge_container_id")"
grep -Fxq ALL <<< "$capability_drops" || die "The HTTPS edge does not drop all capabilities."
port_bindings="$(docker container inspect --format '{{json .HostConfig.PortBindings}}' "$edge_container_id")"
[[ "$port_bindings" == '{"8443/tcp":[{"HostIp":"0.0.0.0","HostPort":"443"}]}' ]] \
  || die "The HTTPS edge must publish only host TCP 443 to container 8443."

mapfile -t edge_networks < <(docker container inspect --format \
  '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$edge_container_id" \
  | awk 'NF { print }')
(( ${#edge_networks[@]} == 1 )) || die "The HTTPS edge must join exactly one Docker network."
[[ "${edge_networks[0]}" == "$A_HTTPS_TEST_EDGE_NETWORK" ]] \
  || die "The HTTPS edge joined an unauthorized Docker network."

mapfile -t edge_mounts < <(docker container inspect --format \
  '{{range .Mounts}}{{println .Type "|" .Source "|" .Destination "|" .RW}}{{end}}' \
  "$edge_container_id" | awk 'NF { print }' | LC_ALL=C sort)
(( ${#edge_mounts[@]} == 4 )) || die "The HTTPS edge has an unexpected mount set."
printf '%s\n' "${edge_mounts[@]}" | grep -Fxq \
  "bind | $A_HTTPS_TEST_EDGE_CADDYFILE | /etc/caddy/Caddyfile | false" \
  || die "The HTTPS edge Caddyfile mount is invalid."
printf '%s\n' "${edge_mounts[@]}" | grep -Fxq \
  "bind | $A_HTTPS_TEST_EDGE_STATE_DIR/data | /data | true" \
  || die "The HTTPS edge data mount is invalid."
printf '%s\n' "${edge_mounts[@]}" | grep -Fxq \
  "bind | $A_HTTPS_TEST_EDGE_STATE_DIR/config | /config | true" \
  || die "The HTTPS edge config mount is invalid."
printf '%s\n' "${edge_mounts[@]}" | grep -Fxq \
  "bind | $A_HTTPS_TEST_EDGE_STATE_DIR/approval | /approval | false" \
  || die "The HTTPS edge approval mount is invalid."
if printf '%s\n' "${edge_mounts[@]}" | grep -Fq /var/run/docker.sock; then
  die "The HTTPS edge must never mount the Docker socket."
fi

tcp_80_count="$(ss -H -ltn | awk '$4 ~ /:80$/ { count += 1 } END { print count + 0 }')"
udp_443_count="$(ss -H -lun | awk '$4 ~ /:443$/ { count += 1 } END { print count + 0 }')"
[[ "$tcp_80_count" == 0 && "$udp_443_count" == 0 ]] \
  || die "The ECS listener boundary must have no HTTP or HTTP/3 listener."

base_url="https://$A_HTTPS_TEST_EDGE_HOSTNAME"
curl_args=(--disable --noproxy '*' --proto '=https' --silent --show-error --max-time 10 \
  --resolve "$A_HTTPS_TEST_EDGE_HOSTNAME:443:127.0.0.1")
https_ready=false
for _ in $(seq 1 60); do
  if [[ "$(curl "${curl_args[@]}" --output /dev/null --write-out '%{http_code}' \
      "$base_url/healthz" 2>/dev/null || true)" == 200 ]]; then
    https_ready=true
    break
  fi
  sleep 3
done
[[ "$https_ready" == true ]] || die "The trusted HTTPS certificate or health endpoint did not become ready."

timeout 15 openssl s_client -connect 127.0.0.1:443 -servername "$A_HTTPS_TEST_EDGE_HOSTNAME" \
  -verify_hostname "$A_HTTPS_TEST_EDGE_HOSTNAME" -verify_return_error </dev/null 2>/dev/null \
  | openssl x509 -noout -checkend 259200 >/dev/null \
  || die "The HTTPS certificate chain, hostname, or remaining lifetime is invalid."
set +e
login_tls_output="$(timeout 15 openssl s_client -connect 127.0.0.1:443 \
  -servername login-test.sciforge.cn -showcerts </dev/null 2>&1)"
login_tls_status=$?
set -e
if (( login_tls_status == 0 )) || grep -Fq -- '-----BEGIN CERTIFICATE-----' <<< "$login_tls_output"; then
  die "The A edge must not terminate TLS for login-test.sciforge.cn."
fi

health_status="$(curl "${curl_args[@]}" --output /dev/null --write-out '%{http_code}' "$base_url/healthz")"
ready_status="$(curl "${curl_args[@]}" --output /dev/null --write-out '%{http_code}' "$base_url/readyz")"
health_body="$(curl "${curl_args[@]}" --fail "$base_url/healthz")"
ready_body="$(curl "${curl_args[@]}" --fail "$base_url/readyz")"
[[ "$health_status" == 200 && "$ready_status" == 200 \
    && "$health_body" == '{"ok":true}' && "$ready_body" == '{"ok":true}' ]] \
  || die "The HTTPS health or readiness response is invalid."
[[ "$(curl "${curl_args[@]}" --output /dev/null --write-out '%{http_code}' "$base_url/console/")" == 404 ]] \
  || die "The A-only console must remain unavailable on the public test edge."
[[ "$(curl "${curl_args[@]}" --output /dev/null --write-out '%{http_code}' "$base_url/v1/me")" == 401 ]] \
  || die "The unconfigured OIDC identity boundary must fail closed over HTTPS."

wss_status="$(curl "${curl_args[@]}" --http1.1 --output /dev/null --write-out '%{http_code}' \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --header "Origin: $A_HTTPS_TEST_EDGE_ORIGIN" "$base_url/v1/events")"
[[ "$wss_status" == 401 ]] || die "The unauthenticated WSS boundary must fail closed with 401."
wrong_origin_status="$(curl "${curl_args[@]}" --http1.1 --output /dev/null --write-out '%{http_code}' \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --header 'Origin: https://example.invalid' "$base_url/v1/events")"
[[ "$wrong_origin_status" == 403 ]] || die "An unapproved browser origin was not rejected."

catalog_body="$(curl "${curl_args[@]}" --fail \
  --header 'content-type: application/json' \
  --data '{"protocolVersion":"1.0","requestId":"req_ahttpsedgecatalog0002","type":"endpoint.catalog.get"}' \
  "$base_url/v1/commands")"
printf '%s' "$catalog_body" | docker exec -i "$A_HTTPS_TEST_EDGE_APP_CONTAINER_ID" node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    try {
      const body = JSON.parse(input)
      if (body?.type !== "endpoint.catalog" || !Array.isArray(body.providers) || body.providers.length !== 0) process.exit(1)
    } catch { process.exit(1) }
  })
' || die "The public HTTPS catalog is not exactly core-only."

security_headers="$(curl "${curl_args[@]}" --output /dev/null --dump-header - "$base_url/healthz")"
grep -Eiq '^strict-transport-security: max-age=31536000' <<< "$security_headers" \
  || die "The HTTPS edge is missing HSTS."
grep -Eiq '^cache-control: no-store([[:space:]]|$)' <<< "$security_headers" \
  || die "The HTTPS edge response is not marked no-store."
[[ "$(awk 'tolower($1) == "x-sciforge-edge-revision:" { gsub(/\r/, "", $2); print $2 }' <<< "$security_headers")" == "$expected_commit" ]] \
  || die "The HTTPS edge revision header does not match the approved commit."
grep -Eiq '^x-content-type-options: nosniff' <<< "$security_headers" \
  || die "The HTTPS edge is missing no-sniff protection."
if grep -Eiq '^(server|access-control-allow-origin):' <<< "$security_headers"; then
  die "The HTTPS edge exposed a server banner or an unsafe CORS response."
fi

[[ "$(a_https_test_edge_app_snapshot)" == "$app_snapshot_before" ]] \
  || die "The independent HTTPS verification changed the collaboration app."
echo "Local ECS HTTPS edge verification passed for $A_HTTPS_TEST_EDGE_HOSTNAME (core-only and WSS rejection boundaries only; independent public verification is still required)."
