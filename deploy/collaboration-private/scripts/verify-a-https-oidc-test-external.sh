#!/usr/bin/env bash

set -euo pipefail

cloud_hostname=cloud-test.sciforge.cn
identity_hostname=login-test.sciforge.cn
expected_ipv4=47.76.230.118
expected_issuer=https://login-test.sciforge.cn/realms/SciForge
portal_csp="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; manifest-src 'none'"
expected_commit="${1:-}"
expected_script_sha256="${2:-}"
cloud_url="https://$cloud_hostname"
identity_url="https://$identity_hostname"
discovery_url="$expected_issuer/.well-known/openid-configuration"
jwks_url="$expected_issuer/protocol/openid-connect/certs"
cloud_curl=(--disable --noproxy '*' --proto '=https' --silent --show-error --max-time 10 \
  --resolve "$cloud_hostname:443:$expected_ipv4")
identity_curl=(--disable --noproxy '*' --proto '=https' --silent --show-error --max-time 10 \
  --resolve "$identity_hostname:443:$expected_ipv4")

die() {
  echo "ERROR: $*" >&2
  exit 1
}

for command in awk curl dirname grep mktemp node rm tr; do
  command -v "$command" >/dev/null 2>&1 || die "Required command is unavailable: $command"
done
for unsafe_probe_variable in CURL_CA_BUNDLE NODE_EXTRA_CA_CERTS NODE_OPTIONS NODE_PATH \
    NODE_TLS_REJECT_UNAUTHORIZED OPENSSL_CONF OPENSSL_MODULES SSL_CERT_DIR SSL_CERT_FILE; do
  [[ -z "${!unsafe_probe_variable:-}" ]] \
    || die "Probe environment variable $unsafe_probe_variable is forbidden."
done
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ && "$expected_script_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || die "Usage: verify-a-https-oidc-test-external.sh <approved-40-character-commit> <manifest-script-sha256>"
[[ -f "$0" && ! -L "$0" ]] \
  || die "The external OIDC verifier must be a regular, non-symlink file from the fixed release."
actual_script_sha256="$(node -e '
  const { createHash } = require("node:crypto")
  const { readFileSync } = require("node:fs")
  process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))
' "$0")"
[[ "$actual_script_sha256" == "$expected_script_sha256" ]] \
  || die "The external OIDC verifier does not match the fixed release manifest."
portal_manifest="$(cd "$(dirname "$0")/.." && pwd -P)/bundle/RELEASE_MANIFEST.json"
[[ -f "$portal_manifest" && ! -L "$portal_manifest" ]] \
  || die "The external Portal verifier cannot locate its fixed release manifest."
portal_asset_file="$(mktemp)"
trap 'rm -f -- "$portal_asset_file"' EXIT

verify_public_dns() {
  local aaaa_status
  local hostname="$1"
  local resolved_ipv4

  resolved_ipv4="$(node -e '
    const dns = require("node:dns").promises
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("dns_timeout"), { code: "ETIMEOUT" })), 10000)
      timer.unref()
    })
    Promise.race([dns.resolve4(process.argv[1]), timeout]).then((addresses) => {
      process.stdout.write([...new Set(addresses)].sort().join("\n"))
    }).catch(() => process.exit(1))
  ' "$hostname")" || die "Could not resolve $hostname from the independent public network."
  [[ "$resolved_ipv4" == "$expected_ipv4" ]] \
    || die "$hostname does not resolve only to the approved ECS IPv4 address."

  set +e
  node -e '
    const dns = require("node:dns").promises
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("dns_timeout"), { code: "ETIMEOUT" })), 10000)
      timer.unref()
    })
    Promise.race([dns.resolve6(process.argv[1]), timeout]).then((addresses) => process.exit(addresses.length > 0 ? 2 : 0)).catch((error) => {
      process.exit(error?.code === "ENODATA" || error?.code === "ENOTFOUND" ? 0 : 1)
    })
  ' "$hostname"
  aaaa_status=$?
  set -e
  [[ "$aaaa_status" != 2 ]] || die "$hostname unexpectedly has an AAAA record."
  [[ "$aaaa_status" == 0 ]] || die "The public AAAA query for $hostname failed."
}

