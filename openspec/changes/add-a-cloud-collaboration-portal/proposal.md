# Change: Add A Cloud Collaboration Portal

## Why

The A cloud service already exposes the collaboration API and strict OIDC identity boundary, but
an ordinary browser has no safe, fixed-release interface for observing and managing the user's
projects, workers, task state, results, and pending HumanNeeded requests. Publishing the existing engineering
`/console/` would expose a raw command surface and would put browser token handling outside a
defined security boundary.

The test environment needs a deliberately small portal that proves the browser-to-cloud slice
without claiming to replace the Desktop orchestrator or worker runtime. It must use a confidential
Keycloak client through a same-origin backend-for-frontend (BFF), keep credentials and tokens out of
browser storage, and remain bound to the exact A fixed release. HumanNeeded is display-only in this
iteration, and the global worker directory is explicitly test-only.

## What Changes

- Add a separately owned `@sciforge/collaboration-portal` browser package and serve its fixed Vite
  build only below `/portal/` from the collaboration server process.
- Extract the shared SciForge visual primitives used by both the Electron renderer and Portal, and
  deliver the responsive Worker Constellation/Project workbench in light, dark, and system themes.
- Add a same-origin confidential-client BFF below `/portal/auth/*`, `/portal/api/*`, and the exact
  event endpoint `/portal/events`. The browser receives only an opaque secure session cookie; the
  BFF owns authorization-code exchange, token refresh, local session logout with best-effort
  refresh-token revocation, and calls into the existing A service boundary; it does not claim a
  Keycloak end-session redirect.
- Add typed BFF actions for the existing Project/Task/member/result lifecycle and views for project,
  task, result, worker status, and HumanNeeded. HumanNeeded alone is display-only and SHALL NOT
  expose an answer/approve/reject action in this change.
- Add a globally visible worker directory only when the fixed test-only feature flag is enabled.
  It is a test-environment diagnostic and is not a production tenancy or discovery contract.
- Add a new external Keycloak confidential client `sciforge-cloud-console`, with exact redirect
  `https://cloud-test.sciforge.cn/portal/auth/callback`. Its secret remains a root-only deployment
  input and is never included in Git, a bundle, a manifest, a response, or a browser asset.
- Extend the A HTTPS/OIDC fixed release to package the portal tarball, verify the Vite and integrity
  manifests plus every listed asset, bind the portal package/assets/client/redirect/feature flags
  and CSP into `RELEASE_MANIFEST.json`, install the package in the runtime image, and verify the
  public route/header/auth boundaries.
- Advance the collaboration database from the historical integrated schema v8 cohort to schema v9
  with ten release-owned bounded-read indexes and fixed concurrent-safe limits of 1,000 active
  Project memberships per User, 50,000 records per Project, and 10,000 HumanNeeded requests per
  Project; require an isolated v5-to-v9 gate plus an explicit index/cap receipt before production
  migration.
- Preserve `/console*` as public 404 and preserve all existing `/v1/*`, WSS, Keycloak path, Docker
  network, port, rollback, and fixed-commit gates.

## Capabilities

### New Capabilities

- `a-cloud-collaboration-portal`: Defines the browser portal, confidential BFF session, bounded
  collaboration views and governed typed actions, test-only worker directory, fixed public routes,
  and immutable asset release boundary.

### Modified Capabilities

- `oidc-user-identity`: Adds a separate single-party Portal verifier for
  `sciforge-cloud-console`; it never joins public `oidcAuthorizedParties`, which remains exactly
  Desktop/Web-Mobile.

## Impact

- New package: `packages/collaboration-portal` and package-owned browser tests/build output.
- Collaboration server: portal/BFF routing and session/token ownership, implemented separately
  from the raw engineering console and existing User/Agent bearer paths.
- Fixed release: a fifth npm tarball, portal asset inventory/integrity binding, runtime install,
  OIDC-mode environment, Caddy CSP/routing, static policy, local verifier, external verifier, and
  PostgreSQL schema-v9/index attestation. Compatibility verifier and attestation names remain
  stable for existing deployment automation.
- Keycloak: an external operator must create and validate the confidential client and provide its
  secret through the existing root-only env file during the maintenance window. This repository
  neither creates nor changes the Keycloak realm.
- No ECS, Keycloak, GitHub, or production deployment is performed by this change.
