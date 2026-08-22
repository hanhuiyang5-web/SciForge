# A Cloud Collaboration Portal Requirements

## ADDED Requirements

### Requirement: Portal SHALL use one fixed same-origin route family

The A HTTPS/OIDC test deployment SHALL expose portal content only at `/portal/`, auth endpoints at
`/portal/auth/*`, BFF resources at `/portal/api/*`, and the exact portal event endpoint
`/portal/events`. `/portal` SHALL redirect to `/portal/`. The edge SHALL preserve the prefix for the
server and MUST NOT expose a second portal hostname or port. Public `/console*` SHALL remain 404.

#### Scenario: Unauthenticated browser loads the portal entry

- **WHEN** a browser requests `https://cloud-test.sciforge.cn/portal/`
- **THEN** A SHALL return the fixed portal entry document with the release-bound security headers
- **AND** SHALL NOT serve the engineering console or embed an access token in the document.

#### Scenario: Browser requests the engineering console

- **WHEN** a public client requests `/console`, `/console/`, or any descendant
- **THEN** the A edge SHALL return 404
- **AND** MUST NOT redirect that request into the portal.

#### Scenario: Unapproved portal-like path

- **WHEN** a client requests another case, prefix, hostname, or encoded traversal as a substitute
  for the fixed portal routes
- **THEN** A SHALL apply the ordinary API/404 boundary
- **AND** MUST NOT use a permissive rewrite or SPA fallback outside `/portal/`.

### Requirement: Portal SHALL extend the SciForge product language accessibly

Desktop and Portal SHALL import one shared SciForge visual primitive source for the core
light/dark palette, typography, radii, and motion. The Portal SHALL provide the Worker
Constellation and Project/Task workbench at Desktop, Tablet, and Mobile widths with light, dark,
and system themes. All actions SHALL be keyboard reachable, status SHALL not depend on color alone,
and reduced-motion plus WCAG-AA behavior SHALL be tested.

#### Scenario: Visual implementation drifts from Desktop or accessibility bounds

- **WHEN** a core palette is copied locally, a target viewport/theme changes, keyboard navigation
  fails, axe reports an A/AA violation, or reduced-motion animation exceeds its bound
- **THEN** source/static, component, screenshot, or browser audit gates SHALL fail
- **AND** no identity Token, session, or operation body SHALL be persisted as a visual preference.

### Requirement: Portal authentication SHALL use a confidential BFF session

Portal login SHALL use Keycloak authorization code flow for the exact confidential client
`sciforge-cloud-console` and exact redirect URI
`https://cloud-test.sciforge.cn/portal/auth/callback`. The BFF SHALL use state, nonce, and PKCE,
perform code exchange server-side, and issue only an opaque Secure/HttpOnly/SameSite session cookie.
OIDC tokens and the client secret MUST NOT be returned to JavaScript or browser storage.

#### Scenario: Successful authorization callback

- **WHEN** Keycloak returns a valid code and matching state for an unexpired login transaction
- **THEN** the BFF SHALL validate the callback, exchange the code with the confidential client,
  resolve the same stable OIDC User identity, rotate the login/session identifier, and redirect to
  `/portal/`
- **AND** the resulting browser response SHALL contain no access, refresh, or ID token.

#### Scenario: State, nonce, PKCE, redirect, or issuer mismatch

- **WHEN** any callback binding or exact OIDC configuration check fails
- **THEN** the BFF SHALL fail closed, consume or invalidate the login transaction, and create no
  authenticated session
- **AND** SHALL NOT fall back to a browser bearer, public client, alternate redirect, or email
  identity.

#### Scenario: Session expires or server restarts

- **WHEN** the 30-minute idle bound, 8-hour absolute bound, token lifecycle, or memory-only session
  lifetime ends
- **THEN** portal API and events SHALL become unauthenticated and the browser SHALL be required to
  log in again
- **AND** A SHALL NOT reconstruct authority from an unsigned cookie or browser storage.

#### Scenario: Background reconciliation continues without user activity

