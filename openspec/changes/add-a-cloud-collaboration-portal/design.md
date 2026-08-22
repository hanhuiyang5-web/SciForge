# Design: Add A Cloud Collaboration Portal

## Context

The A HTTPS/OIDC test deployment terminates `cloud-test.sciforge.cn` and
`login-test.sciforge.cn` at one digest-pinned Caddy edge. The collaboration app is reachable by the
edge on the private Docker network and also remains published only on ECS loopback for operations.
The public edge intentionally returns 404 for `/console*`; the engineering console is not a user
portal.

OIDC User APIs currently accept bearer access tokens issued to the Desktop and Web-Mobile public
clients. A browser portal needs a different boundary: a confidential client secret cannot be
shipped to JavaScript, and long-lived access or refresh tokens must not be put in local/session
storage. The portal therefore runs as a same-origin BFF feature of the A server and consumes the
existing Service/repository authority after resolving a server-side login session.

This change is limited to A. It does not implement Desktop orchestration, Worker execution, B's
coordination policy, Keycloak realm administration, or HumanNeeded answering. The worker directory
is intentionally a test-environment diagnostic, not a general multi-tenant discovery design.

## Goals

- Provide a useful browser view of the authenticated user's collaboration state at `/portal/`.
- Keep all OIDC client credentials, authorization codes, access tokens, refresh tokens, and session
  authority on the server side.
- Reuse the canonical A Service/repository reads and governed mutations instead of creating a
  browser-specific state machine or generic command relay.
- Bind every served portal byte and every security/configuration input to the fixed A release.
- Keep public `/console*` unavailable and preserve the existing API/WSS/identity-edge boundaries.
- Make external Keycloak readiness and maintenance-window work explicit and non-secret.

## Non-Goals

- Running an Agent/Worker in the browser, replacing Desktop execution, or submitting arbitrary raw
  A commands from the browser.
- Answering, approving, rejecting, or otherwise mutating HumanNeeded requests.
- Defining a production global worker-discovery, tenancy, invitation, or authorization model.
- Persisting tokens in browser storage, exposing the client secret, or accepting browser-supplied
  upstream bearer tokens as a portal session.
- Publishing `/console/`, adding a second public hostname, opening another port, or changing
  Keycloak/PostgreSQL Docker networks.
- Creating the Keycloak client or deploying to ECS as part of repository implementation.

## Decisions

### 1. Use a separate portal package with one fixed asset inventory

The browser code lives in `@sciforge/collaboration-portal`; it is not embedded as a source string
inside the server. Its npm archive must contain `dist/.vite/manifest.json`, a package-owned
integrity manifest, and every runtime asset named by those manifests. The bundle builder verifies
the packed archive itself, not a mutable source `dist/`, and records the portal archive digest,
both manifest digests, and a sorted path/size/SHA-256 asset inventory in the release manifest.

Only regular files below `dist/` are allowed in that inventory. Absolute paths, traversal,
symlinks, duplicate paths, missing assets, unlisted runtime files, digest mismatches, empty entry
HTML, and source maps are release failures. The runtime image installs the exact portal tarball via
the generated bundle lockfile; it does not compile frontend source.

The Electron renderer and Portal import `src/shared/sciforge-design-tokens.css` as the single source
for SciForge background/surface/text/accent, typography, radius, and motion primitives. Each product
maps those primitives to its own semantic component tokens; neither copies a second raw core
palette. The Portal implements the Worker Constellation with SVG/DOM, responsive three/two/one-column
layouts, keyboard semantics, WCAG-AA contrast, reduced motion, and local-only theme/locale
preferences. It does not use third-party CDNs, WebGL, or browser token storage.

### 2. Keep one exact public route family

The public browser routes are:

- `/portal/` and package-owned assets below `/portal/`;
- `/portal/auth/*` for login, callback, logout, and session lifecycle;
- `/portal/api/*` for authenticated same-origin BFF views and typed mutations;
- `/portal/events` for the authenticated portal event stream.

