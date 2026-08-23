# Tasks: Add A Project Content Space Task I/O

## 1. Contract and migration

- [x] 1.1 Freeze `ProjectContentSpaceBinding` v1, `TaskFileIntent` v1, ownership boundaries, Run-0
  exclusions, schema v10, and fixed evidence in OpenSpec.
- [x] 1.2 Add strict collaboration entity/command/Task schemas, canonical task-proposal digest fields,
  generated artifacts, and negative contract vectors.
- [x] 1.3 Add migration `0010`, repository/Fake/PostgreSQL parity, exact readiness checks, and v9→v10
  integration coverage.
- [x] 1.4 Publish a branch-readable complete contract attachment covering binding, file intent,
  ResourceRef, root uniqueness/scope, descendant proof, execution fences, unbind semantics,
  WorkerRunner ownership, and the eight-test PostgreSQL rerun plan.

## 2. Cloud authority

- [x] 2.1 Implement owner-only bind/get/unbind with Project and binding OCC, active-root exclusivity,
  audit/receipt, and no provider mutation.
- [x] 2.2 Validate Task file intent atomically against the active binding, Project, ResourceRefs,
  assignee, portable kinds, and exact derived ResourceRef list.
- [x] 2.3 Preserve uploaded output ResourceRefs and complete through the existing structured result and
  automatic candidate ProjectRecord path; add full service/API regressions.

## 3. Desktop execution

- [ ] 3.1 Consume the E-owned provider-neutral Task file port without provider or host-private imports.
- [x] 3.2 Remove the blanket metadata-only rejection, drive downloads/uploads from `Task.fileIntent`,
  retain durable fences/manual recovery, and add WorkerRunner file-loop tests.
- [x] 3.3 Add owner-direct binding/file Task product inputs while keeping autonomous Coordinator disabled.

## 4. Release and real evidence

- [x] 4.1 Advance artifacts, bundle, deployment, isolated PostgreSQL gate, static policy, and receipts to
  schema v10 without reusing schema-v9 attestations.
- [x] 4.2 Add the exact-SHA real-file Run-0 receipt verifier, bind its digest into the fixed release
  manifest, and cover malformed, mismatched, and sensitive receipts.
- [ ] 4.3 Integrate the E-owned packaged two-account preflight without duplicating provider APIs.
- [x] 4.4 Run contracts/server/domain typecheck and tests, artifact/static/bundle gates, capability
  governance, root typecheck/lint, and the packaged production build.
- [ ] 4.5 Run the real PostgreSQL integration gate and authorized packaged Cloud/OpenContent E2E, then
  generate the exact receipt before marking READY.