- **WHEN** only automatic Worker refresh, Project reconciliation, or server-side WebSocket polling
  occurs for 30 minutes
- **THEN** those passive checks SHALL validate but SHALL NOT extend session idle activity
- **AND** the old cookie and event connection SHALL expire as if the tab had made no request.

#### Scenario: Logout

- **WHEN** an authenticated user invokes the protected logout flow
- **THEN** A SHALL invalidate the server-side session, expire both portal cookies, and attempt
  refresh-token revocation through the exact issuer discovery boundary
- **AND** revocation failure SHALL NOT restore or retain the local session
- **AND** the response SHALL complete locally without claiming a Keycloak end-session redirect,
  and a replay of the old cookie SHALL not restore the session.

### Requirement: BFF SHALL expose typed canonical A operations without raw command forwarding

`/portal/api/*` and `/portal/events` SHALL resolve the portal session to the existing stable A User
and invoke canonical Service/repository authority. The BFF SHALL return bounded allowlisted view
models for the visible user's projects, tasks, results, worker status, and HumanNeeded state. It MAY
expose typed create/manage-member/create-task/cancel/retry-with-reselected-assignee/result-review
operations only through existing Service transitions. It MUST NOT provide a generic
`/v1/commands` proxy, a standalone reassign route, or a second collaboration state machine.

The HTTP allowlist SHALL use typed resource routes: `GET /portal/api/projects`,
`GET /portal/api/workers`, `GET /portal/api/agents`,
`GET /portal/api/projects/{projectId}/coordination`, `POST /portal/api/projects`,
`PATCH /portal/api/projects/{projectId}/members`,
`POST /portal/api/projects/{projectId}/tasks`, `POST /portal/api/tasks/{taskId}/cancel`,
`POST /portal/api/tasks/{taskId}/retry`, and
`POST /portal/api/records/{projectRecordId}/review`. `/portal/api/commands` SHALL remain a fixed
404 tombstone and MUST NOT accept an arbitrary command envelope.

#### Scenario: Authenticated user views a Project

- **WHEN** a portal session requests a Project visible to its User
- **THEN** the BFF SHALL return the canonical current Project/Task/result projection with bounded
  pagination and stable safe identifiers
- **AND** SHALL preserve existing membership and ownership authorization.

#### Scenario: Project collections exceed one Portal page

- **WHEN** Tasks, Project records, or visible HumanNeeded entries exceed their independent page
  bound
- **THEN** the BFF SHALL return three Project-bound opaque next cursors and SHALL page each
  collection independently with keyset queries
- **AND** the browser SHALL disclose truncation, merge pages by stable ID, reject repeated or
  cross-Project cursors, and retain the current execution/revision fence for actions on any loaded
  page.

Portal response packing SHALL run in `O(total candidate serialized bytes)`: each candidate item
SHALL be serialized exactly once for byte accounting, selection SHALL reuse that size with bounded
cursor/envelope reservation, and only a fixed bounded number of final whole-envelope rechecks MAY
occur. The final response MUST fit the fixed Portal byte ceiling or fail with
`payload_too_large`; A MUST NOT repeatedly serialize every accepted prefix or emit an oversized
page.

#### Scenario: User requests another user's private state

- **WHEN** a portal session names a Project/resource it cannot read
- **THEN** the BFF SHALL return the canonical not-found/permission boundary without leaking owner,
  OIDC, Device, credential, or existence details.

#### Scenario: Owner or Coordinator invokes a permitted portal action

- **WHEN** an authenticated session submits a typed mutation with valid CSRF and idempotency plus
  the route-applicable revision/execution, membership, role, and current-state inputs
- **THEN** the BFF SHALL invoke the one canonical Service transition and return its authoritative
  result
- **AND** SHALL preserve audit, Inbox, confirmation, execution fencing, transaction, and typed
  conflict semantics.

Project creation SHALL require idempotency but no nonexistent prior revision; member update and
task creation SHALL fence the current Project revision; task cancel/retry SHALL fence both Task
revision and execution ID; project-record review SHALL fence the record revision.