for hostname in "$cloud_hostname" "$identity_hostname"; do
  verify_public_dns "$hostname"
  node -e '
    const tls = require("node:tls")
    const socket = tls.connect({
      host: process.argv[1], port: 443, servername: process.argv[2], rejectUnauthorized: true
    })
    const timer = setTimeout(() => socket.destroy(new Error("tls_timeout")), 10000)
    socket.once("secureConnect", () => {
      clearTimeout(timer)
      const certificate = socket.getPeerCertificate()
      const remainingMs = Date.parse(certificate.valid_to) - Date.now()
      socket.end()
      process.exit(remainingMs >= 259200000 ? 0 : 1)
    })
    socket.once("error", () => { clearTimeout(timer); process.exit(1) })
  ' "$expected_ipv4" "$hostname" \
    || die "The public certificate chain, $hostname SAN, or remaining lifetime is invalid."
done
node -e '
  const tls = require("node:tls")
  const socket = tls.connect({
    host: process.argv[1], port: 443, servername: "unapproved.sciforge.cn", rejectUnauthorized: false
  })
  const timer = setTimeout(() => { socket.destroy(); process.exit(0) }, 10000)
  socket.once("secureConnect", () => { clearTimeout(timer); socket.destroy(); process.exit(1) })
  socket.once("error", () => { clearTimeout(timer); process.exit(0) })
' "$expected_ipv4" || die "The public edge served TLS for an unapproved SNI hostname."

health_body="$(curl "${cloud_curl[@]}" --fail "$cloud_url/healthz")"
ready_body="$(curl "${cloud_curl[@]}" --fail "$cloud_url/readyz")"
[[ "$health_body" == '{"ok":true}' && "$ready_body" == '{"ok":true}' ]] \
  || die "The public Cloud health or readiness response is invalid."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' "$cloud_url/console/")" == 404 ]] \
  || die "The public OIDC edge exposed the A-only console."
portal_redirect_headers="$(curl "${cloud_curl[@]}" --output /dev/null --dump-header - \
  "$cloud_url/portal" | tr -d '\r')"
[[ "$(awk 'NR == 1 { print $2 }' <<< "$portal_redirect_headers")" == 308 ]] \
  || die "The public Portal entry did not return HTTP 308."
grep -Fxiq 'location: /portal/' <<< "$portal_redirect_headers" \
  || die "The public Portal entry did not return the exact relative /portal/ location."
portal_body="$(curl "${cloud_curl[@]}" --fail "$cloud_url/portal/")"
grep -Fq '<title>SciForge Collaboration Portal</title>' <<< "$portal_body" \
  || die "The public fixed Portal HTML entry is unavailable."
if grep -Eiq '(access_token|refresh_token|client_secret|SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET)' \
    <<< "$portal_body"; then
  die "The public Portal HTML contains a credential marker."
fi
portal_headers="$(curl "${cloud_curl[@]}" --head --dump-header - --output /dev/null \
  "$cloud_url/portal/" | tr -d '\r')"
[[ "$(awk -F': ' 'tolower($1) == "content-security-policy" { print $2 }' \
  <<< "$portal_headers")" == "$portal_csp" ]] \
  || die "The public Portal HTML lacks the fixed executable CSP."
[[ "$(awk -F': ' 'tolower($1) == "cache-control" { print $2 }' \
  <<< "$portal_headers")" == no-store ]] \
  || die "The public Portal HTML is not uniquely marked no-store."
grep -Fxiq 'x-sciforge-portal-mode: confidential-bff' <<< "$portal_headers" \
  || die "The public Portal entry lacks the confidential-BFF mode marker."
grep -Fxiq "x-sciforge-edge-revision: $expected_commit" <<< "$portal_headers" \
  || die "The public Portal entry lacks the exact A edge revision."
grep -Fxiq 'strict-transport-security: max-age=31536000; includeSubDomains' <<< "$portal_headers" \
  || die "The public Portal HTML lacks the exact HSTS boundary."
grep -Fxiq 'referrer-policy: no-referrer' <<< "$portal_headers" \
  || die "The public Portal HTML lacks the no-referrer boundary."
grep -Fxiq 'x-content-type-options: nosniff' <<< "$portal_headers" \
  || die "The public Portal HTML lacks the nosniff boundary."
grep -Fxiq 'x-frame-options: DENY' <<< "$portal_headers" \
  || die "The public Portal HTML lacks frame denial."
