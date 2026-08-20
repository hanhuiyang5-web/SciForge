#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

expected_commit="${1:-}"
env_input="${2:-$PRIVATE_DEPLOY_DIR/.env}"
verification_mode="${3:-stable}"
[[ -n "$expected_commit" ]] \
  || die "Usage: verify-a-https-oidc-test.sh <approved-40-character-contract-commit> [env-file] [--candidate]"
[[ "$verification_mode" == stable || "$verification_mode" == --candidate ]] \
  || die "Unknown A HTTPS OIDC edge verification mode."

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

validate_a_https_oidc_test_bundle "$expected_commit"
prepare_a_https_oidc_test_environment "$expected_commit" "$env_input"
validate_local_docker_endpoint
validate_a_https_oidc_test_host
validate_a_https_oidc_test_app "$expected_commit"
app_snapshot_before="$(a_https_oidc_test_app_snapshot)"
inspect_a_https_oidc_test_image local
"${OIDC_EDGE_COMPOSE[@]}" config --quiet

edge_container_id="$("${OIDC_EDGE_COMPOSE[@]}" ps -q edge)"
[[ "$edge_container_id" =~ ^[0-9a-f]{64}$ ]] || die "Could not identify one running A HTTPS OIDC edge."
assert_a_https_oidc_test_network_membership "$edge_container_id"
keycloak_snapshot_before="$(a_https_oidc_test_keycloak_snapshot)"
edge_state="$(docker container inspect --format \
  '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$edge_container_id")"
[[ "$edge_state" == running\|healthy ]] || die "The A HTTPS OIDC edge is not running and healthy."
restart_policy="$(docker container inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$edge_container_id")"
approval_marker="$A_HTTPS_OIDC_TEST_STATE_DIR/approval/approved-$expected_commit"
if [[ "$verification_mode" == --candidate ]]; then
  [[ "$restart_policy" == no && ! -e "$approval_marker" && ! -L "$approval_marker" ]] \
    || die "An unverified OIDC edge candidate must have no restart policy or approval marker."
else
  [[ "$restart_policy" == unless-stopped \
      && -f "$approval_marker" && ! -L "$approval_marker" \
      && "$(stat -c '%u:%g:%a' "$approval_marker")" == 0:10002:440 \
      && "$(tr -d '\r\n' < "$approval_marker")" == "$expected_commit" ]] \
    || die "The stable OIDC edge lacks its exact verified approval marker or restart policy."
fi

[[ "$(docker container inspect --format '{{.Image}}' "$edge_container_id")" == "$A_HTTPS_OIDC_TEST_IMAGE_ID" ]] \
  || die "The OIDC edge does not use the approved image ID."
[[ "$(docker container inspect --format '{{.Config.User}}' "$edge_container_id")" == 10002:10002 ]] \
  || die "The OIDC edge does not use the fixed non-root UID/GID."
