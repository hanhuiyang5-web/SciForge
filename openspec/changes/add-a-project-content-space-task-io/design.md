# Design: Add A Project Content Space Task I/O

## Context

The complete reviewable v1 wire schemas, non-JSON invariants, ownership boundary, unbind behavior,
and schema-v10 PostgreSQL rerun plan are frozen in [contract.md](contract.md). That checked-in
attachment is normative for this checkpoint; implementation and generated artifacts must match it.

A owns stable User, Device, Agent, Project, Task, ResourceRef, result, ProjectRecord, revision, and
Inbox authority. E owns portable Content Space references, provider credentials, provider ACL
checks, downloads, and upload-new writes. B/C already contain a durable Worker execution pipeline,
but production supplies an unavailable E port and phase-one policy rejects all ResourceRefs.

The Run-0 input is an existing Team root already authorized for two real Content Space accounts.
Automatic Team provisioning, autonomous planning, shared-document editing, CAS update, native
document semantics, ArtifactReference, and multi-worker execution are not part of this change.

## Goals

- Prove one packaged Coordinator-to-Cloud-to-packaged-Worker real file round trip.
- Keep one Project binding and one Task file-intent truth in A.
- Keep provider identity, credentials, ACL, transfer, and local workspace details in E.
- Reuse the existing task-scoped ResourceRef/result/ProjectRecord write path.
- Fail closed on stale Project/binding/Task revisions and on every authority mismatch.

## Non-Goals

- Provider-specific binding fields in A or B/C.
- A-side directory traversal, provider ACL inference, file bytes, local paths, or transfer handles.
- A second upload/result state machine or direct repository/database access from Desktop.
- Updating existing provider files; Run 0 is upload-new only.
- Automatic root discovery/provisioning or background Project orchestration.

## Decisions

### 1. A owns one versioned Project binding

`ProjectContentSpaceBinding` v1 is keyed by `projectId` and contains `rootResourceRefId`, `status`,
`revision`, and entity timestamps. `status` is `active | closed`. Only the Project Owner may bind,
replace, or unbind. Every mutation locks the Project, fences `expectedProjectRevision`, increments
the binding revision, and increments the Project revision in the same transaction.

An active root ResourceRef must be available, belong to the Project, contain a portable reference,
and have kind `content-space.container-reference`. A stores the stable digest of the canonical
portable reference and a partial unique index on that digest prevents the same provider directory,
including duplicate A ResourceRef rows, from serving two active Projects. Unbind closes the row; it
never deletes or changes the provider directory.

### 2. Task file intent is explicit and revision-bound

`TaskFileIntent` v1 contains:

```json
{
  "schemaVersion": 1,
  "bindingRevision": 3,
  "inputs": [
    { "resourceRefId": "rrf_...", "destinationName": "input.csv" }
  ],
  "output": {
    "containerResourceRefId": "rrf_...",
    "mode": "upload-new"
  }
}
```

Inputs are ordered, contain unique ResourceRef IDs and unique safe destination names, and are
bounded to 100 entries. Destination names are single path components and never local paths. The
output container is exactly the binding root in v1. `resourceRefIds` is derived as the exact unique
union of ordered input IDs plus the output container; callers cannot provide a divergent second
truth. Metadata-only Tasks omit `fileIntent` and retain the existing contract.

Task creation locks the Project, then reads the active binding and referenced ResourceRefs in the
same transaction. It rejects stale binding revision, a missing/closed binding, unavailable or
cross-Project references, task-scoped inputs, a non-portable reference, wrong Content Space kind,
or an output container different from the binding root. Existing assignee, capability, membership,
budget, Project revision, confirmation, and idempotency checks remain authoritative.

### 3. E reauthorizes the provider scope

A can prove only its own Project/ResourceRef/binding facts; the portable reference is intentionally
opaque to A. The E-owned Task file port receives the active root reference plus each selected input
reference and must rebind them under the current Cloud Principal, prove each input is the root or a
descendant permitted by provider ACL, and reject stale/revoked/mismatched provider authority.

E returns only provider-neutral outcomes: operation ID, bounded byte count, SHA-256, output portable
reference, and safe status. It never receives an A bearer, writes Project/Task state, or returns a
provider DTO, credential, broker handle, or absolute local path.

### 4. Reuse the existing durable Worker pipeline

The Worker Runner reads `Task.fileIntent`, materializes the binding root and inputs through the E
port, downloads each input to its declared destination, and passes workspace-relative paths to the
runtime-neutral AgentRuntime. It journals before every non-idempotent boundary. Output files are
uploaded with stable operation IDs derived from Task/execution/output index; each successful upload
is registered through task-scoped `resource.create`. The existing succeeded transition writes the
structured result and automatic candidate ProjectRecord atomically.

The Worker must not infer inputs or output target from ResourceRef ordering. A file-bearing Task
without `fileIntent`, a `fileIntent` with missing E port, or an Agent output outside the declared
upload-new contract is rejected/fails closed. Metadata-only Tasks keep the same path and require no
E port.

### 5. Schema v10 is forward-only

Migration `0010_project_content_space_task_io.sql` creates the binding table and adds nullable
`tasks.file_intent jsonb`. PostgreSQL enforces the immutable top-level v1 envelope, bounded inputs,
upload-new output envelope, safe output ResourceRef shape, root/status/revision constraints,
Project/ResourceRef foreign keys, and active portable-root digest uniqueness. The strict public Zod
contract and Task service additionally enforce every input item, uniqueness, destination-name, kind,
Project and authority invariant before storage. Existing Tasks receive NULL and remain valid.
Migration/readiness tests prove the ordered version chain `[1..10]`; old schema-v9 attestations and
bundles are not reusable.

### 6. Run-0 evidence is exact and redacted

The top receipt binds one final commit, Cloud manifest/database/image revision, two packaged Desktop
artifact digests, two distinct OIDC User/Device/Agent identities, Project/binding/Task/execution IDs,
the input ResourceRef and SHA-256, E download/upload operation IDs and byte counts, output portable
ResourceRef, Task result ProjectRecord, Coordinator re-download SHA-256, and pass/fail timestamps.
It contains no token, credential, provider secret, local absolute path, email, or raw provider DTO.
The OIDC fixed release manifest binds the receipt verifier SHA-256; the verifier in turn requires its
own digest in the receipt, schema v10, and the exact release-manifest digest. This creates one closed
provenance chain without packaging a receipt or any account material into the release bundle.

## Risks and Mitigations

- **Stale root or provider ACL:** A fences binding revision; E performs fresh provider authorization.
- **Duplicate upload after uncertain outcome:** the existing journal stops automatic replay when
  upload outcome is unknown; E operation ID provides provider-side idempotency evidence.
- **Dual Task resource truth:** `resourceRefIds` is derived from `fileIntent` at the contract/service
  boundary and stored only as the existing projection.
- **Cross-Project directory reuse:** active-root unique index plus owner/revision checks.
- **Local path leakage:** only safe destination names enter the contract and only workspace-relative
  paths return from E to the Worker.