if grep -Eiq '^(set-cookie|access-control-allow-origin):' <<< "$portal_headers"; then
  die "The anonymous public Portal HTML emitted a cookie or CORS grant."
fi
if grep -Eiq '^(server|alt-svc:.*h3):' <<< "$portal_headers"; then
  die "The public Portal HTML exposed a server banner or HTTP/3 advertisement."
fi
portal_asset_descriptor="$(node -e '
  const { readFileSync } = require("node:fs")
  const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"))
  const asset = manifest.portalAssets?.find((entry) => entry?.path !== "index.html")
  if (manifest.schemaVersion !== 4 || manifest.releaseMode !== "a-https-oidc-test" ||
      manifest.contractCommit !== process.argv[2] || manifest.portalMode !== "confidential-bff" ||
      !asset || !/^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(asset.path) ||
      !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 ||
      !/^[0-9a-f]{64}$/.test(asset.sha256)) process.exit(1)
  process.stdout.write(`${asset.path}\t${asset.bytes}\t${asset.sha256}`)
' "$portal_manifest" "$expected_commit")" \
  || die "Could not select one externally verifiable manifest-bound Portal asset."
IFS=$'\t' read -r portal_asset_path portal_asset_bytes portal_asset_sha portal_asset_extra \
  <<< "$portal_asset_descriptor"
[[ "$portal_asset_path" =~ ^assets/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$ \
    && "$portal_asset_bytes" =~ ^[1-9][0-9]*$ \
    && "$portal_asset_sha" =~ ^[0-9a-f]{64}$ \
    && -z "${portal_asset_extra:-}" ]] \
  || die "The external Portal asset descriptor is invalid."
portal_asset_headers="$(curl "${cloud_curl[@]}" --output "$portal_asset_file" --dump-header - \
  "$cloud_url/portal/$portal_asset_path" | tr -d '\r')"
[[ "$(awk 'NR == 1 { print $2 }' <<< "$portal_asset_headers")" == 200 ]] \
  || die "The manifest-bound public Portal asset is not reachable."
node -e '
  const { createHash } = require("node:crypto")
  const { readFileSync } = require("node:fs")
  const body = readFileSync(process.argv[1])
  const expectedBytes = Number(process.argv[2])
  const expectedSha256 = process.argv[3]
  if (!Number.isSafeInteger(expectedBytes) || body.length !== expectedBytes ||
      createHash("sha256").update(body).digest("hex") !== expectedSha256) process.exit(1)
' "$portal_asset_file" "$portal_asset_bytes" "$portal_asset_sha" \
  || die "The public Portal asset does not match the fixed manifest bytes and SHA-256."
[[ "$(awk -F': ' 'tolower($1) == "cache-control" { print $2 }' <<< "$portal_asset_headers")" == \
      'public, max-age=31536000, immutable' ]] \
  || die "The public manifest-bound Portal asset is not uniquely immutable-cacheable."
[[ "$(awk -F': ' 'tolower($1) == "etag" { print $2 }' <<< "$portal_asset_headers")" == \
      "\"$portal_asset_sha\"" ]] \
  || die "The public manifest-bound Portal asset lacks its digest ETag."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --header "If-None-Match: \"$portal_asset_sha\"" \
  "$cloud_url/portal/$portal_asset_path")" == 304 ]] \
  || die "The public Portal asset did not honor its exact ETag with HTTP 304."