[[ "$(docker container inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$edge_container_id")" == true ]] \
  || die "The OIDC edge root filesystem is not read-only."
edge_label_identity="$(docker container inspect --format \
  '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "cn.sciforge.edge.mode"}}|{{index .Config.Labels "cn.sciforge.edge.hostname"}}|{{index .Config.Labels "cn.sciforge.edge.identity-hostname"}}|{{index .Config.Labels "cn.sciforge.edge.oidc-issuer"}}|{{index .Config.Labels "com.docker.compose.project"}}' \
  "$edge_container_id")"
[[ "$edge_label_identity" == "$expected_commit|public-https-oidc-test|$A_HTTPS_OIDC_TEST_HOSTNAME|$A_HTTPS_OIDC_TEST_IDENTITY_HOSTNAME|$A_HTTPS_OIDC_TEST_ISSUER|$A_HTTPS_OIDC_TEST_PROJECT" ]] \
  || die "The OIDC edge labels do not retain the exact release and dual-SNI identity."
security_options="$(docker container inspect --format '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' \
  "$edge_container_id")"
grep -Fxq no-new-privileges:true <<< "$security_options" \
  || die "The OIDC edge lacks no-new-privileges."
capability_drops="$(docker container inspect --format '{{range .HostConfig.CapDrop}}{{println .}}{{end}}' \
  "$edge_container_id")"
grep -Fxq ALL <<< "$capability_drops" || die "The OIDC edge does not drop all capabilities."
port_bindings="$(docker container inspect --format '{{json .HostConfig.PortBindings}}' "$edge_container_id")"
[[ "$port_bindings" == '{"8443/tcp":[{"HostIp":"0.0.0.0","HostPort":"443"}]}' ]] \
  || die "The OIDC edge must publish only host TCP 443 to container 8443."

mapfile -t edge_mounts < <(docker container inspect --format \
  '{{range .Mounts}}{{println .Type "|" .Source "|" .Destination "|" .RW}}{{end}}' \
  "$edge_container_id" | awk 'NF { print }' | LC_ALL=C sort)
(( ${#edge_mounts[@]} == 4 )) || die "The OIDC edge has an unexpected mount set."
printf '%s\n' "${edge_mounts[@]}" | grep -Fxq \
  "bind | $A_HTTPS_OIDC_TEST_CADDYFILE | /etc/caddy/Caddyfile | false" \
  || die "The OIDC edge Caddyfile mount is invalid."
printf '%s\n' "${edge_mounts[@]}" | grep -Fxq \
  "bind | $A_HTTPS_OIDC_TEST_STATE_DIR/data | /data | true" \
  || die "The OIDC edge data mount is invalid."
printf '%s\n' "${edge_mounts[@]}" | grep -Fxq \
  "bind | $A_HTTPS_OIDC_TEST_STATE_DIR/config | /config | true" \
  || die "The OIDC edge config mount is invalid."
printf '%s\n' "${edge_mounts[@]}" | grep -Fxq \
  "bind | $A_HTTPS_OIDC_TEST_STATE_DIR/approval | /approval | false" \
  || die "The OIDC edge approval mount is invalid."
if printf '%s\n' "${edge_mounts[@]}" | grep -Fq /var/run/docker.sock; then
  die "The OIDC edge must never mount the Docker socket."
fi
edge_environment="$(docker container inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
  "$edge_container_id")"
if grep -Eq '^(POSTGRES_|SCIFORGE_COLLAB_DB_|SCIFORGE_COLLABORATION_DATABASE_URL|KC_DB_|KEYCLOAK_ADMIN)' <<< "$edge_environment"; then
  die "The A-owned OIDC edge contains a database or Keycloak administration secret variable."
fi

tcp_listeners="$(ss -H -ltn)"
[[ "$(awk '$4 ~ /:443$/ { count += 1 } END { print count + 0 }' <<< "$tcp_listeners")" == 1 \
    && "$(awk '$4 ~ /:80$/ { count += 1 } END { print count + 0 }' <<< "$tcp_listeners")" == 0 \
    && "$(ss -H -lun | awk '$4 ~ /:443$/ { count += 1 } END { print count + 0 }')" == 0 ]] \
  || die "The ECS listener boundary must expose one TCP 443 listener and no TCP 80 or UDP 443 listener."
assert_a_https_test_edge_backend_port_boundaries
published_443_count=0
for container_id in $(docker container ls -a --no-trunc -q); do
  candidate_bindings="$(docker container inspect --format '{{json .HostConfig.PortBindings}}' "$container_id")"
  if [[ "$candidate_bindings" == *'"HostPort":"443"'* ]]; then
    (( published_443_count += 1 ))
    [[ "$container_id" == "$edge_container_id" ]] \
      || die "A container other than the exact OIDC edge reserves host port 443."
  fi
done
[[ "$published_443_count" == 1 ]] || die "Exactly one Docker container must reserve host port 443."

cloud_url="https://$A_HTTPS_OIDC_TEST_HOSTNAME"
identity_url="https://$A_HTTPS_OIDC_TEST_IDENTITY_HOSTNAME"
discovery_url="$identity_url/realms/SciForge/.well-known/openid-configuration"
jwks_url="$identity_url/realms/SciForge/protocol/openid-connect/certs"
cloud_curl=(--disable --noproxy '*' --proto '=https' --silent --show-error --max-time 10 \
  --resolve "$A_HTTPS_OIDC_TEST_HOSTNAME:443:127.0.0.1")
identity_curl=(--disable --noproxy '*' --proto '=https' --silent --show-error --max-time 10 \
  --resolve "$A_HTTPS_OIDC_TEST_IDENTITY_HOSTNAME:443:127.0.0.1")

dual_sni_ready=false
for _ in $(seq 1 60); do
  cloud_status="$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
    "$cloud_url/healthz" 2>/dev/null || true)"
  discovery_status="$(curl "${identity_curl[@]}" --output /dev/null --write-out '%{http_code}' \
    "$discovery_url" 2>/dev/null || true)"
  if [[ "$cloud_status" == 200 && "$discovery_status" == 200 ]]; then
    dual_sni_ready=true
    break
  fi
  sleep 3
done
[[ "$dual_sni_ready" == true ]] \
  || die "Trusted dual-SNI HTTPS or exact Keycloak discovery did not become ready."

for hostname in "$A_HTTPS_OIDC_TEST_HOSTNAME" "$A_HTTPS_OIDC_TEST_IDENTITY_HOSTNAME"; do
  timeout 15 openssl s_client -connect 127.0.0.1:443 -servername "$hostname" \
    -verify_hostname "$hostname" -verify_return_error </dev/null 2>/dev/null \
    | openssl x509 -noout -checkend 259200 >/dev/null \
    || die "The HTTPS certificate chain, $hostname SAN, or remaining lifetime is invalid."
done
set +e
unknown_sni_output="$(timeout 15 openssl s_client -connect 127.0.0.1:443 \
  -servername unapproved.sciforge.cn -showcerts </dev/null 2>&1)"
unknown_sni_status=$?
set -e
if (( unknown_sni_status == 0 )) || grep -Fq -- '-----BEGIN CERTIFICATE-----' <<< "$unknown_sni_output"; then
  die "The strict-SNI OIDC edge served a certificate for an unapproved hostname."
fi

health_body="$(curl "${cloud_curl[@]}" --fail "$cloud_url/healthz")"
ready_body="$(curl "${cloud_curl[@]}" --fail "$cloud_url/readyz")"
[[ "$health_body" == '{"ok":true}' && "$ready_body" == '{"ok":true}' ]] \
  || die "The Cloud HTTPS health or readiness response is invalid."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' "$cloud_url/console/")" == 404 ]] \
  || die "The A-only console must remain unavailable on the OIDC edge."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' "$cloud_url/v1/me")" == 401 ]] \
  || die "An unauthenticated /v1/me request did not fail closed."

wss_status="$(curl "${cloud_curl[@]}" --http1.1 --output /dev/null --write-out '%{http_code}' \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --header "Origin: $A_HTTPS_OIDC_TEST_ORIGIN" "$cloud_url/v1/events")"
[[ "$wss_status" == 401 ]] || die "The unauthenticated OIDC-mode WSS boundary must return 401."
wrong_origin_status="$(curl "${cloud_curl[@]}" --http1.1 --output /dev/null --write-out '%{http_code}' \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --header 'Origin: https://example.invalid' "$cloud_url/v1/events")"
[[ "$wrong_origin_status" == 403 ]] || die "The OIDC-mode WSS edge accepted an unapproved Origin."

catalog_body="$(curl "${cloud_curl[@]}" --fail \
  --header 'content-type: application/json' \
  --data '{"protocolVersion":"1.0","requestId":"req_ahttpsoidccatalog0002","type":"endpoint.catalog.get"}' \
  "$cloud_url/v1/commands")"
printf '%s' "$catalog_body" | docker exec -i "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    try {
      const body = JSON.parse(input)
      if (body?.type !== "endpoint.catalog" || !Array.isArray(body.providers) || body.providers.length !== 0) process.exit(1)
    } catch { process.exit(1) }
  })
