# Project Coordinator and Worker Runner

Backend-only B package. The production phase-one path owns exactly one Worker
execution route: an A `task.offered` Inbox message is durably queued, then the
Desktop Host `AgentRuntime` executes it and B returns progress plus a structured
terminal result to A. Desktop lifecycle composition reaches A and the current C
principal only through C's public `collaboration.bc-node` service.

Phase one is intentionally metadata-only. A Task must have no `resourceRefIds`,
no required ResourceRefs, and no external authorization requirements. The Agent
must return no files, output names, or ResourceRef evidence. The production
Content Space port is therefore an unavailable guard, not a mock provider. File
and portable-resource transport remains a later E integration milestone. B
durably transitions an unsupported resource-bearing offer to `rejected` before
calling E or `AgentRuntime`, so it cannot remain in a restart retry loop.

Project and Task creation are owner-direct in phase one. The collaboration domain
UI/capabilities create them explicitly; B does not infer Tasks from Project Inbox
events and does not create automatic `HumanNeeded` requests. Autonomous
Coordinator planning remains available only behind the explicit
`enableAutonomousCoordinator: true` runtime option and is disabled by production
composition.

The Worker journal and lock identity is `(taskId, executionId)`. Agent start is
persisted before the side effect, so recovery cannot run an Agent twice when its
outcome is unknown. Every A progress and terminal write checks the current Task
execution and assignee fence before send.

When autonomous planning is explicitly enabled, Task proposal confirmation calls
`human.needed.create` with the digest produced by
`@sciforge/collaboration-contracts`. This package does not copy A Server hashing
logic. See `A_CONTRACT.md` for the frozen contract commit and archive hash.