for portal_private_path in /portal/ASSET_INTEGRITY.json /portal/.vite/manifest.json \
    /portal/not-a-release-asset; do
  [[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
    "$cloud_url$portal_private_path")" == 404 ]] \
    || die "The public Portal exposed an internal or unbound path: $portal_private_path"
done
portal_session_response="$(curl "${cloud_curl[@]}" \
  --header 'Sec-Fetch-Site: same-origin' --header 'Sec-Fetch-Mode: cors' \
  --write-out $'\n%{http_code}' "$cloud_url/portal/api/session")"
portal_session_status="${portal_session_response##*$'\n'}"
portal_session_body="${portal_session_response%$'\n'*}"
[[ "$portal_session_status" == 401 ]] \
  || die "The anonymous public Portal session endpoint did not fail closed with HTTP 401."
printf '%s' "$portal_session_body" | node -e '
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
' || die "The anonymous public Portal session endpoint returned an invalid error contract."
portal_session_headers="$(curl "${cloud_curl[@]}" --output /dev/null --dump-header - \
  --header 'Sec-Fetch-Site: same-origin' --header 'Sec-Fetch-Mode: cors' \
  "$cloud_url/portal/api/session" | tr -d '\r')"
[[ "$(awk -F': ' 'tolower($1) == "cache-control" { print $2 }' \
  <<< "$portal_session_headers")" == no-store \
    && "$(awk -F': ' 'tolower($1) == "content-security-policy" { print $2 }' \
      <<< "$portal_session_headers")" == "$portal_csp" ]] \
  || die "The public Portal session rejection lacks its unique no-store/CSP boundary."
grep -Fxiq 'www-authenticate: Portal' <<< "$portal_session_headers" \
  || die "The anonymous public Portal session rejection lacks WWW-Authenticate: Portal."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --header 'Sec-Fetch-Site: cross-site' --header 'Sec-Fetch-Mode: cors' \
  "$cloud_url/portal/api/session")" == 403 ]] \
  || die "The public Portal session endpoint accepted cross-site Fetch Metadata."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' --data '{}' \
  "$cloud_url/portal/api/commands")" == 404 ]] \
  || die "The removed public raw Portal command relay is not a fixed HTTP 404 tombstone."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --header 'Sec-Fetch-Site: same-origin' --header 'Sec-Fetch-Mode: cors' \
  "$cloud_url/portal/api/projects")" == 401 ]] \
  || die "The anonymous public typed Portal project view did not return HTTP 401."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' \
  --header "Origin: $cloud_url" --header 'Sec-Fetch-Site: same-origin' \
  --header 'Sec-Fetch-Mode: cors' --header 'Sec-Fetch-Dest: empty' --data '{}' \
  "$cloud_url/portal/api/projects")" == 401 ]] \
  || die "The anonymous public typed Portal project mutation did not return HTTP 401."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' \
  --header 'Origin: https://example.invalid' --header 'Sec-Fetch-Site: cross-site' \
  --header 'Sec-Fetch-Mode: cors' --header 'Sec-Fetch-Dest: empty' --data '{}' \
  "$cloud_url/portal/api/projects")" == 403 ]] \
  || die "The public typed Portal project mutation accepted a cross-site write."
portal_logout_headers="$(curl "${cloud_curl[@]}" --output /dev/null --dump-header - \
  --request POST --header "Origin: $cloud_url" --header 'Sec-Fetch-Site: same-origin' \
  --header 'Sec-Fetch-Mode: cors' --header 'Sec-Fetch-Dest: empty' \
  "$cloud_url/portal/auth/logout" | tr -d '\r')"
[[ "$(awk 'NR == 1 { print $2 }' <<< "$portal_logout_headers")" == 204 ]] \
  || die "The anonymous public Portal logout boundary did not return HTTP 204."
grep -Fxiq 'set-cookie: __Host-sciforge-portal=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict' \
  <<< "$portal_logout_headers" \
  || die "Public Portal logout did not clear the host-only strict session cookie."
grep -Fxiq 'set-cookie: __Host-sciforge-portal-login=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax' \
  <<< "$portal_logout_headers" \
  || die "Public Portal logout did not clear the host-only login cookie."
portal_http_events="$(curl "${cloud_curl[@]}" --write-out $'\n%{http_code}' \
  "$cloud_url/portal/events")"
portal_http_events_status="${portal_http_events##*$'\n'}"
portal_http_events_body="${portal_http_events%$'\n'*}"
[[ "$portal_http_events_status" == 426 ]] \
  || die "The public Portal event endpoint did not require a WebSocket upgrade."
printf '%s' "$portal_http_events_body" | node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    try {
      const body = JSON.parse(input)
      if (body?.schemaVersion !== 1 || body?.type !== "portal.websocket_required") process.exit(1)
    } catch { process.exit(1) }
  })
' || die "The public Portal event upgrade response is invalid."
portal_http_event_headers="$(curl "${cloud_curl[@]}" --output /dev/null --dump-header - \
  "$cloud_url/portal/events" | tr -d '\r')"
grep -Fxiq 'upgrade: websocket' <<< "$portal_http_event_headers" \
  || die "The public Portal HTTP event response lacks Upgrade: websocket."