For Project creation, the BFF SHALL derive one actor-scoped idempotency key from the canonical
mutation facts so a lost response, browser reload, or replacement browser-generated header cannot
create a duplicate Project. The browser SHALL never evict an unresolved ambiguous mutation merely
to admit another one; once its fixed unresolved-operation capacity is reached, it SHALL reject the
new operation until an earlier operation is authoritatively reconciled.

#### Scenario: Browser attempts a raw or unauthorized command

- **WHEN** a portal client supplies an arbitrary command type/envelope, omits CSRF or revision
  fencing, or lacks the required Project role
- **THEN** the BFF SHALL reject it before business mutation
- **AND** SHALL NOT forward it to `/v1/commands`, elevate the session to an Agent, or add a
  browser-specific fallback transition.

#### Scenario: Browser calls the removed generic command relay

- **WHEN** any caller requests `/portal/api/commands`
- **THEN** A SHALL return the fixed portal not-found contract with HTTP 404
- **AND** SHALL NOT parse or dispatch the supplied command envelope.

#### Scenario: Portal event connection

- **WHEN** an authenticated portal session connects to `/portal/events` with the exact allowed
  origin
- **THEN** A SHALL stream/replay only that User's allowed portal projection events
- **AND** SHALL reject Agent credentials, wrong origins, expired sessions, and raw `/v1/events`
  protocol assumptions.

#### Scenario: Portal event connection or wake flood

- **WHEN** one identity opens excessive sockets, a socket never subscribes or stops answering
  heartbeat frames, or Inbox activity arrives in a burst
- **THEN** A SHALL enforce fixed global/per-identity connection and subscription limits, close idle
  or dead sockets, bound send buffering and Project-read concurrency, and coalesce wake work
- **AND** a direct User notification SHALL not scan another User's subscriptions; Agent-originated
  fallback wakes SHALL remain single-flight and bounded.

#### Scenario: Project data changes while the event connection is idle

- **WHEN** a subscribed Project changes or the periodic reconciliation deadline arrives
- **THEN** the event hub SHALL compare only lightweight authorized Project/member/Task/record and
  target-User HumanNeeded revision watermarks, without loading Task bodies, result bodies, prompts,
  or HumanAnswers
- **AND** the HTTP Portal view SHALL remain the sole bounded source of authoritative content.

### Requirement: Canonical coordination materialization SHALL fail before unbounded allocation

The canonical full-snapshot `getProjectCoordinationView` SHALL remain available to its authorized
Desktop consumers, but SHALL execute a two-stage native preflight within the same read-only
repository snapshot before materializing active members, Tasks, Project records, HumanNeeded
requests, or HumanAnswers. The first stage SHALL count all five collections and enforce their
individual invariants plus a combined maximum of 8,000 rows. Only when that stage passes MAY the
second stage estimate conservative serialized bytes for all five collections. Raw JSON bytes,
per-row overhead, Project JSON, and fixed envelope headroom together SHALL fit within 4 MiB. The
materialized final JSON SHALL receive a second 4 MiB guard. Every limit failure SHALL use stable
`payload_too_large` and SHALL produce no Project, receipt, audit, expiry, or collection write.

The independently keyset-paged Portal coordination view SHALL NOT invoke this aggregate
full-snapshot preflight. It SHALL remain available for authorized inspection of a Project that is
valid under canonical cardinality invariants but too large for the canonical full snapshot.

#### Scenario: Canonical row count exceeds the full-snapshot ceiling

- **WHEN** the native count-only preflight reports more than an individual collection invariant or
  more than 8,000 combined active-member, Task, record, HumanNeeded, and HumanAnswer rows
- **THEN** A SHALL return `payload_too_large` before running serialized-byte statistics or loading
  any full collection
- **AND** the read SHALL remain free of business or maintenance writes.

#### Scenario: Legal fields exceed the serialized-byte ceiling

- **WHEN** the row count passes but conservative native JSON-byte statistics, including legal
  maximum fields and JSON escaping, exceed 4 MiB
