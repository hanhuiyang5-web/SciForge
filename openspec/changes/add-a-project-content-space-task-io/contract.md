# Contract checkpoint: Project Content Space Task I/O v1

This attachment is the reviewable A-side contract checkpoint for Change 2. It is deliberately
checked into the branch so other owners can review it without access to the originating worktree.
The executable source of truth remains the strict Zod schemas and generated protocol artifacts
listed below; this document freezes their complete wire shape and the cross-domain invariants that
JSON Schema alone cannot express.

## Authoritative sources

- `packages/collaboration-contracts/src/entities.ts`
- `packages/collaboration-contracts/src/portable-resource.ts`
- `packages/collaboration-contracts/src/task-proposal.ts`
- `packages/collaboration-contracts/artifacts/protocol-1.0/schemas/entities.schema.json`
- `packages/collaboration-contracts/artifacts/protocol-1.0/schemas/commands.schema.json`
- `packages/collaboration-server/migrations/0010_project_content_space_task_io.sql`

Every object below is exact: unknown properties are rejected. `Revision` is an integer in
`[1, 9007199254740991]`; `Timestamp` is an RFC 3339 date-time with an explicit offset; all opaque
IDs match `^<prefix>_[A-Za-z0-9](?:[A-Za-z0-9_]{10,62}[A-Za-z0-9])$`.

## `ProjectContentSpaceBinding` v1 complete schema

```ts
type ProjectContentSpaceBindingV1 = Exact<{
  schemaVersion: 1
  type: 'project_content_space_binding'
  projectId: OpaqueId<'prj'>
  rootResourceRefId: OpaqueId<'rrf'>
  status: 'active' | 'closed'
  revision: Revision
  createdAt: Timestamp
  updatedAt: Timestamp
}>
```

The public entity has no separate binding ID. Its identity and PostgreSQL primary key are
`projectId`; one row represents the complete binding lifecycle of one Project. First bind creates
revision 1. Replace, re-activate, and close update that row, increment `revision`, preserve
`createdAt`, and update `updatedAt`.

### Binding root unique key and scope

The root has two distinct keys:

1. `projectId` is the per-Project binding key and database primary key.
2. `rootReferenceDigest` is an internal, non-wire, 32-byte key computed as
   `SHA-256(UTF8(stableJson(rootResourceRef.portableReference)))`, where `stableJson` recursively
   sorts object keys and preserves array order. The partial unique index
   `project_content_space_bindings_active_root_unique(root_reference_digest) WHERE status='active'`
   is global to the A collaboration database. Therefore the same canonical provider directory
   cannot be active for two Projects, even through two different A `ResourceRef` rows.

The composite foreign key `(project_id, root_resource_ref_id)` points to
`resource_refs(project_id, resource_ref_id)`, so the root row must belong to the same Project.
Binding does not grant provider authority: it records the selected root after A authorization;
E still reauthorizes every provider operation under the current Principal.

## `TaskFileIntent` v1 complete schema

```ts
type TaskFileIntentV1 = Exact<{
  schemaVersion: 1
  bindingRevision: Revision
  inputs: Array<Exact<{
    resourceRefId: OpaqueId<'rrf'>
    destinationName: TaskFileDestinationName
  }>> // 1..100
  output: Exact<{
    containerResourceRefId: OpaqueId<'rrf'>
    mode: 'upload-new'
  }>
}>

type TaskFileDestinationName = TrimmedString<1, 128> &
  Not<'.' | '..'> &
  NoCharacters<'/' | '\\' | UnicodeControlCharacter>
```

Additional exact refinements:

- `inputs[].resourceRefId` values are unique by exact string comparison.
- `inputs[].destinationName` values are unique by exact string comparison.
- no input `resourceRefId` equals `output.containerResourceRefId`.
- Task `resourceRefIds` is not an independent caller-controlled truth. It is exactly the ordered
  input IDs followed by the output container ID. Reordering, omission, or addition is rejected.
- `bindingRevision` is the revision of the active Project binding locked during Task creation. It
  is immutable with the Task. A stale value is a revision conflict, not an implicit rebind.

### Input/output roles, destination name, and output name

The v1 role is structural, not a caller-supplied discriminator:

- every `inputs[]` member has role `input-file`;
- `output` has role `output-container`, and is exactly the active binding root;
- adding a `role` property to either object is rejected by the exact schema.

`destinationName` is a portable single path component chosen at Task creation. It is the only
Task-controlled local filename hint and never contains a directory or absolute path.

An output file name is intentionally not predeclared by `TaskFileIntent` v1. It is produced later
by the B-owned strict `AgentRunResult.outputs[]` contract:

