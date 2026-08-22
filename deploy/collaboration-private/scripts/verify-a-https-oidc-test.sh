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

for command in awk chmod curl docker flock getent grep install mktemp openssl readlink rm seq sha256sum sleep sort ss stat tar timeout tr; do
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
portal_asset_file="$(mktemp)"
trap 'rm -f -- "$portal_asset_file"' EXIT
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
if grep -Eq '^(POSTGRES_|SCIFORGE_COLLAB_DB_|SCIFORGE_COLLABORATION_DATABASE_URL|SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET|KC_DB_|KEYCLOAK_ADMIN)' <<< "$edge_environment"; then
  die "The A-owned OIDC edge contains a database, Portal, or Keycloak administration secret variable."
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
portal_redirect_headers="$(curl "${cloud_curl[@]}" --output /dev/null --dump-header - \
  "$cloud_url/portal" | tr -d '\r')"
[[ "$(awk 'NR == 1 { print $2 }' <<< "$portal_redirect_headers")" == 308 ]] \
  || die "The fixed Portal entry did not return HTTP 308."
grep -Fxiq 'location: /portal/' <<< "$portal_redirect_headers" \
  || die "The fixed Portal entry did not return the exact relative /portal/ location."
portal_body="$(curl "${cloud_curl[@]}" --fail "$cloud_url/portal/")"
grep -Fq '<title>SciForge Collaboration Portal</title>' <<< "$portal_body" \
  || die "The fixed Portal HTML entry is unavailable."
if grep -Eiq '(access_token|refresh_token|client_secret|SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET)' \
    <<< "$portal_body"; then
  die "The public Portal HTML contains a credential marker."
fi
portal_headers="$(curl "${cloud_curl[@]}" --head --dump-header - --output /dev/null \
  "$cloud_url/portal/" | tr -d '\r')"
[[ "$(awk -F': ' 'tolower($1) == "content-security-policy" { print $2 }' \
  <<< "$portal_headers")" == "$A_CLOUD_PORTAL_CSP" ]] \
  || die "The Portal HTML lacks the fixed executable CSP."
[[ "$(awk -F': ' 'tolower($1) == "cache-control" { print $2 }' \
  <<< "$portal_headers")" == no-store ]] \
  || die "The Portal HTML is not uniquely marked no-store."
grep -Fxiq 'x-sciforge-portal-mode: confidential-bff' <<< "$portal_headers" \
  || die "The Portal entry lacks the fixed confidential-BFF mode marker."
grep -Fxiq "x-sciforge-edge-revision: $expected_commit" <<< "$portal_headers" \
  || die "The Portal entry lacks the exact A edge revision."
grep -Fxiq 'strict-transport-security: max-age=31536000; includeSubDomains' <<< "$portal_headers" \
  || die "The Portal HTML lacks the exact HSTS boundary."
grep -Fxiq 'referrer-policy: no-referrer' <<< "$portal_headers" \
  || die "The Portal HTML lacks the no-referrer boundary."
grep -Fxiq 'x-content-type-options: nosniff' <<< "$portal_headers" \
  || die "The Portal HTML lacks the nosniff boundary."
grep -Fxiq 'x-frame-options: DENY' <<< "$portal_headers" \
  || die "The Portal HTML lacks frame denial."
if grep -Eiq '^(set-cookie|access-control-allow-origin):' <<< "$portal_headers"; then
  die "The anonymous Portal HTML emitted a cookie or CORS grant."
fi
if grep -Eiq '^(server|alt-svc:.*h3):' <<< "$portal_headers"; then
  die "The Portal HTML exposed a server banner or HTTP/3 advertisement."
fi
portal_asset_descriptor="$(docker exec "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" node -e '
  const { readFileSync } = require("node:fs")
  const manifest = JSON.parse(readFileSync("/app/RELEASE_MANIFEST.json", "utf8"))
  const asset = manifest.portalAssets?.find((entry) => entry?.path !== "index.html")
  if (manifest.schemaVersion !== 4 || manifest.portalMode !== "confidential-bff" ||
      !asset || !/^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(asset.path) ||
      !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 ||
      !/^[0-9a-f]{64}$/.test(asset.sha256)) process.exit(1)
  process.stdout.write(`${asset.path}\t${asset.bytes}\t${asset.sha256}`)
')" || die "Could not select one manifest-bound Portal runtime asset."
IFS=$'\t' read -r portal_asset_path portal_asset_bytes portal_asset_sha portal_asset_extra \
  <<< "$portal_asset_descriptor"