- **THEN** A SHALL return `payload_too_large` before materializing the full arrays
- **AND** an underestimated preflight SHALL still be caught by the final materialized-JSON guard.

#### Scenario: Portal inspects a Project larger than the canonical snapshot bound

- **WHEN** an authorized Project remains within canonical write invariants but exceeds the
  8,000-row or 4 MiB full-snapshot bound
- **THEN** the canonical full snapshot SHALL fail closed while the Portal MAY continue through its
  independently bounded collection pages
- **AND** the Portal SHALL NOT bypass authorization, collection cursors, or its own response-byte
  ceiling.

### Requirement: Public expiry handling SHALL remain scope-local

Public reads and polls MUST NOT invoke global expiry or retention pruning. Inbox polling MAY
materialize sequence-preserving tombstones only for the authenticated recipient in one short
transaction. Confirmation reads SHALL project expiry without durable mutation. HumanNeeded answer
admission MAY persist expiry only through an exact authorized request compare-and-set. Global GC
SHALL remain a separately invoked, throttled maintenance boundary.

#### Scenario: Recipient polls an Inbox containing expired messages

- **WHEN** an authenticated recipient polls its Inbox at a fixed read timestamp
- **THEN** A SHALL first lock that recipient's cursor and supersede only its active expired messages
  whose sequence is greater than the acknowledged sequence, then read the page and cursor in the
  same transaction
- **AND** acknowledged rows, active future rows, every other recipient, receipts, challenges,
  HumanNeeded requests, and confirmations SHALL remain untouched while superseded tombstones
  continue to preserve contiguous ACK semantics.

#### Scenario: Authorized actor reads an expired action confirmation

- **WHEN** A reads one approved confirmation by ID, authorizes the caller, and its expiry is at or
  before the fixed `readAt`
- **THEN** the response SHALL project `superseded`
- **AND** durable status, revision, and timestamps SHALL remain unchanged, while any later governed
  consumption SHALL still lock and reject the expired confirmation.

#### Scenario: Authorized HumanNeeded answer arrives at the expiry boundary

- **WHEN** A reads and authorizes one HumanNeeded request and it was already pending-and-expired at
  the command-admission timestamp
- **THEN** A SHALL atomically expire only the row matching exact request ID, target User, expected
  revision, pending status, and expiry predicate before rejecting the answer as expired
- **AND** concurrent attempts SHALL advance that request at most once, another request SHALL remain
  unchanged, and an answer admitted before expiry MAY complete using the same fixed admission
  timestamp even if lock acquisition crosses the wall-clock expiry.

### Requirement: Portal collection cardinality SHALL be fixed and concurrency-safe

The canonical Service SHALL limit each User to 1,000 active Project memberships, each Project to
50,000 Project records, and each Project to 10,000 HumanNeeded requests. These are authoritative
write invariants, not presentation-only page limits. Project creation SHALL count its Owner and all
members. Member additions and reactivations SHALL take transaction-scoped per-User serialization
locks in stable User-ID order before counting; Owners SHALL receive no exemption. Record and
HumanNeeded inserts SHALL count only while holding their canonical Project row lock. A write that
would exceed a limit SHALL fail without changing Project, membership, record, HumanNeeded, Inbox,
or accepted receipt state, while retaining the canonical rejected audit fact.

#### Scenario: Concurrent membership writes meet the per-User boundary

- **WHEN** one User has 999 active Project memberships and two transactions concurrently create,
  add, or reactivate that User in different Projects
- **THEN** the transactions SHALL serialize on the same stable per-User lock and exactly one MAY
  create the 1,000th active membership
- **AND** the other SHALL fail without allowing 1,001 active memberships, including when the User
  is a Project Owner.

#### Scenario: Concurrent Project child writes meet a watermark boundary

- **WHEN** concurrent canonical writers attempt to create the final allowed and first disallowed
  ProjectRecord or HumanNeeded row for one Project
- **THEN** the existing Project lock SHALL serialize the count-and-insert operation and only the
  final allowed row MAY commit