portal_wss_status="$(curl "${cloud_curl[@]}" --http1.1 --output /dev/null --write-out '%{http_code}' \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --header 'Sec-WebSocket-Protocol: sciforge.portal.v1' \
  --header "Origin: $cloud_url" "$cloud_url/portal/events")"
[[ "$portal_wss_status" == 401 ]] \
  || die "The anonymous public Portal WebSocket boundary did not fail closed with HTTP 401."
portal_wrong_origin_status="$(curl "${cloud_curl[@]}" --http1.1 --output /dev/null --write-out '%{http_code}' \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --header 'Sec-WebSocket-Protocol: sciforge.portal.v1' \
  --header 'Origin: https://example.invalid' "$cloud_url/portal/events")"
[[ "$portal_wrong_origin_status" == 403 ]] \
  || die "The public Portal WebSocket boundary accepted an unapproved Origin."
portal_login_headers="$(curl "${cloud_curl[@]}" --output /dev/null --dump-header - \
  "$cloud_url/portal/auth/login" | tr -d '\r')"
[[ "$(awk 'NR == 1 { print $2 }' <<< "$portal_login_headers")" == 302 ]] \
  || die "The public Portal login endpoint did not start an OIDC redirect."
[[ "$(awk -F': ' 'tolower($1) == "cache-control" { print $2 }' \
  <<< "$portal_login_headers")" == no-store \
    && "$(awk -F': ' 'tolower($1) == "content-security-policy" { print $2 }' \
      <<< "$portal_login_headers")" == "$portal_csp" ]] \
  || die "The public Portal login redirect lacks its unique no-store/CSP boundary."
grep -Eiq '^set-cookie: __Host-sciforge-portal-login=[A-Za-z0-9_-]{43}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax$' \
  <<< "$portal_login_headers" \
  || die "The public Portal login transaction cookie lacks the fixed host-only protections."
portal_login_cookie="$(awk -F';' 'tolower($1) ~ /^set-cookie: __host-sciforge-portal-login=/ {
  sub(/^[^:]+:[[:space:]]*/, "", $1); print $1
}' <<< "$portal_login_headers")"
[[ "$portal_login_cookie" =~ ^__Host-sciforge-portal-login=[A-Za-z0-9_-]{43}$ ]] \
  || die "The public Portal login transaction cookie could not be isolated safely."
portal_login_location="$(awk 'tolower($1) == "location:" { print substr($0, index($0, " ") + 1) }' \
  <<< "$portal_login_headers")"
printf '%s' "$portal_login_location" | node -e '
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
' || die "The public Portal login redirect does not retain the exact confidential-client PKCE contract."
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
  || die "The public Portal callback accepted the wrong state for a one-time login transaction."
[[ "$portal_callback_replay_status" == 401 ]] \
  || die "The public Portal callback replay did not remain fail-closed after consuming the transaction."
printf '%s' "$portal_callback_body" | node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    try { if (JSON.parse(input)?.error?.code !== "portal_login_rejected") process.exit(1) }
    catch { process.exit(1) }
  })
' || die "The public Portal rejected-login response is invalid."
[[ "$(curl "${cloud_curl[@]}" --output /dev/null --write-out '%{http_code}' "$cloud_url/v1/me")" == 401 ]] \
  || die "The public unauthenticated /v1/me boundary did not return 401."

wss_status="$(curl "${cloud_curl[@]}" --http1.1 --output /dev/null --write-out '%{http_code}' \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --header "Origin: $cloud_url" "$cloud_url/v1/events")"
[[ "$wss_status" == 401 ]] || die "The public unauthenticated WSS boundary did not return 401."
wrong_origin_status="$(curl "${cloud_curl[@]}" --http1.1 --output /dev/null --write-out '%{http_code}' \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --header 'Origin: https://example.invalid' "$cloud_url/v1/events")"
[[ "$wrong_origin_status" == 403 ]] || die "The public WSS boundary accepted an unapproved Origin."

catalog_body="$(curl "${cloud_curl[@]}" --fail \
  --header 'content-type: application/json' \
  --data '{"protocolVersion":"1.0","requestId":"req_ahttpsoidccatalog0003","type":"endpoint.catalog.get"}' \
  "$cloud_url/v1/commands")"