[[ "$portal_asset_path" =~ ^assets/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$ \
    && "$portal_asset_bytes" =~ ^[1-9][0-9]*$ \
    && "$portal_asset_sha" =~ ^[0-9a-f]{64}$ \
    && -z "${portal_asset_extra:-}" ]] \
  || die "The fixed Portal runtime asset descriptor is invalid."
portal_asset_headers="$(curl "${cloud_curl[@]}" --output "$portal_asset_file" --dump-header - \
  "$cloud_url/portal/$portal_asset_path" | tr -d '\r')"
[[ "$(awk 'NR == 1 { print $2 }' <<< "$portal_asset_headers")" == 200 ]] \
  || die "The manifest-bound Portal runtime asset is not publicly reachable."
[[ "$(stat -c '%s' "$portal_asset_file")" == "$portal_asset_bytes" \
    && "$(sha256sum "$portal_asset_file" | awk '{print $1}')" == "$portal_asset_sha" ]] \
  || die "The public Portal runtime asset does not match its fixed bytes and SHA-256."
[[ "$(awk -F': ' 'tolower($1) == "cache-control" { print $2 }' <<< "$portal_asset_headers")" == \
      'public, max-age=31536000, immutable' ]] \
  || die "The manifest-bound Portal runtime asset is not uniquely immutable-cacheable."
[[ "$(awk -F': ' 'tolower($1) == "etag" { print $2 }' <<< "$portal_asset_headers")" == \
      "\"$portal_asset_sha\"" ]] \
  || die "The manifest-bound Portal runtime asset lacks its digest ETag."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --header "If-None-Match: \"$portal_asset_sha\"" \
  "$cloud_url/portal/$portal_asset_path")" == 304 ]] \
  || die "The Portal runtime asset did not honor its exact ETag with HTTP 304."
for portal_private_path in /portal/ASSET_INTEGRITY.json /portal/.vite/manifest.json \
    /portal/not-a-release-asset; do
  [[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
    "$cloud_url$portal_private_path")" == 404 ]] \
    || die "The Portal exposed an internal or unbound path: $portal_private_path"
done
portal_session_response="$(curl "${cloud_curl[@]}" \
  --header 'Sec-Fetch-Site: same-origin' --header 'Sec-Fetch-Mode: cors' \
  --write-out $'\n%{http_code}' "$cloud_url/portal/api/session")"
portal_session_status="${portal_session_response##*$'\n'}"
portal_session_body="${portal_session_response%$'\n'*}"
[[ "$portal_session_status" == 401 ]] \
  || die "The anonymous Portal session endpoint did not fail closed with HTTP 401."
printf '%s' "$portal_session_body" | docker exec -i "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    try {
      const body = JSON.parse(input)
      if (body?.schemaVersion !== 1 || body?.type !== "portal.error" ||
          body?.error?.code !== "portal_authentication_required") process.exit(1)
    } catch { process.exit(1) }
  })
' || die "The anonymous Portal session endpoint returned an invalid error contract."
portal_session_headers="$(curl "${cloud_curl[@]}" --output /dev/null --dump-header - \
  --header 'Sec-Fetch-Site: same-origin' --header 'Sec-Fetch-Mode: cors' \
  "$cloud_url/portal/api/session" | tr -d '\r')"
[[ "$(awk -F': ' 'tolower($1) == "cache-control" { print $2 }' \
  <<< "$portal_session_headers")" == no-store \
    && "$(awk -F': ' 'tolower($1) == "content-security-policy" { print $2 }' \
      <<< "$portal_session_headers")" == "$A_CLOUD_PORTAL_CSP" ]] \
  || die "The Portal session rejection lacks its unique no-store/CSP boundary."
grep -Fxiq 'www-authenticate: Portal' <<< "$portal_session_headers" \
  || die "The anonymous Portal session rejection lacks WWW-Authenticate: Portal."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --header 'Sec-Fetch-Site: cross-site' --header 'Sec-Fetch-Mode: cors' \
  "$cloud_url/portal/api/session")" == 403 ]] \
  || die "The Portal session endpoint accepted cross-site Fetch Metadata."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' --data '{}' \
  "$cloud_url/portal/api/commands")" == 404 ]] \
  || die "The removed raw Portal command relay is not a fixed HTTP 404 tombstone."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --header 'Sec-Fetch-Site: same-origin' --header 'Sec-Fetch-Mode: cors' \
  "$cloud_url/portal/api/projects")" == 401 ]] \
  || die "The anonymous typed Portal project view did not return HTTP 401."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' \
  --header "Origin: $A_HTTPS_OIDC_TEST_ORIGIN" --header 'Sec-Fetch-Site: same-origin' \
  --header 'Sec-Fetch-Mode: cors' --header 'Sec-Fetch-Dest: empty' --data '{}' \
  "$cloud_url/portal/api/projects")" == 401 ]] \
  || die "The anonymous typed Portal project mutation did not return HTTP 401."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' \
  --header 'Origin: https://example.invalid' --header 'Sec-Fetch-Site: cross-site' \
  --header 'Sec-Fetch-Mode: cors' --header 'Sec-Fetch-Dest: empty' --data '{}' \
  "$cloud_url/portal/api/projects")" == 403 ]] \
  || die "The typed Portal project mutation accepted a cross-site write."