- **AND** Portal/event watermark inputs SHALL remain bounded at 50,000 records and 10,000
  HumanNeeded requests.

### Requirement: HumanNeeded SHALL be display-only

The portal SHALL show only safe, authorized HumanNeeded status/context. This change MUST NOT expose
an answer, approve, reject, command-template execution, or hidden HumanNeeded mutation endpoint.

#### Scenario: Target User has a pending HumanNeeded

- **WHEN** the target User views the associated portal Project or notification list
- **THEN** the portal SHALL display only allowlisted request identifiers, Project/Task association,
  status, expiry, and required assurance for that exact target User
- **AND** SHALL NOT return the prompt, confirmable action, HumanAnswer, answer text, or endpoint
  provenance to the browser
- **AND** SHALL label the request as requiring another verified SciForge human endpoint.

#### Scenario: Browser attempts to answer

- **WHEN** a client submits an answer-like request to `/portal/api/*` or manipulates the static UI
- **THEN** A SHALL return method-not-allowed/not-found/permission failure without creating a
  HumanAnswer or confirmation
- **AND** existing Project, Task, HumanNeeded, Inbox, and audit state SHALL remain unchanged.

### Requirement: Global worker directory SHALL remain test-only and non-authoritative

The global worker directory SHALL be available only when the fixed OIDC test release enables
`SCIFORGE_COLLABORATION_PORTAL_TEST_WORKER_DIRECTORY_ENABLED=true`. It SHALL be visibly labeled
test-only, bounded, read-only, and limited to safe operational worker fields. It MUST NOT grant Task
assignment, credential, Device, OIDC identity, or cross-user command authority.

#### Scenario: OIDC test release lists multiple Workers

- **WHEN** an authenticated test User opens the directory and the fixed test flag is enabled
- **THEN** the portal MAY page through all currently usable test Workers, at most 50 per page,
  using Cloud `ownerUserId`, opaque Agent ID, safe display name, Desktop/Server, OS/arch,
  runtime/capability IDs, GPU summary, derived status, exact `lastSeenAt`, and profile expiry
- **AND** SHALL disclose no bearer, public key, OIDC subject/email, session, or private trace.

#### Scenario: Directory and Project pages are read repeatedly

- **WHEN** an authenticated Portal performs its normal Worker lease refresh or Project pagination
- **THEN** PostgreSQL SHALL apply issuer/status/profile filters, busy-state aggregation, stable
  keyset cursors, and page limits before materializing rows
- **AND** SHALL use release-owned indexes for active owned-Agent, Project membership in both
  directions, Task, candidate result, record, HumanNeeded, HumanAnswer coordination preflight,
  assignee, and active-OIDC lookup paths
  instead of loading or sorting the complete tenant dataset in Node.

#### Scenario: Non-test release or disabled flag

- **WHEN** the portal runs outside the explicit OIDC test profile or the flag is absent/false
- **THEN** the global directory route and UI SHALL be unavailable
- **AND** MUST NOT silently fall back to an unrestricted Agent query.

#### Scenario: Directory user attempts cross-user control

- **WHEN** a User selects or names a Worker owned outside their existing collaboration authority
- **THEN** the directory SHALL provide no new mutation permission
- **AND** canonical Project/Task membership and assignment checks SHALL remain authoritative.

### Requirement: Portal assets SHALL be fixed-release inputs

The release bundle SHALL contain exactly one `@sciforge/collaboration-portal` npm archive in
addition to the existing four packages. The builder SHALL verify the packed archive's
`dist/.vite/manifest.json`, package integrity manifest, and every sorted regular runtime asset.
Release manifest schema 4 SHALL bind package/archive, manifest, asset path/size/SHA-256, route,
client, redirect, feature, and CSP values. The client secret MUST NOT appear in any bundle input.
The same manifest SHALL keep public `oidcAuthorizedParties` exactly
`sciforge-desktop,sciforge-web-mobile` and bind the independent `portalAuthorizedParty` exactly
`sciforge-cloud-console`; neither value may be widened or substituted for the other.
The packed collaboration-contract artifact manifest SHALL record `databaseSchemaVersion: 9`, and
the bundle builder SHALL reject a stale value before publishing the fixed bundle.

