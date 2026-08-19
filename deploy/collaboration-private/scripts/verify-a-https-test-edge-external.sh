#!/usr/bin/env bash

set -euo pipefail

hostname=cloud-test.sciforge.cn
expected_ipv4=47.76.230.118
expected_commit="${1:-}"
expected_script_sha256="${2:-}"
base_url="https://$hostname"
curl_args=(--disable --noproxy '*' --proto '=https' --silent --show-error --max-time 10 \
  --resolve "$hostname:443:$expected_ipv4")

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
  || die "Usage: verify-a-https-test-edge-external.sh <approved-40-character-commit> <manifest-script-sha256>"
[[ -f "$0" && ! -L "$0" ]] \
  || die "The external verifier must be a regular, non-symlink file from the fixed release."
actual_script_sha256="$(node -e '
  const { createHash } = require("node:crypto")
  const { readFileSync } = require("node:fs")
  process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))
' "$0")"
[[ "$actual_script_sha256" == "$expected_script_sha256" ]] \
  || die "The external verifier does not match the fixed release manifest."

verify_public_dns() {
  local aaaa_status
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
  ' "$hostname")" || die "Could not resolve the public test hostname."
  [[ "$resolved_ipv4" == "$expected_ipv4" ]] \
    || die "The public test hostname does not resolve only to the approved ECS IPv4 address."

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
  [[ "$aaaa_status" != 2 ]] \
    || die "The IPv4-only public test hostname unexpectedly has an AAAA record."
  [[ "$aaaa_status" == 0 ]] \
    || die "The public AAAA query failed and cannot prove an IPv4-only DNS boundary."
}

verify_public_dns

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
  || die "The public certificate chain, hostname, or remaining lifetime is invalid."

health_status="$(curl "${curl_args[@]}" --output /dev/null --write-out '%{http_code}' "$base_url/healthz")"
ready_status="$(curl "${curl_args[@]}" --output /dev/null --write-out '%{http_code}' "$base_url/readyz")"
health_body="$(curl "${curl_args[@]}" --fail "$base_url/healthz")"
ready_body="$(curl "${curl_args[@]}" --fail "$base_url/readyz")"
[[ "$health_status" == 200 && "$ready_status" == 200 \
    && "$health_body" == '{"ok":true}' && "$ready_body" == '{"ok":true}' ]] \
  || die "The public HTTPS health or readiness response is invalid."
[[ "$(curl "${curl_args[@]}" --output /dev/null --write-out '%{http_code}' \
  "$base_url/console/")" == 404 ]] || die "The public edge exposed the A-only console."
[[ "$(curl "${curl_args[@]}" --output /dev/null --write-out '%{http_code}' \
  "$base_url/v1/me")" == 401 ]] || die "The public identity boundary did not fail closed."

wss_status="$(curl "${curl_args[@]}" --http1.1 \
  --output /dev/null --write-out '%{http_code}' \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --header 'Origin: https://cloud-test.sciforge.cn' "$base_url/v1/events")"
[[ "$wss_status" == 401 ]] || die "The public unauthenticated WSS boundary did not return 401."
wrong_origin_status="$(curl "${curl_args[@]}" --http1.1 \
  --output /dev/null --write-out '%{http_code}' \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --header 'Origin: https://example.invalid' "$base_url/v1/events")"
[[ "$wrong_origin_status" == 403 ]] || die "The public WSS boundary accepted an unapproved Origin."

catalog_body="$(curl "${curl_args[@]}" --fail \
  --header 'content-type: application/json' \
  --data '{"protocolVersion":"1.0","requestId":"req_ahttpsedgecatalog0003","type":"endpoint.catalog.get"}' \
  "$base_url/v1/commands")"
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
' || die "The public Provider catalog is not exactly empty."

security_headers="$(curl "${curl_args[@]}" --output /dev/null --dump-header - \
  "$base_url/healthz")"
grep -Eiq '^strict-transport-security: max-age=31536000' <<< "$security_headers" \
  || die "The public edge is missing HSTS."
grep -Eiq '^cache-control: no-store([[:space:]]|$)' <<< "$security_headers" \
  || die "The public edge response is not marked no-store."
[[ "$(awk 'tolower($1) == "x-sciforge-edge-revision:" { gsub(/\r/, "", $2); print $2 }' <<< "$security_headers")" == "$expected_commit" ]] \
  || die "The live public edge revision does not match the approved commit."
if grep -Eiq '^(server|access-control-allow-origin):' <<< "$security_headers"; then
  die "The public edge exposed a server banner or unsafe CORS response."
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

verify_public_dns
echo "External A HTTPS edge verification passed for commit $expected_commit (trusted TLS and core/WSS fail-closed boundaries; no successful authenticated WSS or business E2E claimed)."