```ts
type AgentOutput = Exact<{
  name: TrimmedString<1, 255> & NoCharacters<'/' | '\\'>
  workspaceRelativePath: PortableWorkspaceRelativePath<1, 4096>
}>
```

Output names are unique by exact string comparison and `criterionEvidence[].outputNames` may cite
only declared output names. The current A branch WorkerRunner integration converts each name to an
E upload-new entry name and caps it at 128 characters. This is a cross-domain integration detail,
not an A wire field; B must freeze or tighten its final output-name rule before taking ownership.

## `ResourceRef` v1 complete schema

All listed properties are required; nullable properties must be present with either their value or
`null`.

```ts
type ResourceRefV1 = Exact<{
  schemaVersion: 1
  type: 'resource_ref'
  resourceRefId: OpaqueId<'rrf'>
  projectId: OpaqueId<'prj'>
  taskId: OpaqueId<'tsk'> | null
  executionId: OpaqueId<'exe'> | null
  taskRevision: Revision | null
  createdByUserId: OpaqueId<'usr'>
  createdByAgentId: OpaqueId<'agt'> | null
  provider: ProviderId
  externalId: ResourceExternalId
  kind: ResourceKind
  name: ResourceName
  openUrl: SafeHttpsUrl | null
  portableReference: PortableResourceReferenceCarrier | null
  version: ResourceVersion | null
  status: 'available' | 'unavailable' | 'revoked' | 'invalidated'
  statusReasonCode: SafeFailureCode | null
  unavailableAt: Timestamp | null
  revokedAt: Timestamp | null
  invalidatedAt: Timestamp | null
  revision: Revision
  createdAt: Timestamp
  updatedAt: Timestamp
}>

type ProviderId = StringMatching<'^[a-z][a-z0-9.-]{0,63}$'>
type ResourceKind = StringMatching<'^[a-z][a-z0-9._-]{0,127}$'>
type ResourceExternalId = TrimmedString<1, 512>
type ResourceName = TrimmedString<1, 200>
type ResourceVersion = TrimmedString<1, 200>
type SafeFailureCode = StringMatching<'^[a-z][a-z0-9_.-]{0,63}$'>

type PortableResourceReferenceCarrier = Exact<{
  contractVersion: 1
  kind:
    | 'content-space.file-reference'
    | 'content-space.container-reference'
    | 'content-space.artifact-reference'
  authority: StringMatching<'^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$'>
  identity: JsonObject
}>
```

`ResourceExternalId`, `ResourceName`, and `ResourceVersion` reject control characters and embedded
credential material. `externalId` additionally rejects file URLs and local absolute paths.
`openUrl` is HTTPS-only, has no userinfo or fragment, and rejects credential-bearing query keys or
values. The portable carrier is parsed by E's canonical codec and is bounded to 8192 serialized
bytes, 6144 identity bytes, depth 8, 256 identity nodes, collection size 64, and 1024 UTF-8 bytes
per string; forbidden local/network/credential/runtime-handle identities are rejected.

Cross-field refinements:

- the three `content-space.*-reference` kinds require exactly one non-null portable carrier, whose
  `kind` equals the ResourceRef `kind`; every other kind requires `portableReference: null`;
- `taskId`, `executionId`, and `taskRevision` are either all non-null or all null;
- `unavailableAt`, `revokedAt`, and `invalidatedAt` are non-null exclusively for their matching
  status;
- `statusReasonCode` is non-null exactly for `unavailable` or `revoked`.

For this change, a binding root is an `available`, Project-level (`taskId/executionId/taskRevision`
all null), `content-space.container-reference`. Task inputs are `available`, Project-level
`content-space.file-reference` rows. Uploaded outputs are Task-scoped file references whose
`taskId`, `executionId`, and `taskRevision` bind the creating execution.

## Root-descendant proof

A performs only the checks it can prove without parsing provider identity:

1. lock the Project and current binding;
2. require the output container ID to equal the active binding's `rootResourceRefId`;
3. require every input/output ResourceRef to be available, portable, and in the same Project;
4. require input kind `file-reference`, output kind `container-reference`, and Project-level
   provenance; and
5. freeze `bindingRevision` in the immutable Task.

These checks do **not** prove provider ancestry. Portable identity is opaque to A. At Worker
materialization time E must receive the canonical binding root and each selected file, resolve both
under the same current Host Principal and exact authority/provider instance, refresh provider ACL,
and return success only after a bounded canonical parent-chain/root-identity proof establishes
`file == root || file is a descendant of root`. The proof must reject cross-authority aliases,
cycles, missing parents, revoked access, stale handles, and depth/page-limit exhaustion. Upload-new
must target the materialized root itself; v1 does not permit a descendant output container.