' || die "The public OIDC-mode Provider catalog is not exactly empty."

confirm_response="$(curl "${cloud_curl[@]}" \
  --header 'content-type: application/json' \
  --header 'idempotency-key: idem_a_oidc_confirm_disabled_0001' \
  --data '{"bindingCode":"SF-ABCDEFGH-JKLMNPQR","realmUrl":"https://chat.sciforge.cn","realmId":"a-oidc-gate","zulipUserId":"a-oidc-user","providerEventId":"a-oidc-event-0001","idempotencyKey":"idem_a_oidc_confirm_disabled_0001"}' \
  --write-out $'\n%{http_code}' "$cloud_url/v1/integrations/zulip/bindings/confirm")"
confirm_status="${confirm_response##*$'\n'}"
confirm_body="${confirm_response%$'\n'*}"
[[ "$confirm_status" == 401 ]] || die "Trusted Zulip binding confirm is not fail-closed with exact HTTP 401."
printf '%s' "$confirm_body" | docker exec -i "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    try {
      const body = JSON.parse(input)
      if (body?.error?.code !== "authentication_required") process.exit(1)
    } catch { process.exit(1) }
  })
' || die "Disabled binding confirm did not return the public authentication_required error."

for forbidden_path in / /admin/ /metrics /health /health/ready \
    /realms/master/.well-known/openid-configuration \
    /realms/sciforge/.well-known/openid-configuration \
    /REALMS/SciForge/.well-known/openid-configuration \
    /realms/SciForgeX/.well-known/openid-configuration \
    /realms/SciForge/%2e%2e/master/.well-known/openid-configuration; do
  [[ "$(curl "${identity_curl[@]}" --path-as-is --output /dev/null --write-out '%{http_code}' \
    "$identity_url$forbidden_path")" == 404 ]] \
    || die "login-test exposed a forbidden Keycloak path: $forbidden_path"
