# Tasks: Add A Cloud Collaboration Portal

## 1. Contract and architecture

- [x] 1.1 Specify exact portal/auth/API/events routes, confidential BFF ownership, fixed client and
  redirect, session bounds, display-only HumanNeeded, test-only worker directory, and non-goals.
- [x] 1.2 Specify immutable portal package/asset/CSP release bindings, secret exclusion, external
  Keycloak readiness, evidence classes, deployment, and rollback.
- [x] 1.3 Audit the implemented portal/server contracts against this OpenSpec and update only this
  change if implementation reveals a deliberate design decision.

## 2. Portal package

- [x] 2.1 Build `@sciforge/collaboration-portal` with a `/portal/` Vite base, accessible shell,
  authenticated state, typed Project/Task/member/result actions, worker/HumanNeeded displays, and
  no token storage.
- [x] 2.2 Generate `dist/.vite/manifest.json` and a strict integrity manifest covering every served
  regular asset; package only the necessary immutable dist files.
- [x] 2.3 Add focused UI tests for login/session states, bounded views, display-only HumanNeeded,
  visibly test-only worker directory, no HumanNeeded answer/approval controls, and safe rendering.

## 3. Confidential BFF

- [x] 3.1 Implement exact auth login/callback/logout/session routes using state, nonce, PKCE, the
  confidential client, strict discovery, secure cookie attributes, rotation, and memory-only
  30-minute idle/8-hour absolute sessions; logout is local session invalidation plus best-effort
  refresh-token revocation and does not claim an RP/end-session redirect.
- [x] 3.2 Implement allowlisted `/portal/api/*` views and typed mutations through canonical A
  Service/repository authority using the exact project/worker/agent/coordination/member/task/review
  method+path matrix, with bounded pagination, membership/role checks, CSRF, route-applicable
  idempotency/revision/execution fencing, a fixed `/portal/api/commands` 404 tombstone, and no raw
  command proxy.
- [x] 3.3 Implement authenticated user-scoped `/portal/events` behavior and reject wrong origin,
  Agent bearer, expired session, and raw WSS compatibility assumptions.
- [x] 3.4 Add negative tests for callback/session/CSRF/redirect failures, secret/token redaction,
  cross-user reads, HumanNeeded mutations, and disabled global directory.

## 4. Fixed release and runtime image

- [x] 4.1 Extend the bundle builder to build, pack, archive-verify, lock, and checksum the fifth
  portal package and reject unsafe/incomplete/unlisted portal assets.
- [x] 4.2 Advance the OIDC manifest to schema 4 and bind portal package, both asset manifests,
  sorted files, routes, exact public two-party list, independent Portal single-party verifier,
  client ID, redirect URI, feature flags, CSP, and deployment assets without binding any secret.
- [x] 4.3 Install the exact portal archive in `Dockerfile.runtime` and verify the installed package,
  manifests, and asset inventory against the fixed release before accepting the image.
- [x] 4.4 Extend builder unit tests for valid portal archives and all manifest/path/digest/file-set,
  five-package, checksum-count, and secret-exclusion failure modes.
- [x] 4.5 Advance the generated contract artifact and release-owned PostgreSQL gate to schema v9,
  make the bundle reject a stale artifact, enforce the fixed active-membership/record/HumanNeeded
  caps with concurrent-write serialization, verify and receipt all ten exact `0009` bounded-read
  indexes, while retaining compatibility verifier/attestation field names.

## 5. OIDC test deployment

- [x] 5.1 Document and validate the fixed non-secret portal env values and root-only client-secret
  input; inject portal variables only into app in the explicit OIDC Compose profile.
- [x] 5.2 Route `/portal/`, `/portal/auth/*`, `/portal/api/*`, and `/portal/events` with the exact
  CSP, overwrite Portal `X-Forwarded-For` with one canonical `{remote_host}`, and retain
  `/console*` 404 plus all port/SNI/network/Keycloak path boundaries.
- [x] 5.3 Extend common/deploy/image/runtime checks for schema 4, five package tarballs/checksums,
  app-only secret presence, exact non-secret env, installed asset integrity, and rollback safety.
- [x] 5.4 Extend static policy, local verifier, and independent external verifier for portal entry,
  redirect/login metadata, unauthenticated API/events, CSP/security headers, console denial, secret
  absence, forwarded-header spoof rejection/canonicalization, and existing A regressions.
- [x] 5.5 Freeze rollback safety across the live `7ad/schema5` to Portal schema9 boundary: either
  retain the schema9-compatible app with Portal/edge disabled or restore a verified compatible
  backup into a new database before starting an old release; never attach an old app to schema9.

## 6. Verification and external handoff

- [ ] 6.1 Run builder tests, shell syntax, static policy, focused portal/server tests, typecheck, and
  a fixed bundle dry run when the complete source cohort is available.
- [x] 6.2 Record exact non-secret Keycloak client readiness requirements and maintenance-window
  secret handling; do not create or mutate Keycloak from this change.
- [ ] 6.3 During a separately authorized maintenance window, generate the fixed bundle/image/deploy
  evidence, run local and independent public verification, and record rollback entry.
- [ ] 6.4 After Keycloak readiness, run redacted real browser login/session/logout, typed
  Project/Task/result, event, HumanNeeded-display and multi-worker-directory acceptance; do not
  conflate it with Desktop Orchestrator→Workers execution E2E. Include refresh/revocation,
  old-cookie/old-WebSocket rejection, public/Portal authorized-party cross-rejection, and record
  explicitly that local logout is not an RP/end-session redirect.
