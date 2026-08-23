# Project Content Space Task I/O

## ADDED Requirements

### Requirement: Cloud SHALL own one exclusive versioned Content Space binding per Project

A Project Owner SHALL be able to bind, replace, read, and close one active Content Space container
ResourceRef using Project and binding revision fences. An active root SHALL be available, portable,
belong to the Project, and SHALL NOT be active for another Project. Closing a binding SHALL NOT
delete or mutate provider content.

#### Scenario: Owner binds an authorized Team directory

- **WHEN** the Owner submits an available Project container ResourceRef and the current Project revision
- **THEN** A stores an active binding, increments Project revision, writes audit/receipt evidence, and
  returns the strict binding entity

#### Scenario: Another Project already claims the root

- **WHEN** an Owner attempts to activate a root ResourceRef already active for another Project
- **THEN** A rejects the mutation atomically and changes neither Project nor binding

### Requirement: File-bearing Tasks SHALL carry one strict TaskFileIntent v1

A file-bearing Task SHALL identify the exact binding revision, ordered input ResourceRefs with safe
destination names, and one binding-root output container in `upload-new` mode. A SHALL derive the
Task ResourceRef projection from that intent and reject a divergent or stale request.

#### Scenario: Create a real file Task

- **WHEN** an authorized creator submits a file intent whose binding, input files, output root,
  Project, assignee, and revisions are all current
- **THEN** A creates one offered Task containing the immutable file intent and the exact derived
  ResourceRef list, increments Project revision, and notifies the assignee

#### Scenario: Binding changed before Task creation

- **WHEN** the supplied binding revision is no longer current
- **THEN** A rejects with a revision conflict and creates no Task, receipt, notification, or Project update

### Requirement: Provider scope SHALL be reauthorized by E at materialization time

The Desktop SHALL pass portable root/input references to an E-owned provider-neutral Task file port.
E SHALL resolve them under the current Cloud Principal and provider ACL, prove allowed root/descendant
scope, and return only bounded neutral transfer evidence. A/B/C SHALL NOT inspect credentials or
provider DTOs and SHALL NOT persist local paths.

#### Scenario: Input no longer belongs to the permitted provider scope

- **WHEN** a previously registered input cannot be reauthorized beneath the current binding root
- **THEN** E fails closed before download and the Worker does not run AgentRuntime or upload output

### Requirement: Worker output SHALL reuse canonical ResourceRef and Task-result authority

The Worker SHALL download inputs, run the selected AgentRuntime, upload new output through E,
register each returned portable output through task-scoped `resource.create`, and succeed through the
canonical structured Task transition. A SHALL atomically persist the Task result and candidate
ProjectRecord.

#### Scenario: One output completes the loop

- **WHEN** the Worker downloads the bound input, AgentRuntime returns one declared output, E uploads
  it, and A accepts the task-scoped ResourceRef
- **THEN** the succeeded Task, structured result, output ResourceRef, and candidate ProjectRecord all
  reference the same execution and the Coordinator can re-download the output and verify SHA-256

### Requirement: Run-0 evidence SHALL bind one exact release without secrets

The acceptance receipt SHALL bind the final commit, schema v10 Cloud release, both packaged Desktop
digests, distinct identity/device/agent facts, Project/binding/Task/execution facts, E operation IDs,
byte counts, input/output hashes, output ResourceRef, ProjectRecord, and Coordinator re-download
hash. The fixed release manifest SHALL bind the receipt verifier SHA-256, and the receipt SHALL bind
that verifier plus the exact release-manifest SHA-256. It SHALL exclude tokens, credentials, provider
secrets, emails, raw provider DTOs, and local paths.

#### Scenario: Evidence is incomplete or crosses authority boundaries

- **WHEN** any required digest/fact is missing or the receipt contains a forbidden secret/path field
- **THEN** the verifier rejects the receipt and Run 0 remains NOT READY
