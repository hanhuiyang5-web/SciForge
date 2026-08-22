## Why

The A OIDC test deployment can create governed `HumanNeeded` requests, but `human.answer` is accepted only through an external Provider gateway. Because the deployment deliberately keeps `providerMode=disabled`, a Project Owner cannot approve the request with the same strictly verified OIDC identity already used for Project administration. The temporary Owner-direct `task.create` path proves Worker execution but bypasses the one-time confirmation contract.

## What Changes

- Treat the authenticated OIDC identity as a first-party verified HumanEndpoint for `human.answer` only.
- Persist one stable `provider=oidc` HumanEndpoint per active `(issuer, subject)` under the existing endpoint table and audit boundary.
- Preserve the existing target-User, assurance, request revision, Project Owner, Coordinator, action digest, expiry, one-time confirmation, and idempotency checks.
- Add the approval operation to the loopback-only A Console so an Owner can pull `human.needed`, approve or reject it, and keep the bearer only in page memory.
- Keep external Provider delivery and Zulip binding confirmation disabled unless their independent trusted adapters are configured.

## Capabilities

### New Capabilities

- `oidc-human-approval`: A verified OIDC User can answer a HumanNeeded request addressed to that same User through a persisted first-party HumanEndpoint and receive the canonical one-time confirmation result.

### Modified Capabilities

None.

## Impact

- A server identity service and HTTP actor resolution.
- Existing `human.answer` command behavior; no request or response schema change.
- Loopback/SSH-tunnel A Console.
- No database migration: the existing `human_endpoint_bindings` table and constraints are reused.
- No B/C/D/E private implementation and no external Provider, Bot, client secret, global admin, or anonymous approval path.