printf '%s' "$catalog_body" | node -e '
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
  --header 'idempotency-key: idem_a_oidc_external_confirm_0001' \
  --data '{"bindingCode":"SF-ABCDEFGH-JKLMNPQR","realmUrl":"https://chat.sciforge.cn","realmId":"a-oidc-external-gate","zulipUserId":"a-oidc-external-user","providerEventId":"a-oidc-external-event-0001","idempotencyKey":"idem_a_oidc_external_confirm_0001"}' \
  --write-out $'\n%{http_code}' "$cloud_url/v1/integrations/zulip/bindings/confirm")"
confirm_status="${confirm_response##*$'\n'}"
confirm_body="${confirm_response%$'\n'*}"
[[ "$confirm_status" == 401 ]] || die "The public trusted binding confirm boundary is not exact HTTP 401."
printf '%s' "$confirm_body" | node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    try { if (JSON.parse(input)?.error?.code !== "authentication_required") process.exit(1) }
    catch { process.exit(1) }
  })
' || die "The public disabled confirm did not return authentication_required."

for forbidden_path in / /admin/ /metrics /health /health/ready \
    /realms/master/.well-known/openid-configuration \
    /realms/sciforge/.well-known/openid-configuration \
    /REALMS/SciForge/.well-known/openid-configuration \
    /realms/SciForgeX/.well-known/openid-configuration \
    /realms/SciForge/%2e%2e/master/.well-known/openid-configuration; do
  [[ "$(curl "${identity_curl[@]}" --path-as-is --output /dev/null --write-out '%{http_code}' \
    "$identity_url$forbidden_path")" == 404 ]] \
    || die "The public login-test edge exposed a forbidden Keycloak path: $forbidden_path"
done
discovery_body="$(curl "${identity_curl[@]}" --fail "$discovery_url")"
printf '%s' "$discovery_body" | node -e '
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
' || die "Public Keycloak Discovery does not publish the exact HTTPS issuer/token/revocation endpoints and RS256/S256 support."
jwks_body="$(curl "${identity_curl[@]}" --fail "$jwks_url")"
printf '%s' "$jwks_body" | node -e '
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
' || die "The public JWKS has no unique usable RSA/RS256 signing key."

cloud_headers="$(curl "${cloud_curl[@]}" --output /dev/null --dump-header - "$cloud_url/healthz")"
discovery_headers="$(curl "${identity_curl[@]}" --output /dev/null --dump-header - "$discovery_url")"
jwks_headers="$(curl "${identity_curl[@]}" --output /dev/null --dump-header - "$jwks_url")"
for headers in "$cloud_headers" "$discovery_headers" "$jwks_headers"; do
  grep -Eiq '^strict-transport-security: max-age=31536000' <<< "$headers" \
    || die "A public dual-SNI response is missing HSTS."
  [[ "$(awk 'tolower($1) == "x-sciforge-edge-revision:" { gsub(/\r/, "", $2); print $2 }' <<< "$headers")" == "$expected_commit" ]] \
    || die "A public dual-SNI response lacks the exact A edge revision."
  if grep -Eiq '^(server|alt-svc:.*h3):' <<< "$headers"; then
    die "The public dual-SNI edge exposed a server banner or HTTP/3 advertisement."
  fi
done
grep -Eiq '^cache-control: no-store([[:space:]]|$)' <<< "$cloud_headers" \
  || die "The public Cloud response is not marked no-store."
if grep -Eiq '^access-control-allow-origin:' <<< "$cloud_headers"; then
  die "The public Cloud health response exposed an unsafe CORS header."
fi

for forbidden_port in 80 8080 8787 5432; do
  if node -e '
    const net = require("node:net")
    const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) })
    socket.setTimeout(3000)
    socket.once("connect", () => { socket.destroy(); process.exit(0) })
    socket.once("timeout", () => { socket.destroy(); process.exit(1) })
    socket.once("error", () => process.exit(1))
  ' "$expected_ipv4" "$forbidden_port"; then
    die "Forbidden public TCP port $forbidden_port is reachable."
  fi
done

verify_public_dns "$cloud_hostname"
verify_public_dns "$identity_hostname"
echo "External A HTTPS OIDC edge verification passed for commit $expected_commit: dual-SNI TLS, exact Discovery/JWKS/revision, fixed Portal asset/BFF pre-auth boundaries, realm-path isolation, empty catalog, disabled confirm, and public port boundaries. No successful browser login, real-token, or cross-team E2E claim is made."