portal_logout_headers="$(curl "${cloud_curl[@]}" --output /dev/null --dump-header - \
  --request POST --header "Origin: $A_HTTPS_OIDC_TEST_ORIGIN" \
  --header 'Sec-Fetch-Site: same-origin' --header 'Sec-Fetch-Mode: cors' \
  --header 'Sec-Fetch-Dest: empty' "$cloud_url/portal/auth/logout" | tr -d '\r')"
[[ "$(awk 'NR == 1 { print $2 }' <<< "$portal_logout_headers")" == 204 ]] \
  || die "The anonymous Portal logout boundary did not return HTTP 204."
grep -Fxiq 'set-cookie: __Host-sciforge-portal=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict' \
  <<< "$portal_logout_headers" \
  || die "Portal logout did not clear the host-only strict session cookie."
grep -Fxiq 'set-cookie: __Host-sciforge-portal-login=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax' \
  <<< "$portal_logout_headers" \
  || die "Portal logout did not clear the host-only login cookie."
portal_http_events="$(curl "${cloud_curl[@]}" --write-out $'\n%{http_code}' \
  "$cloud_url/portal/events")"
portal_http_events_status="${portal_http_events##*$'\n'}"
portal_http_events_body="${portal_http_events%$'\n'*}"
[[ "$portal_http_events_status" == 426 ]] \
  || die "The Portal event endpoint did not require a WebSocket upgrade."
printf '%s' "$portal_http_events_body" | docker exec -i "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    try {
      const body = JSON.parse(input)
      if (body?.schemaVersion !== 1 || body?.type !== "portal.websocket_required") process.exit(1)
    } catch { process.exit(1) }
  })
' || die "The Portal event upgrade response is invalid."
portal_http_event_headers="$(curl "${cloud_curl[@]}" --output /dev/null --dump-header - \
  "$cloud_url/portal/events" | tr -d '\r')"
grep -Fxiq 'upgrade: websocket' <<< "$portal_http_event_headers" \
  || die "The Portal HTTP event response lacks Upgrade: websocket."
portal_wss_status="$(curl "${cloud_curl[@]}" --http1.1 --output /dev/null --write-out '%{http_code}' \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --header 'Sec-WebSocket-Protocol: sciforge.portal.v1' \
  --header "Origin: $A_HTTPS_OIDC_TEST_ORIGIN" "$cloud_url/portal/events")"
[[ "$portal_wss_status" == 401 ]] \
  || die "The anonymous Portal WebSocket boundary did not fail closed with HTTP 401."
portal_wrong_origin_status="$(curl "${cloud_curl[@]}" --http1.1 --output /dev/null --write-out '%{http_code}' \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --header 'Sec-WebSocket-Protocol: sciforge.portal.v1' \
  --header 'Origin: https://example.invalid' "$cloud_url/portal/events")"
[[ "$portal_wrong_origin_status" == 403 ]] \
  || die "The Portal WebSocket boundary accepted an unapproved Origin."
portal_login_headers="$(curl "${cloud_curl[@]}" --output /dev/null --dump-header - \
  --header 'X-Forwarded-For: 198.51.100.10, 127.0.0.1' \
  "$cloud_url/portal/auth/login" | tr -d '\r')"
[[ "$(awk 'NR == 1 { print $2 }' <<< "$portal_login_headers")" == 302 ]] \
  || die "The Portal login endpoint did not start an OIDC redirect after edge X-Forwarded-For canonicalization."
[[ "$(awk -F': ' 'tolower($1) == "cache-control" { print $2 }' \
  <<< "$portal_login_headers")" == no-store \
    && "$(awk -F': ' 'tolower($1) == "content-security-policy" { print $2 }' \
      <<< "$portal_login_headers")" == "$A_CLOUD_PORTAL_CSP" ]] \
  || die "The Portal login redirect lacks its unique no-store/CSP boundary."
