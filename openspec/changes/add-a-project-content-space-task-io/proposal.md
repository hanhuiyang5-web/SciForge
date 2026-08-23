# Change: Add A Project Content Space Task I/O

## Why

Cloud Collaboration can already route a Task to a packaged Desktop Worker and persist structured
results, but the integrated Desktop runtime deliberately rejects every Task carrying ResourceRefs.
Content Space already owns provider-neutral portable references and real file transfer operations,
so the missing authority is a Project-scoped Cloud binding plus one deterministic file-intent
contract that both A and the Desktop Worker can fence.

Run 0 must prove one real file loop without moving provider credentials or file authority into A:
the Coordinator selects an already-authorized Team directory, creates a Task with one or more real
input files and an upload-new output target, the Worker materializes and transfers through E, and A
persists the output ResourceRefs, Task result, and candidate ProjectRecord. The Coordinator then
downloads the output through E and verifies its SHA-256.

## What Changes

- Add Cloud-owned `ProjectContentSpaceBinding` v1 with one active root container per Project and an
  exclusive active Project claim on that root ResourceRef.
- Add `TaskFileIntent` v1 to Task creation and Task entities. It binds the exact binding revision,
  ordered input ResourceRefs and safe destination names, and one upload-new output container.
- Add owner-only bind, unbind, and read commands, with Project revision fencing and audit receipts.
- Advance the collaboration database from schema v9 to v10 with the binding table, nullable Task
  file-intent storage, constraints, indexes, and release-readiness checks.
- Validate Task file intent atomically against the active Project, binding revision, ResourceRef
  status/project/kind/portable-reference contract, and assignee authority.
- Remove the Desktop Worker Runner's blanket metadata-only rejection. File-bearing Tasks execute
  only when their strict `TaskFileIntent` is present and an E-owned provider-neutral Task file port
  is installed; legacy metadata Tasks remain valid.
- Persist uploaded output ResourceRefs through the existing task-scoped `resource.create` path and
  complete through the existing structured Task result and automatic candidate ProjectRecord path.
- Add an owner-direct Project binding and Task creation product entry plus a fixed Run-0 receipt
  that binds Cloud, both packaged Desktops, E operations, input/output hashes, and the final commit.

## Capabilities

### New Capabilities

- `project-content-space-task-io`: Project binding authority, Task file intent, Desktop execution
  handoff, and exact Run-0 evidence.

### Modified Capabilities

- `content-space`: E supplies the provider-neutral background Task file port and reauthorizes every
  materialized reference under the selected root; it does not own Project or Task state.

## Impact

- Collaboration contracts/server: new entity, commands, Task field, repository methods, migration
  v10, strict validation, audit, generated artifacts, and release gates.
- Desktop collaboration/project-coordinator: owner-direct binding/file Task inputs and a Worker
  Runner that consumes the E port without provider imports.
- Content Space integration boundary: one package-owned provider-neutral Task file port contribution;
  no Cloud bearer, Project authority, local absolute path, provider DTO, or credential crosses it.
- Deployment: a new fixed commit, schema-v10 isolated migration proof, packaged two-account Desktop
  preflight, and a redacted real-file E2E receipt. No live deployment is performed by this change.