#### Scenario: Valid portal package is bundled

- **WHEN** a clean fixed commit produces a portal archive whose manifests and files agree
- **THEN** the builder SHALL create a five-package lockfile and schema-4 OIDC manifest with the
  complete portal bindings
- **AND** the runtime image SHALL install and verify the same package and assets without compiling
  source.

#### Scenario: Asset was added, removed, changed, symlinked, or left unlisted

- **WHEN** the packed Vite/integrity manifests and actual runtime file set differ
- **THEN** bundle/image validation SHALL fail before deployment
- **AND** operators MUST NOT repair the bundle by editing a digest or copying a loose file.

#### Scenario: Secret scanning the fixed release

- **WHEN** static and bundle tests inspect the manifest, package archives, generated lock, Caddy,
  Compose, Dockerfile, and browser assets
- **THEN** no portal client secret, authorization code, access token, refresh token, ID token, or
  real credential SHALL be present
- **AND** only the non-secret client ID and redirect URI SHALL be bound to the manifest.

#### Scenario: Public and Portal authorized parties are crossed

- **WHEN** the public `/v1` authorized-party list includes `sciforge-cloud-console`, or the Portal
  authorized party is not the exact confidential client
- **THEN** manifest, static-policy, or runtime validation SHALL reject the release
- **AND** A MUST NOT promote the candidate by treating one verifier as the other.

### Requirement: Portal deployment SHALL preserve the A edge isolation boundary

Only the explicit `a-https-oidc-test` profile SHALL enable the portal. Its root-only mode-0600 env
file SHALL provide the confidential secret; Compose SHALL inject it only into `app`. Edge,
PostgreSQL, and migration containers SHALL not receive it. TCP 443 SHALL remain the only public
listener; 80, UDP 443, 8080, 8787, 9000, and 5432 SHALL remain unpublished. The Portal edge SHALL
overwrite, not append or trust, inbound `X-Forwarded-For` with one canonical `{remote_host}` value.
The app SHALL accept that value only from a private/loopback socket peer and SHALL reject lists,
duplicates, malformed IPs, or forwarded identity from any other peer.

The Portal release SHALL advance the collaboration database to schema v9 through the exact
forward-only `0009_portal_bounded_reads.sql` migration. Before production migration, the
compatibility-named isolated PostgreSQL verifier SHALL prove the v5 baseline is not ready, migrate
through versions `[1,2,3,4,5,6,7,8,9]`, prove current readiness, and emit all ten exact Portal/coordination
bounded-read index names in its pass receipt. Existing verifier/attestation filenames and field
names SHALL remain unchanged for deployment compatibility; their names MUST NOT be interpreted as
the database target version. Post-migration live verification SHALL repeat the exact table,
B-tree/non-unique, key-column, and partial-predicate checks before accepting the app.

The ten non-unique B-tree definitions SHALL be exact:

- `agent_nodes_active_owner_agent_idx` on `agent_nodes(owner_user_id,agent_id)` where
  `status='active'`;
- `human_answers_project_created_answer_idx` on
  `human_answers(project_id,created_at,human_answer_id)` without a predicate;
- `human_requests_project_target_request_id_idx` on
  `human_requests(project_id,target_user_id,human_request_id)` without a predicate;
- `oidc_identities_active_user_issuer_idx` on `oidc_identities(user_id,issuer)` where
  `status='active'`;
- `project_members_active_project_user_idx` on `project_members(project_id,user_id)` where
  `active=true`;
- `project_members_active_user_project_idx` on `project_members(user_id,project_id)` where
  `active=true`;
- `project_records_candidate_task_result_project_idx` on `project_records(project_id)` where
  `kind='task_result' AND status='candidate'`;
- `project_records_project_record_id_idx` on
  `project_records(project_id,project_record_id)` without a predicate;
