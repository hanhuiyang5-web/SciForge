## Context

`CollaborationService.answerHumanNeeded` already enforces the authoritative HumanNeeded and confirmation state machine, but the HTTP boundary routes `human.answer` exclusively to a Provider-resolved `HumanEndpointActor`. The OIDC test release intentionally runs with external providers disabled. The OIDC User resolver nevertheless provides a verified, stable `(identityId, issuer, subject, userId)` actor and is the authority for Project Owner commands.

## Goals / Non-Goals

**Goals:**

- Reuse the canonical `human.answer` service path rather than create an approval shortcut.
- Materialize a stable, auditable HumanEndpoint from the current active OIDC identity.
- Permit only the request target User; governed actions remain Owner-only because HumanNeeded creation already freezes the Owner target and action digest.
- Keep the endpoint assurance at `verified`, even if a future login carries stronger context, so a later ordinary token cannot inherit stronger assurance.
- Make the operation usable from the existing loopback-only A Console.

**Non-Goals:**

- Enabling Zulip Provider mode, D Bot parsing, binding confirm, public Console exposure, global admin, or cross-User approval.
- Changing HumanNeeded, HumanAnswer, or ActionConfirmation wire schemas.
- Automatically ACKing User or Coordinator Inbox messages.
- Claiming Desktop UI or external Provider E2E.

## Decisions

### 1. Reuse the endpoint table and canonical answer service

On the first OIDC approval attempt, `IdentityService` locks the OIDC identity, revalidates the User and identity, and creates one active endpoint with `provider=oidc`, `realmId=<exact issuer>`, `providerUserId=<exact subject>`, and assurance `verified`. Later attempts resolve the same row. Revoked or structurally inconsistent rows fail closed.

The API converts only a verified OIDC `UserActor` into that stored `HumanEndpointActor`, then calls the existing `answerHumanNeeded`. The answer row therefore retains a real foreign-key-backed `answeredFromHumanEndpointId`; confirmation generation and consumption are unchanged.

### 2. Provider answers and OIDC answers remain separate authentication paths

An injected Provider actor remains accepted where configured. Without one, `human.answer` requires a valid OIDC bearer and the identity service. Agent credentials, service credentials, anonymous requests, request-body identity, and legacy opaque User credentials cannot create the endpoint.

External Provider delivery remains controlled by `providerMode`; OIDC approval does not start a Provider runtime or enable Zulip binding confirmation.

### 3. Keep the Console loopback-only and memory-only

The existing Console gains a HumanNeeded approval form that submits the canonical command with matching idempotency header/body. It never stores the bearer, never auto-ACKs Inbox messages, and remains blocked by the public HTTPS edge. Operators use it only through the existing SSH tunnel or call the same command from a local Owner client.

## Risks / Trade-offs

- **[OIDC endpoint accidentally grants strong assurance]** -> Always persist and return `verified`; `strong` requests still require a separately frozen stronger endpoint.
- **[Duplicate endpoints under concurrency]** -> Serialize on the existing OIDC identity lock and enforce the existing active provider identity uniqueness constraint.
- **[Cross-User approval]** -> Revalidate identity/User ownership before endpoint resolution and retain the service target-User authorization.
- **[Provider boundary ambiguity]** -> Use `provider=oidc`; do not register it as an external HumanEndpoint Provider or set it as the participant primary endpoint.
- **[Token leakage in Console]** -> Preserve password input, memory-only state, text-only rendering, same-origin command endpoint, CSP, and public edge `/console` denial.

## Migration Plan

1. Add focused identity/API/Console tests and full A regression evidence.
2. Build a clean fixed OIDC release and run the existing PostgreSQL, backup, restart, local-edge, and external-edge gates.
3. Use a fresh Owner OIDC token to approve a newly created governed HumanNeeded request.
4. Verify `human.answer.received`, one-time confirmation consumption, Task creation/execution/result, and that A did not ACK B Inbox messages.
5. Roll back with the previous fixed release if readiness or the approval path fails; no schema rollback is required.