grep -Eiq '^set-cookie: __Host-sciforge-portal-login=[A-Za-z0-9_-]{43}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax$' \
  <<< "$portal_login_headers" \
  || die "The Portal login transaction cookie lacks the fixed host-only protections."
portal_login_cookie="$(awk -F';' 'tolower($1) ~ /^set-cookie: __host-sciforge-portal-login=/ {
  sub(/^[^:]+:[[:space:]]*/, "", $1); print $1
}' <<< "$portal_login_headers")"
[[ "$portal_login_cookie" =~ ^__Host-sciforge-portal-login=[A-Za-z0-9_-]{43}$ ]] \
  || die "The Portal login transaction cookie could not be isolated safely."
portal_login_location="$(awk 'tolower($1) == "location:" { print substr($0, index($0, " ") + 1) }' \
  <<< "$portal_login_headers")"
printf '%s' "$portal_login_location" | docker exec -i "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    try {
      const value = new URL(input)
      const expectedKeys = ["client_id", "code_challenge", "code_challenge_method", "nonce",
        "redirect_uri", "response_type", "scope", "state"]
      const keys = [...value.searchParams.keys()].sort()
      if (value.origin !== "https://login-test.sciforge.cn" ||
          value.pathname !== "/realms/SciForge/protocol/openid-connect/auth" ||
          JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
          value.searchParams.get("response_type") !== "code" ||
          value.searchParams.get("client_id") !== "sciforge-cloud-console" ||
          value.searchParams.get("redirect_uri") !== "https://cloud-test.sciforge.cn/portal/auth/callback" ||
          value.searchParams.get("scope") !== "openid profile" ||
          value.searchParams.get("code_challenge_method") !== "S256" ||
          !/^[A-Za-z0-9_-]{43}$/.test(value.searchParams.get("code_challenge") ?? "") ||
          !/^[A-Za-z0-9_-]{43}$/.test(value.searchParams.get("state") ?? "") ||
          !/^[A-Za-z0-9_-]{43}$/.test(value.searchParams.get("nonce") ?? "")) process.exit(1)
    } catch { process.exit(1) }
  })
' || die "The Portal login redirect does not retain the exact confidential-client PKCE contract."
portal_callback_response="$(curl "${cloud_curl[@]}" --header "Cookie: $portal_login_cookie" \
  --write-out $'\n%{http_code}' \
  "$cloud_url/portal/auth/callback?code=invalid&state=invalid")"
portal_callback_status="${portal_callback_response##*$'\n'}"
portal_callback_body="${portal_callback_response%$'\n'*}"
portal_callback_replay_status="$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --header "Cookie: $portal_login_cookie" \
  "$cloud_url/portal/auth/callback?code=invalid&state=invalid")"
unset portal_login_cookie portal_login_headers
[[ "$portal_callback_status" == 401 ]] \
  || die "The Portal callback accepted the wrong state for a one-time login transaction."
[[ "$portal_callback_replay_status" == 401 ]] \
  || die "The Portal callback replay did not remain fail-closed after consuming the transaction."
printf '%s' "$portal_callback_body" | docker exec -i "$A_HTTPS_OIDC_TEST_APP_CONTAINER_ID" node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    try { if (JSON.parse(input)?.error?.code !== "portal_login_rejected") process.exit(1) }
    catch { process.exit(1) }
  })
' || die "The Portal rejected-login response is invalid."
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
        revocation_endpoint: `${issuer}/protocol/openid-connect/revoke`
      }
      for (const [key, value] of Object.entries(expected)) if (body?.[key] !== value) process.exit(1)
      if (!Array.isArray(body.id_token_signing_alg_values_supported) ||
          !body.id_token_signing_alg_values_supported.includes("RS256") ||
          !Array.isArray(body.code_challenge_methods_supported) ||
          !body.code_challenge_methods_supported.includes("S256")) process.exit(1)
    } catch { process.exit(1) }
  })
' || die "Keycloak Discovery does not publish the exact HTTPS issuer/token/revocation endpoints and RS256/S256 support."

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
echo "Local A HTTPS OIDC edge verification passed: dual-SNI TLS, exact Discovery/JWKS, fixed Portal asset/BFF pre-auth boundaries, empty Provider catalog, disabled confirm, strict realm path and port/network boundaries. Real browser login and real-token acceptance remain separate maintenance-window gates."