- `tasks_active_assignee_idx` on `tasks(assignee_agent_id)` where status is one of `accepted`,
  `in_progress`, or `needs_human`;
- `tasks_project_task_id_idx` on `tasks(project_id,task_id)` without a predicate.

Migration `0009` SHALL also repair only null legacy ProjectRecord User authors. A Task source SHALL
exist and name the same assignee Agent, but its assignee User SHALL NOT be treated as historical
evidence because Agent ownership transfer cascades that field. For each null author, the migration
SHALL use the User actor of the earliest accepted `agent.owner.transfer` audit for the author Agent
whose timestamp is strictly after the record timestamp; when no such later transfer exists, it MAY
use the Agent's current owner. Equal-time or duplicate-time transfers, malformed transfer audit
identity, mismatched Task provenance, and otherwise unresolvable null authors SHALL fail migration
before the version marker, after which `author_user_id` SHALL be `NOT NULL`. Existing non-null authors
SHALL remain uninspected and unchanged even when the Agent now has another owner.

Before either the cap checks or author reconstruction, migration `0009` SHALL lock
`user_principals`, `agent_nodes`, `projects`, `tasks`, `project_members`, `project_records`,
`human_requests`, and `audit_events` in that fixed order with `SHARE ROW EXCLUSIVE`. It SHALL fail
before the version marker when any historical User has more than 1,000 active memberships, any
Project has more than 50,000 records, or any Project has more than 10,000 HumanNeeded requests.
The corresponding migration diagnostics SHALL be
`migration_0009_active_project_membership_limit_exceeded`,
`migration_0009_project_record_limit_exceeded`, and
`migration_0009_human_needed_limit_exceeded`.

#### Scenario: Schema-v9 bounded-read gate is incomplete

- **WHEN** the packed contract artifact still records schema8, version 9 is absent, or
  `agent_nodes_active_owner_agent_idx`, `human_answers_project_created_answer_idx`,
  `human_requests_project_target_request_id_idx`,
  `oidc_identities_active_user_issuer_idx`, `project_members_active_project_user_idx`,
  `project_members_active_user_project_idx`, `project_records_candidate_task_result_project_idx`,
  `project_records_project_record_id_idx`, `tasks_active_assignee_idx`, or
  `tasks_project_task_id_idx` is missing or has the wrong target table, key columns, B-tree/non-unique
  property, or partial predicate
- **THEN** bundle publication or the isolated database gate SHALL fail before production migration
- **AND** no compatibility-named attestation SHALL be accepted as proof of schema v9.

#### Scenario: Schema-v9 historical collection cap is already exceeded

- **WHEN** the v5 baseline contains 1,001 active memberships for one User, 50,001 Project records
  for one Project, or 10,001 HumanNeeded requests for one Project
- **THEN** migration `0009` SHALL fail closed with the matching stable cap diagnostic before
  inserting version 9
- **AND** the isolated verifier, live verifier, and release receipt SHALL NOT claim schema-v9
  readiness.

#### Scenario: Legacy ProjectRecord author is repaired without rewriting history

- **WHEN** schema v5 contains the Agent-only TaskResult generated by migration `0004`, its Agent is
  then transferred twice (cascading the Task assignee User), and a separate non-null historical
  author predates those transfers
- **THEN** migration `0009` SHALL recover the null TaskResult author from the first later accepted
  transfer's User actor, preserve the non-null historical author exactly, and make
  `author_user_id` non-null
- **AND** a missing/mismatched Task source, a transfer at the exact record timestamp, two transfers
  at the same later timestamp, malformed transfer evidence, or another unresolvable null author
  SHALL abort the migration without writing version 9.

#### Scenario: Client spoofs a forwarded chain

- **WHEN** a public Portal request supplies a multi-hop or attacker-selected `X-Forwarded-For`
- **THEN** Caddy SHALL replace it with the single canonical edge-observed remote host before proxying
- **AND** the app SHALL never use the supplied chain for rate, audit, or authorization identity.