`/portal` redirects to `/portal/` without accepting another base path. `/console*` remains 404.
The edge does not strip or rewrite the portal prefix; the server owns route semantics, SPA fallback,
authentication, and typed errors. Caddy supplies the exact release-bound CSP and security headers
and proxies HTTP/1.1 upgrade traffic for `/portal/events` to the same app.

For Portal HTTP/WSS requests, Caddy overwrites `X-Forwarded-For` with exactly `{remote_host}` rather
than extending a caller-provided chain. The app consumes a single canonical forwarded IP only when
its socket peer is private/loopback (the fixed edge path), rejecting lists or forwarded identity
from an untrusted peer. This keeps login/session rate and audit identity independent of spoofed
client headers.

### 3. Use a confidential authorization-code BFF

Keycloak client ID is exactly `sciforge-cloud-console`; redirect URI is exactly
`https://cloud-test.sciforge.cn/portal/auth/callback`. Login uses authorization code flow with
state, nonce, and PKCE. The server validates state/nonce and performs token exchange with the
client secret. Authorization, token, and refresh-token revocation endpoints come only from the
already validated exact issuer/discovery boundary. Logout clears the local session and attempts
refresh-token revocation; this change does not claim a Keycloak end-session redirect.

The server creates an opaque random session identifier and sets it as the `__Host-sciforge-portal`
cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`. Session state and OIDC tokens are memory-only in this test
cohort, have fixed 30-minute idle and 8-hour absolute bounds, rotate across login, and are removed
on logout or unrecoverable refresh failure. A restart requires login again. CSRF protection is
required for every state-changing auth/BFF operation. The short-lived pre-login transaction uses
the separate `__Host-sciforge-portal-login` cookie with `SameSite=Lax`, `Path=/`, and a five-minute
bound so the top-level authorization redirect can return safely.

Login admission and session admission are bounded independently. Per-source and global login
limits protect the anonymous entry point; live sessions are capped globally and per stable OIDC
identity. Session insertion, same-identity eviction, and global-cap admission form one synchronous
critical section with no network await. Refresh is single-flight per session, and refresh-token
revocation of an evicted session runs only through a bounded best-effort queue after authority has
already been removed. Passive Worker polling, event reconciliation, and server-side event checks
reauthenticate without extending the 30-minute idle deadline; only an explicit same-origin browser
interaction may touch idle activity.

The browser never receives the confidential secret, authorization code after callback processing,
access token, refresh token, ID token, or raw upstream `Authorization` value. Logs, errors,
telemetry, release manifests, Docker labels, health responses, and static assets do not contain
them.

### 4. Reuse canonical A authority through a narrow typed BFF

The BFF resolves the session to the same stable OIDC User identity and invokes existing A
Service/repository authority in-process. It does not loop back through public HTTP with a copied
bearer and does not introduce a second database or state transition path. Responses are allowlisted
portal view models with bounded pagination and no Agent credentials, Device keys, OIDC claims,
Provider secrets, internal traces, or unrelated users' private identity fields.

The portal may expose typed actions already governed by the canonical model: create Project,
manage eligible members, create/offer Task, cancel Task, retry it with an explicitly reselected
assignee, and accept/reject candidate results. There is no standalone reassign route. Every
mutation is protected by session authorization, CSRF, idempotency, the applicable
Project role/membership/owner/coordinator/assignee rules, and the existing Service transaction.
Expected revision/execution fencing additionally applies where the canonical operation has an
existing object: Project create has no prior revision; member update and task create fence the
Project; task cancel/retry fence the Task revision and execution; record review fences the record.
The BFF does not accept a caller-selected command `type` or forward an arbitrary command envelope.

The HTTP surface is resource-shaped and method-specific: project/worker/owned-agent lists, one
project coordination view, project creation/member update/task creation, task cancel/retry, and
project-record review each have a distinct typed route. The former `/portal/api/commands` shape is
an explicit 404 tombstone so an old browser bundle cannot silently regain a generic command relay.

The coordination route pages Tasks, Project records, and target-User HumanNeeded independently.
Each opaque cursor is bound to its Project and collection; each repository query uses a primary-key
keyset and `LIMIT + 1`. The first browser render fetches only bounded data, and explicit
collection-specific “load more” actions merge later pages by stable ID. Page packing also observes
the fixed serialized-response byte ceiling, so a legal large entity cannot prevent the caller from
receiving a cursor or a safe oversized-item diagnostic.

Page packing is an adaptive single pass over the fetched candidates. It serializes each candidate
item exactly once for UTF-8 byte accounting, caches that size while selecting items, reserves
bounded envelope/cursor overhead, and performs only a fixed bounded number of final whole-envelope
rechecks. Its work is therefore `O(total candidate serialized bytes)` rather than repeatedly
serializing every accepted prefix. A final envelope that still exceeds the fixed Portal ceiling
fails with `payload_too_large`; it is never emitted as an oversized response.

The separate canonical `getProjectCoordinationView` remains a full snapshot for existing Desktop
consumers, so it has its own fail-safe before any full collection is materialized. Inside one
read-only repository snapshot it first runs a database-native count-only preflight over active
members, Tasks, Project records, HumanNeeded requests, and HumanAnswers. Per-collection invariants
and a combined 8,000-row ceiling are checked before any serialized-byte query or list read. Only a
passing count may run the conservative database-native serialized-byte preflight across all five
collections; raw JSON bytes, fixed per-row overhead, Project JSON, and fixed envelope headroom must
fit within 4 MiB. Only then may the full arrays be loaded, and the finished JSON receives a final
4 MiB guard. Every rejection is stable `payload_too_large` and produces no write. The independently
paged Portal coordination route does not call this full-snapshot preflight, so a valid large
Project remains inspectable page by page.

Project, owned-Agent, member, and Worker summaries are produced by repository-native joins and
keyset queries with grouped counts and `EXISTS` predicates; Service code does not fetch every
Project, Agent, User, Task, or record before slicing a page. The new forward-only migration
`0009_portal_bounded_reads.sql` advances the release to database schema v9 and supplies the
matching pagination, membership, active-owner Agent, active-assignee, HumanNeeded, HumanAnswer
coordination, candidate-result, record, and active-OIDC indexes. Its ten exact Portal/coordination indexes are
`agent_nodes_active_owner_agent_idx`, `human_answers_project_created_answer_idx`,
`human_requests_project_target_request_id_idx`,
`oidc_identities_active_user_issuer_idx`, `project_members_active_project_user_idx`,
`project_members_active_user_project_idx`, `project_records_candidate_task_result_project_idx`,
`project_records_project_record_id_idx`, `tasks_active_assignee_idx`, and
`tasks_project_task_id_idx`. Portal GETs are
read-only and do not invoke global expiry pruning; time-expired pending state is projected at
the read timestamp and durable pruning remains a separately throttled maintenance/business-write
concern.

Public expiry behavior outside the Portal is scope-local as well. `pullInbox` opens one short
transaction, locks that recipient's cursor first, supersedes only active expired messages for the
same recipient whose sequence is greater than its acknowledged sequence, and then reads the page
and cursor in that transaction. It does not touch acknowledged messages, another recipient, or
another expirable table. `getActionConfirmation` reads one confirmation by ID, authorizes its
reader, and at one fixed `readAt` projects an expired approved confirmation as superseded without
changing its durable status, revision, or timestamps; governed consumption still rechecks the
locked record. `answerHumanNeeded` first reads and authorizes the exact request, then, only when it
was pending and expired at command admission, applies an atomic ID/target-User/revision/pending/
expiry compare-and-set before the canonical answer transaction performs its complete recheck at
that same admission timestamp. Global expiry/retention GC remains an explicit maintenance action;
public read and poll paths never invoke a global prune.

The canonical data model also fixes the inputs of otherwise unbounded Portal and event-watermark
reads: one User may have at most 1,000 active Project memberships, one Project at most 50,000
Project records, and one Project at most 10,000 HumanNeeded requests. Project creation includes the
Owner in that check. Every create/add/reactivate path takes transaction-scoped per-User advisory
locks in stable User-ID order, counts active memberships through the user-first partial index, and
rejects the write at the boundary. Record and HumanNeeded writers already hold the Project row lock;
they count under that same lock before insert. Migration `0009` freezes every relation used by these
checks and the author repair in one fixed order, then fails closed if historical data already exceeds
any limit. HumanAnswers need no separate cardinality cap because the canonical unique request link
permits at most one answer for each already bounded HumanNeeded request; canonical coordination
preflight scans them only by Project in `created_at,human_answer_id` order through the matching
project-leading index, while the browser projection still exposes none of their content.

Schema v4 also materialized legacy completed-Task results with a null `author_user_id`, while the
public ProjectRecord contract requires that stable User author. Migration `0009` repairs only null
historical authors. It verifies any Task source still exists and names the same assignee Agent, but
does not use the Task's assignee User as historical evidence because the v4 ownership foreign key
cascades that value during Agent transfer. Instead, it selects the earliest accepted
`agent.owner.transfer` audit strictly after the record timestamp and uses that event's User actor—the
owner immediately before the transfer. If no later transfer exists, it uses the Agent's current owner.
Equal-time or duplicate-time transfer evidence, malformed audit identity, and any unresolvable source
fail the migration before the version marker; the column then becomes `NOT NULL`. A pre-existing
non-null author is immutable history and is never inspected, compared with the Agent's current owner,
or changed, because Agent ownership transfer is a valid lifecycle.

Portal events reuse the existing notifier/repository facts but have their own session-authenticated,
user-scoped projection and reconnect behavior. They do not accept Agent credentials or expose the
raw `/v1/events` protocol as a browser compatibility alias. The hub has fixed global and
per-identity connection limits, a subscription deadline, ping/pong liveness, bounded send buffers,
serialized client commands, bounded Project-read concurrency, and single-flight/coalesced Inbox
wakes. Direct User notifications target that User's sessions; an Agent-originated fallback is
global only as one bounded coalesced wake. Periodic reconcile remains the correctness fallback.

Wake comparison uses lightweight read-only facts: Project revision, member identity/revision facts,
and monotonic count-plus-revision aggregates for Tasks and records. HumanNeeded facts are filtered
to the authenticated target User and never join HumanAnswers. These aggregates rely on the current
no-delete and revision-plus-one child invariants; a future child-delete feature must replace them
with a monotonic Project wake sequence or ordered identifier/revision digest.

### 5. Freeze HumanNeeded as display-only

The portal may show pending/expired/answered HumanNeeded metadata visible to the authenticated
target user, limited to allowlisted identifiers, safe project/task association, status, expiry,
and required assurance. The browser projection excludes prompt, confirmable action, HumanAnswer,
answer text, endpoint provenance, approve/reject controls, command execution, and hidden mutation. Existing
Desktop/provider HumanNeeded semantics remain authoritative. Adding a portal answer path requires
a later spec covering assurance, recent-auth, confirmation, CSRF, idempotency, and audit.

### 6. Gate the global worker directory as test-only

The fixed OIDC test deployment sets `SCIFORGE_COLLABORATION_PORTAL_TEST_WORKER_DIRECTORY_ENABLED`
to `true`; all other modes omit or disable it. The UI labels the result as test-only. The directory
pages at most 50 currently usable test Workers at a time and returns only the user-requested
operational fields: Cloud `ownerUserId`, opaque Agent ID, safe display name, Desktop/Server,
OS/arch, runtime/capability IDs, GPU summary, lease-derived status, exact last-seen time, and profile
expiry. It never returns bearer credentials, Device IDs/keys, OIDC subject/email, session data, IP,
installation ID, or secret material.

This flag does not grant command authority over another user's Worker. Production enablement is
forbidden until a separate membership/discovery authorization design replaces the global test
view.

### 7. Bind portal configuration into manifest schema 4

`a-https-oidc-test` advances to release manifest schema 4. It fixes:

- the portal package filename and archive SHA-256;
- Vite manifest and integrity-manifest paths/digests plus sorted asset inventory;
- base/auth/API/events routes;
- public origin, issuer, client ID, and exact redirect URI;
- public `oidcAuthorizedParties` as exactly `sciforge-desktop,sciforge-web-mobile` and an
  independent `portalAuthorizedParty` as exactly `sciforge-cloud-console`;
- `humanNeededMode: "display-only"`;
- `testWorkerDirectoryEnabled: true`;
- the exact portal CSP;
- the digest of every deployment asset and executable mode already protected by schema 3.

The client secret is prohibited from the manifest and bundle. Non-OIDC bundle modes may carry the
portal package as part of the package cohort, but do not enable or publicly expose the portal and do
not carry OIDC-test portal metadata.

The packed contracts artifact manifest independently records `databaseSchemaVersion: 9`. The
bundle builder validates that value after commit injection and again from the packed contracts
archive, rejecting a stale schema8 artifact even though database migration truth is still derived
from the fixed server tarball at deployment time. This is not a new top-level release-manifest
field and does not replace the release-derived migration gate.

At runtime, public `/v1` token verification continues to use only the two public authorized
parties. The Portal session manager uses a separate one-party verifier for the confidential
client. Each verifier rejects the other cohort, so adding the Portal cannot widen the machine API.

### 8. Inject the secret only into the app in explicit OIDC mode

The root-owned `collaboration.env` adds
`SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET`. Validation requires a high-entropy non-placeholder
value only for `a-https-oidc-test`; shell exports never echo it. The OIDC Compose overlay injects the
secret and the fixed non-secret portal values only into `app`. `postgres`, `migrate`, and `edge`
must not receive it. The app keeps a read-only root filesystem and writes transient session state
only to bounded memory.

Image verification checks the installed portal package and asset digests against the release
manifest. Runtime verification confirms the exact non-secret env values and only the presence and
minimum length of the secret, never its value.

### 9. Enforce one CSP at the edge and in the manifest

The portal CSP is a fixed literal that allows only same-origin scripts, styles, fonts, and
connections plus bounded `data:` images; it disables web manifests and denies objects, frames,
embedding, and base-URI changes. No `unsafe-inline`, `unsafe-eval`, wildcard source,
data-exfiltration origin, or Keycloak frame is allowed. Login is a top-level redirect, so Keycloak
need not be a script/connect/frame source.

Non-portal Cloud responses retain the existing default-deny CSP. Auth, API, event, and entry HTML
remain `no-store`; content-addressed static assets may be immutable only when the server identifies
them from the verified asset manifest.

### 10. Keep deployment and rollback fail closed

The builder, static policy, bundle validator, image inspection, local verifier, and external
verifier all understand the fifth package and portal metadata. Deployment is refused before
database or edge mutation when an asset, path, mode, env value, package lock, manifest field, CSP,
or secret boundary differs.

The live baseline before this change is `7ad/schema5`, while the Portal release requires database
schema v9. Migration `0009` is forward-only, so rollback MUST be database-compatible; an operator
MUST NOT directly start `7ad/schema5` or another old app against the migrated schema9 database.
After migration there are two safe failure paths: keep the schema9-compatible candidate app on
loopback with Portal/public edge disabled while preserving the database, or restore the verified
pre-maintenance compatible dump into a new volume/isolated database and only then deploy the old
fixed commit/bundle/image against that restored database. The sole production volume is never
overwritten as a shortcut. Portal sessions are memory-only and are invalidated by either path.
Keycloak client deletion or secret rotation is a separate operator action, not an automatic
rollback side effect.

## Risks and Mitigations

- **Confidential secret leaks through config or diagnostics.** Inject only into app, prohibit it in
  manifests/assets/logs, test static/runtime boundaries, and never print inspected values.
- **SPA build changes after release review.** Verify the packed archive, bind every asset digest,
  install through a generated lock, and re-check files in the candidate image.
- **BFF becomes a parallel collaboration API.** Keep allowlisted read projections over canonical
  Service/repository reads and prohibit raw command forwarding.
- **Global directory is mistaken for production authorization.** Fixed test-only flag, explicit UI
  label, minimal fields, no mutation authority, disabled in every non-OIDC-test mode.
- **Portal expands HumanNeeded authority accidentally.** No mutation route or UI control; regression
  tests assert display-only behavior and existing answer paths remain unchanged.
- **External client is missing or misconfigured.** Treat Keycloak readiness as a maintenance-window
  prerequisite and keep login fail closed until the exact client/redirect/secret are verified.

## Migration and Rollback

1. Build and test the portal package and BFF locally using a dynamic test issuer; do not represent
   fixture results as real Keycloak acceptance.
2. Build the A bundle from a clean fixed commit. Verify five package archives, portal asset
   inventory, schema-4 manifest, deployment asset modes/digests, and secret absence.
3. Before the maintenance window, Keycloak owner prepares enabled confidential client
   `sciforge-cloud-console` with standard authorization code flow and the one exact redirect URI;
   no wildcard redirect or public-client mode is accepted.
4. During the maintenance window, Keycloak owner delivers/rotates the client secret through the
   approved secret channel; A writes it only to the root-owned mode-0600 env file.
5. Install the fixed release, build the runtime image, run the compatibility-named isolated
   PostgreSQL gate from a v5 baseline through schema v9, require the ten `0009` bounded-read
   indexes plus the legacy ProjectRecord-author repair in its receipt, then migrate/start the app
   and replace/verify the edge through the existing candidate approval protocol.
6. Run local and independent external portal probes, then a real browser login/session/logout and
   authenticated typed Project/Task/result portal acceptance. Record this separately from Desktop
   multi-worker execution E2E.
7. On failure after schema9 migration, close the public edge and either keep the schema9-compatible
   app on loopback with Portal disabled, or restore the verified pre-maintenance schema5 dump into
   a new compatible database before deploying `7ad/schema5`. Never connect the old app directly to
   schema9. Preserve the migrated database, backup, ACME state, logs, and release evidence; all
   in-memory portal sessions expire and users log in again.

## External Readiness

Before a real login can pass, the Keycloak owner must confirm, without sharing the secret in Git or
chat evidence:

- realm issuer is exactly `https://login-test.sciforge.cn/realms/SciForge`;
- client ID is exactly `sciforge-cloud-console`, enabled and confidential;
- standard authorization code flow is enabled; implicit flow and direct-access grants are disabled;
- valid redirect URI is exactly
  `https://cloud-test.sciforge.cn/portal/auth/callback`, with no wildcard;
- valid web origin is exactly `https://cloud-test.sciforge.cn` if Keycloak requires it;
- client scope/mappers produce the existing `sciforge-cloud-api` audience and required claims;
- the exact issuer Discovery document publishes the token and revocation endpoints used by the
  BFF; no Keycloak post-logout redirect is required or claimed by this local logout design;
- a new client secret is delivered through the approved secret channel during the maintenance
  window and is not copied into a manifest, ticket, screenshot, or command transcript.

## Open Questions

- Production replacement for the test-only global worker directory requires a later tenancy and
  Project-membership discovery design.
- Portal HumanNeeded answering requires a later assurance/recent-auth/confirmation design; it is
  intentionally absent here.
- Durable distributed browser sessions are deferred; this single A test instance uses bounded
  memory-only sessions and re-login after restart.
