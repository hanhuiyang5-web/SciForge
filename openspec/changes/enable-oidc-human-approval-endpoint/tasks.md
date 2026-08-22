## 1. Contract and actor boundary

- [x] 1.1 Add the OIDC HumanEndpoint resolution method with identity locking, active-state revalidation, stable endpoint reuse, verified-only assurance, audit, and concurrency tests.
- [x] 1.2 Allow canonical `human.answer` to use either an injected verified Provider actor or the authenticated OIDC User's persisted HumanEndpoint; reject Agent, anonymous, legacy, and cross-User attempts.

## 2. Console and documentation

- [x] 2.1 Add a memory-only HumanNeeded approve/reject form to the loopback A Console with canonical idempotency and no automatic Inbox ACK.
- [x] 2.2 Document that OIDC Owner approval is available while external `providerMode` and Zulip binding confirm remain independently disabled.

## 3. Verification

- [x] 3.1 Add API tests for successful Owner approval and confirmation consumption, stable endpoint reuse, cross-User rejection, assurance rejection, and no Provider-mode dependency.
- [x] 3.2 Run focused identity/API/Console tests, A typecheck/test, secret audit, bundle/static policy, and diff hygiene.

## 4. Fixed release and live closure

- [ ] 4.1 Create and publish a clean fixed commit/release, then run the existing PostgreSQL, backup/restart/recovery, app, local edge, and independent external gates.
- [ ] 4.2 Run a fresh formal HumanNeeded approval with the A test Owner and B Coordinator, verify one-time confirmation consumption and downstream Task/Result, and report the boundary separately from external Provider/Zulip E2E.