#### Scenario: Portal secret missing or placeholder

- **WHEN** OIDC test deployment has no strong portal client secret or has a placeholder/duplicate
  env entry
- **THEN** deployment SHALL stop before rebuilding/restarting app, database, Keycloak, or edge
- **AND** diagnostics SHALL identify only the configuration key, not its value.

#### Scenario: Candidate release verifies successfully

- **WHEN** bundle, image, app, edge, local route/header/auth, Discovery/JWKS, and external probes all
  match the fixed commit
- **THEN** the existing candidate approval marker/restart-policy protocol MAY promote the edge
- **AND** the evidence SHALL still distinguish repository/offline gates, Keycloak client readiness,
  real browser login, and Desktop multi-worker E2E.

#### Scenario: Portal deployment fails

- **WHEN** any portal or existing A verification gate fails
- **THEN** the unverified candidate and public edge SHALL stop while PostgreSQL, the verified
  pre-maintenance backup, ACME state, Keycloak, networks, logs, and release evidence are preserved
- **AND** if the database is already schema v9, rollback SHALL either keep a schema9-compatible app
  with Portal/public edge disabled or restore the compatible backup into a new database before
  starting the previous fixed commit/bundle/image
- **AND** `7ad/schema5` or any schema-incompatible old app MUST NOT connect directly to schema9,
  and portal users SHALL log in again after either safe recovery path.

### Requirement: Portal CSP SHALL be exact and release-bound

The portal SHALL receive the exact schema-4 CSP allowing only same-origin runtime resources and
HTTP/WSS connections while denying objects, frames, embedding, and base changes. It MUST NOT use
`unsafe-inline`, `unsafe-eval`, wildcard sources, or a Keycloak iframe. Non-portal responses SHALL
retain the existing default-deny CSP.

#### Scenario: Portal HTML and auth/API response headers

- **WHEN** local or external verification requests the portal entry and unauthenticated BFF
  boundaries
- **THEN** each SHALL carry the fixed revision, HSTS, no-sniff, frame denial, referrer policy, and
  route-appropriate no-store/CSP headers
- **AND** SHALL expose no CORS wildcard, server banner, HTTP/3 advertisement, or CSP weakening.

#### Scenario: Caddyfile CSP differs from release manifest

- **WHEN** the edge file or manifest contains a different portal CSP literal
- **THEN** static policy or fixed-asset verification SHALL reject the release before public
  promotion.

### Requirement: Keycloak client provisioning SHALL remain an external readiness gate

Repository implementation SHALL document, but SHALL NOT perform, creation or mutation of the
Keycloak client. Real browser acceptance requires an enabled confidential
`sciforge-cloud-console` client, exact issuer/redirect/origin, standard flow, disabled implicit and
direct grants, correct audience/claims, and a separately delivered secret.

#### Scenario: Repository and offline tests pass before client provisioning

- **WHEN** source, bundle, static policy, and fixture BFF tests pass but the real Keycloak client is
  not yet ready
- **THEN** the change SHALL report repository implementation complete and real login pending
  maintenance-window input
- **AND** MUST NOT claim end-to-end browser authentication.

#### Scenario: Maintenance-window client acceptance

- **WHEN** Keycloak owner confirms all non-secret client settings and A installs the secret through
  the approved root-only channel
- **THEN** A SHALL run real login, session refresh/expiry, logout, portal read, event, HumanNeeded
  display-only, and test-worker-directory acceptance
- **AND** SHALL exercise the typed Project create/list/coordination, member update, Task create,
  Task cancel/retry-with-reselected-assignee, and project-record accept/reject flows with their
  canonical idempotency, revision, execution, role, and cross-user denial gates
- **AND** SHALL prove old cookie/WebSocket invalidation, attempted refresh-token revocation,
  public `/v1` rejection of the Portal authorized party, Portal rejection of public-client tokens,
  and no claimed RP/end-session redirect
- **AND** evidence SHALL redact codes, cookies, tokens, client secret, OIDC subject, and personal
  fields.
