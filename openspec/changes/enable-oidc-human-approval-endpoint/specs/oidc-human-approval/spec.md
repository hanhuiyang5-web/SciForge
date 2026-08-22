# OIDC HumanEndpoint 审批需求

## ADDED Requirements

### Requirement: OIDC User 必须解析为持久化的 verified HumanEndpoint

A SHALL 在 OIDC User 首次提交 `human.answer` 时，以经过验证的 `identityId`、精确 issuer、subject 和 User ownership 解析或创建一个 `provider=oidc` 的 ACTIVE HumanEndpoint。该 Endpoint MUST 使用 assurance `verified`，MUST 由现有 OIDC identity lock 和 endpoint uniqueness 约束并发串行化，并 MUST NOT 成为外部 Provider runtime、Zulip binding 或 Participant primary endpoint。

#### Scenario: 首次 OIDC Owner 审批

- **WHEN** ACTIVE OIDC User 使用有效 Access Token 回答发给自己的 HumanNeeded
- **THEN** A SHALL 创建一个外键有效、可审计的 OIDC HumanEndpoint
- **AND** SHALL 通过现有 `answerHumanNeeded` 状态机保存 HumanAnswer。

#### Scenario: 并发首次审批

- **WHEN** 同一 OIDC identity 并发解析审批 Endpoint
- **THEN** 两个请求 SHALL 收敛到同一个 `humanEndpointId`
- **AND** MUST NOT 创建重复 ACTIVE endpoint。

#### Scenario: OIDC identity 或 Endpoint 已撤销

- **WHEN** 本地 User、OIDC identity 或既有 OIDC Endpoint 不再 ACTIVE
- **THEN** A MUST 失败关闭
- **AND** MUST NOT 创建替代 Endpoint或生成 confirmation。

### Requirement: OIDC 审批必须复用正式 HumanNeeded 与 confirmation 约束

OIDC HumanEndpoint SHALL 仅回答 `targetUserId` 等于当前 OIDC User 的请求，并 SHALL 保留 request revision、expiry、required assurance、Project Owner target、current Coordinator、immutable action digest、idempotency and one-time confirmation checks. A MUST NOT add an Owner-direct confirmation row, global admin, or request-body identity bypass.

#### Scenario: Owner 批准 governed action

- **WHEN** 当前 Project Owner 通过其 OIDC Endpoint 对 pending governed HumanNeeded 提交 `decision=approve`
- **THEN** A SHALL 生成 canonical `human.answer.received` 与一次性 ActionConfirmation
- **AND** Coordinator MAY consume that confirmation only for the exact frozen action.

#### Scenario: 另一个 OIDC User 尝试回答

- **WHEN** 有效但非目标 User 的 OIDC Token 回答该请求
- **THEN** A MUST 返回 permission denied
- **AND** request、answer、confirmation 和 Inbox MUST 保持不变。

#### Scenario: strong assurance 请求

- **WHEN** HumanNeeded requires `strong` assurance but the OIDC Endpoint is only `verified`
- **THEN** A MUST return assurance insufficient
- **AND** MUST NOT upgrade the persisted Endpoint from ordinary OIDC login history.

### Requirement: Provider disabled 不得阻塞 OIDC Owner 正式审批

OIDC approval SHALL NOT require an installed Provider runtime, Provider locator, Bot secret, binding-confirm authenticator, or `providerMode=enabled`. Conversely, enabling OIDC approval MUST NOT enable external Provider delivery or Zulip confirmation.

#### Scenario: OIDC test release providerMode disabled

- **WHEN** the OIDC test release has `providerMode=disabled` and a valid Owner OIDC Token submits `human.answer`
- **THEN** A SHALL process the answer through the persisted OIDC Endpoint
- **AND** external Provider catalog/delivery and Zulip binding confirm SHALL remain disabled.

### Requirement: A Console 必须提供同一 canonical 审批入口

The loopback-only A Console SHALL let an authenticated User enter HumanNeeded ID, request revision, answer and approve/reject decision, then submit the canonical `human.answer` command with a matching `Idempotency-Key`. The Console MUST keep the bearer in memory only, MUST NOT auto-ACK User or Agent Inbox, and MUST remain unavailable through the public HTTPS edge.

#### Scenario: Owner 从 Console 批准

- **WHEN** Owner loads a valid OIDC bearer in the SSH-tunneled Console and submits the approval form
- **THEN** the Console SHALL call the same `/v1/commands` contract and render the canonical HumanAnswer/confirmation response as text
- **AND** SHALL NOT persist the bearer or ACK the source Inbox message.