done
discovery_body="$(curl "${identity_curl[@]}" --fail "$discovery_url")"
printf '%s' "$discovery_body" | docker exec -i "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    try {
      const body = JSON.parse(input)
      const issuer = "https://login-test.sciforge.cn/realms/SciForge"
      const expected = {
        issuer,
        jwks_uri: `${issuer}/protocol/openid-connect/certs`,
        authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
        end_session_endpoint: `${issuer}/protocol/openid-connect/logout`
      }
      for (const [key, value] of Object.entries(expected)) if (body?.[key] !== value) process.exit(1)
      if (!Array.isArray(body.id_token_signing_alg_values_supported) ||
          !body.id_token_signing_alg_values_supported.includes("RS256")) process.exit(1)
    } catch { process.exit(1) }
  })
' || die "Keycloak Discovery does not publish the exact HTTPS issuer/endpoints and RS256 support."

jwks_body="$(curl "${identity_curl[@]}" --fail "$jwks_url")"
printf '%s' "$jwks_body" | docker exec -i "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    try {
      const body = JSON.parse(input)
      if (!Array.isArray(body?.keys) || body.keys.length === 0) process.exit(1)
      const signing = body.keys.filter((key) => key?.kty === "RSA" && key?.alg === "RS256" &&
        key?.use === "sig" && typeof key?.kid === "string" && key.kid.length > 0 &&
        typeof key?.n === "string" && key.n.length > 0 && typeof key?.e === "string" && key.e.length > 0)
      if (signing.length === 0 || new Set(signing.map((key) => key.kid)).size !== signing.length) process.exit(1)
    } catch { process.exit(1) }
  })
' || die "Keycloak JWKS has no unique usable RSA/RS256 signing key."

# Prove the actual Cloud network namespace can reach its configured public
# issuer without curl --resolve. This catches ECS hairpin/split-DNS failures
# before approving the edge; the real-token harness remains the signature/JIT
# acceptance gate.
docker exec -i "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" \
  node --input-type=module - "$expected_commit" <<'NODE'
const expectedCommit = process.argv[2]
const issuer = 'https://login-test.sciforge.cn/realms/SciForge'
const request = async (url) => {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json' }
  })
  if (response.status !== 200 || response.headers.get('x-sciforge-edge-revision') !== expectedCommit) {
    throw new Error('unexpected_identity_edge_response')
  }
  return response.json()
}
const discovery = await request(`${issuer}/.well-known/openid-configuration`)
if (discovery?.issuer !== issuer || discovery?.jwks_uri !== `${issuer}/protocol/openid-connect/certs`) {
  throw new Error('unexpected_discovery')
}
const jwks = await request(discovery.jwks_uri)
if (!Array.isArray(jwks?.keys) || !jwks.keys.some((key) =>
  key?.kty === 'RSA' && key?.alg === 'RS256' && key?.use === 'sig' && typeof key?.kid === 'string')) {
  throw new Error('unexpected_jwks')
}
NODE

cloud_headers="$(curl "${cloud_curl[@]}" --output /dev/null --dump-header - "$cloud_url/healthz")"
discovery_headers="$(curl "${identity_curl[@]}" --output /dev/null --dump-header - "$discovery_url")"
jwks_headers="$(curl "${identity_curl[@]}" --output /dev/null --dump-header - "$jwks_url")"
for headers in "$cloud_headers" "$discovery_headers" "$jwks_headers"; do
  grep -Eiq '^strict-transport-security: max-age=31536000' <<< "$headers" \
    || die "A dual-SNI response is missing HSTS."
  [[ "$(awk 'tolower($1) == "x-sciforge-edge-revision:" { gsub(/\r/, "", $2); print $2 }' <<< "$headers")" == "$expected_commit" ]] \
    || die "A dual-SNI response lacks the exact A edge revision."
  if grep -Eiq '^(server|alt-svc:.*h3):' <<< "$headers"; then
    die "The dual-SNI edge exposed a server banner or HTTP/3 advertisement."
  fi
done
grep -Eiq '^cache-control: no-store([[:space:]]|$)' <<< "$cloud_headers" \
  || die "The Cloud edge response is not marked no-store."
if grep -Eiq '^access-control-allow-origin:' <<< "$cloud_headers"; then
  die "The Cloud health response exposed an unsafe CORS header."
fi

[[ "$(a_https_oidc_test_app_snapshot)" == "$app_snapshot_before" ]] \
  || die "OIDC edge verification changed the SciForge Cloud app."
[[ "$(a_https_oidc_test_keycloak_snapshot)" == "$keycloak_snapshot_before" ]] \
  || die "A-owned ingress verification changed or restarted Keycloak."
echo "Local A HTTPS OIDC edge verification passed: dual-SNI TLS, exact Discovery/JWKS, empty Provider catalog, disabled confirm, strict realm path and port/network boundaries. Real-token acceptance remains a separate harness gate."
