#!/usr/bin/env bash

set -euo pipefail

cloud_hostname=cloud-test.sciforge.cn
identity_hostname=login-test.sciforge.cn
expected_ipv4=47.76.230.118
expected_issuer=https://login-test.sciforge.cn/realms/SciForge
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

for command in awk curl grep node; do
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
        end_session_endpoint: `${issuer}/protocol/openid-connect/logout`
      }
      for (const [key, value] of Object.entries(expected)) if (body?.[key] !== value) process.exit(1)
      if (!Array.isArray(body.id_token_signing_alg_values_supported) ||
          !body.id_token_signing_alg_values_supported.includes("RS256")) process.exit(1)
    } catch { process.exit(1) }
  })
' || die "Public Keycloak Discovery does not publish the exact HTTPS issuer/endpoints and RS256 support."
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
echo "External A HTTPS OIDC edge verification passed for commit $expected_commit: dual-SNI TLS, exact Discovery/JWKS/revision, realm-path isolation, empty catalog, disabled confirm, and public port boundaries. No real-token or cross-team E2E claim is made."