The current `EContentSpacePort.materialize(reference)` integration cannot express a paired
`root + candidate` ancestry proof. Consequently A is contract-ready, while packaged file execution
remains blocked on the E/B handoff that adds and implements this paired authorization operation.
No provider-specific comparison may be added to A or WorkerRunner as a fallback.

## Assignment and execution fences

Task creation is serialized by the Project row lock and `expectedProjectRevision`. A verifies the
assignee Agent, linked Device/owner, active non-observer Project membership, capability profile,
budgets, dependencies, ResourceRefs, active binding, and `bindingRevision` in the same transaction,
then mints a fresh `executionId`.

The Worker reloads the Task and requires exact `(taskId, executionId, assigneeAgentId)` before the
first side effect and again before each transition, progress report, upload, ResourceRef register,
and terminal write. Every Cloud mutation carries the current Task revision. A independently checks
the authenticated Agent is the current assignee and that `executionId` and `expectedRevision` are
current. `resource.create` requires task ID, execution ID, and expected Task revision together and
stores all three on the output ResourceRef. Retry/reassign mints a new execution ID; a stale Worker,
journal replay, upload registration, progress report, or terminal transition then fails closed.

## Unbind and replacement behavior

Bind replacement and unbind are rejected while any file-bearing Task is in `offered`, `accepted`,
`in_progress`, or `needs_human`. Therefore a live execution can never lose or change its binding.

After unbind:

- the binding row remains, becomes `closed`, and increments its revision;
- terminal Tasks keep their immutable `fileIntent`, prior `bindingRevision`, result, and audit
  history;
- existing root, input, and task-scoped output ResourceRefs are not deleted, invalidated, revoked,
  or rewritten by unbind; their own lifecycle remains authoritative;
- provider content and ACL are not mutated;
- new file-bearing Tasks fail because there is no active binding;
- a later bind/replacement increments the same binding row revision, so an old Task intent cannot
  be replayed against the new root.

## Ownership of the WorkerRunner patch

The `packages/domains/project-coordinator` changes on this A branch are a separately committed
cross-domain integration checkpoint. They demonstrate how the frozen A contract can feed the
durable B/C pipeline, but they are not an A ownership transfer. B owns the final WorkerRunner and
must review/cherry-pick or replace that commit, freeze output-name behavior, and wire the E-owned
paired root-descendant authorization before this change can become integration-ready.

## Schema v10 base and migration path

- New database: apply `0001_collaboration_schema.sql` through
  `0010_project_content_space_task_io.sql` in exact numeric order.
- Existing production schema v9: apply only `0010_project_content_space_task_io.sql` inside its
  transaction after a fixed release backup and readiness preflight.
- Historical integration base: create v1, apply the exact v5 baseline `0002..0005`, prove v5 is not
  current-ready, then run `0006..0010` and require migration versions
  `[1,2,3,4,5,6,7,8,9,10]` plus exact schema-v10 table/column/constraint/index definitions.
- `0010` adds `project_content_space_bindings`, `(project_id, resource_ref_id)` ResourceRef
  uniqueness, the two binding foreign keys, the active root partial unique index, nullable
  `tasks.file_intent jsonb`, and the bounded top-level v1 JSON check. Existing Tasks remain NULL.

## Eight PostgreSQL tests and rerun plan

The eight real-PostgreSQL cases are the eight tests in
`packages/collaboration-server/src/postgres-v5.integration.test.ts`:

1. v1 -> v5 -> exact v10 migration/readiness and hard-cap evidence;
2. historical User/Agent author preservation and missing-author rejection;
3. rejection of same-name Portal indexes with wrong definitions;
4. concurrent OIDC first-use serialization;
5. enrollment single-use, installation ownership, Device cascade, and Agent linkage;
6. Device-revocation versus Agent-routing linearization;
7. both active Zulip uniqueness dimensions and rebind history; and
8. maximum-boundary portable artifact PostgreSQL/E-codec round trip.

Checkpoint rerun command (against an isolated PostgreSQL administrative database, never the
production database):

```bash
SCIFORGE_POSTGRES_V5_INTEGRATION=1 \
SCIFORGE_POSTGRES_V5_ADMIN_URL='postgresql://<admin>@127.0.0.1:5432/postgres' \
npm --workspace @sciforge/collaboration-server exec vitest run \
  src/postgres-v5.integration.test.ts
```

The suite creates a random `sciforge_identity_v10_it_<pid>_<hex>` database, runs all eight cases,
terminates its connections, and drops it in `afterAll`. Before merge/release, rerun the same eight
cases from the fixed candidate image through
`verify-postgres-v5-integration.sh <commit> <env> --confirm-isolated-database-test`; this is a test
gate, not deployment. The checkpoint must report them as skipped until a PostgreSQL admin URL or
the fixed candidate runner is available, and must not convert that skip into a pass.
