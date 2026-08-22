# SciForge BC 最终设计、实现基线与交付状态

> **历史基线提示（2026-08-22）**：本文冻结 BC 原始设计与交付状态，不再代表当前集成分支的运行真值。官方 GUI、A、AC、R0.1 与 BC 的统一实现、live 边界、双机闭环步骤和后续计划，以 [SciForge Desktop—Cloud 多 Worker 端到端集成总账与验收计划](integration/desktop-cloud-multi-worker-e2e-plan.zh-CN.md) 为准。
>
> 文档状态：历史设计基线
>
> 更新日期：2026-08-21
>
> BC 分支：`codex/bc-adapted-current-fork`
>
> BC 实现提交：`eabb746c704cf32edd7547f2b36394cf01725d2a`
>
> 共同源码基线：`AGI4Sci/SciForge:gui@c1c77123ece9b2e9fc061ce877945b411445d7ed`

## 1. 文档用途

本文将 WIP 分支中 B、C 各三份需求、系统设计和接口联调文档，合并为一份可用于后续开发、评审和验收的当前基线。

需求来源位于 `codex/local-work-before-update`：

- `B-项目协调工作流文档/01-project-coordinator-mvp-requirements.zh-CN.md`
- `B-项目协调工作流文档/02-project-coordinator-system-design.zh-CN.md`
- `B-项目协调工作流文档/03-project-coordinator-interface-integration.zh-CN.md`
- `C-桌面与机构服务器节点接入文档/01-collaboration-node-mvp-requirements.zh-CN.md`
- `C-桌面与机构服务器节点接入文档/02-collaboration-node-system-design.zh-CN.md`
- `C-桌面与机构服务器节点接入文档/03-collaboration-node-interface-integration.zh-CN.md`

总分工依据为 `SciForge 多客户端协作 MVP 五人分工报告.md`，但其中与团队后来明确角色边界冲突的旧 Worker 归属，以本文为准。

原六份文档继续作为需求来源和历史设计依据，但出现冲突时按以下优先级解释：

1. 当前明确的 A/B/C/E 角色边界。
2. AGI4Sci 最新共同源码及团队已发布的公共合同。
3. 本文定义的 BC 最终结构和数据边界。
4. 原六份 WIP 文档中的功能目标。
5. 原六份文档中的旧接口名称、旧包名和旧实现状态。

本文不修改 A、D、E 的业务归属，也不把候选合同或 Mock 测试描述成已完成的真实云验收。

## 2. 最终角色边界

| 模块 | 最终职责 | 不负责 |
| --- | --- | --- |
| A Cloud | Project、Task、execution、ResourceRef、confirmation、receipt 的唯一权威；认证并校验所有云写入 | Coordinator 规划、Worker 执行、内容正文存储 |
| B Coordinator | 读取项目目标和协调视图，形成 Project Plan，拆分 Task，筛选 Worker，申请确认，创建或重试 Task | 用户、Device、Agent 身份注册；云端权威状态 |
| B Worker Runner | 接收 Task offer，执行 AgentRuntime，管理 journal/outbox、恢复、execution fence，提交结构化结果 | 自行创建 ProjectRecord；直接持有云凭据；持有内容正文 |
| C Identity and Transport | OIDC 后的 Principal、Device enrollment、Agent credential、HTTPS/WSS、inbox/outbox、heartbeat、capability report，以及 B 的受限云端口 | Coordinator 规划和 Worker Runner；第二套 Task 状态机 |
| E Content Space | portable reference 的 materialize、Agent 下载、新文件上传和内容授权 | Project/Task 权威；B 的执行状态机 |

原 C 文档中将 Worker 节点执行归入 C 的描述已经失效。Worker Runner、Worker journal、执行锁和执行恢复全部属于 B。C 只为 B 提供身份和通信能力。

## 3. 最终框架

```text
                        A Cloud
      Project / Task / execution / confirmation / ResourceRef
                           ^  |
             HTTPS/WSS     |  | inbox / command response
                           |  v
                C Identity and Transport
        OIDC Principal / Device / Agent credential / inbox
                           ^  |
          current Principal|  | collaboration.bc-node
          restricted Cloud |  | durable delivery
                           |  v
                 B Coordinator + Worker Runner
          plan / confirm / create / execute / recover / fence
                    |                     |
       AgentRuntime |                     | EContentSpacePort
                    v                     v
             Codex or Claude       E Content Space
                                  materialize/download/uploadNew
```

唯一生产路径为：

```text
A inbox -> C durable inbox -> collaboration.bc-node -> B runtime
B cloud command -> C restricted adapter -> A HTTPS
B content operation -> E public port -> E provider
B task execution -> runtime-neutral AgentRuntime
```

不得再增加旧 `collaboration-contracts/server`、兼容 wire、第二套 Task adapter、Renderer 直连云端或 B 直接持有 token 的旁路。

## 4. B Coordinator 设计

### 4.1 输入

B 只根据 A 的权威视图和 C 交付的 inbox 事件工作。主要触发包括：

- `project.started`
- `project.input.received`
- `coordinator.transferred`
- `project_record.submitted`
- `task.updated`
- `human.answer.received`

规划前必须从 A 获取：

- `project.coordination_view.get`
- `project.capability_directory.get`

### 4.2 规划与确认

Coordinator 的职责是：

1. 校验当前 C Principal 的 `agentId` 是 A 指定的 Project Coordinator。
2. 读取 Project 目标、预算、成员、已有 Task、ResourceRef 和当前 revision。
3. 生成结构化 Project Plan 和 Task proposal。
4. 校验依赖、成员 active 状态、Agent online 状态、能力 profile 有效期、能力证据、操作系统、GPU、VPN、Slurm、资源约束和结果返回策略。
5. 使用 A 公共 `computeTaskCreateProposalDigest` 生成 proposal digest。
6. 调用 `human.needed.create`，把 digest 与 `confirmationId` 绑定。
7. 收到同一 `humanRequestId` 的批准后，调用 `task.create`。
8. 拒绝过期、跨 Project、错误 Principal、旧 revision 或不匹配的确认。

每个 inbox message 的 plan 和每个 proposal 的确认状态均需持久化，崩溃恢复后不得重复生成不同 proposal，也不得重复创建 Task。

### 4.3 Task 后续操作

B 可通过 A 公共命令读取、重试和迁移 Task：

- `task.get`
- `task.retry`
- `task.transition`
- `task.progress.report`

重试必须同时校验旧 `executionId` 和当前 `revision`。新 execution 不能复用旧 execution 的 journal、锁或结果。

### 4.4 结果规则

Worker 成功时只向 `task.transition(succeeded)` 提交 `StructuredTaskResult`：

```ts
{
  summary,
  criterionEvidence,
  resourceRefIds,
  logSummary
}
```

B 不调用 `project_record.submit(task_result)`，不发送旧 `resultSummary`。ProjectRecord 是否由 terminal transition 派生属于 A 的合同和服务实现，不由 B 另建写入路径。

## 5. B Worker Runner 设计

### 5.1 执行主键

Worker journal、执行锁、恢复状态和幂等 key 的业务主键统一为：

```text
(taskId, executionId)
```

`taskId` 相同但 `executionId` 不同表示不同执行尝试，必须完全隔离。

### 5.2 执行链

```text
task.offered
-> durable queue before C ACK
-> task.get and execution fence
-> A input ResourceRef
-> E materialize
-> E agentDownload
-> AgentRuntime
-> execution fence
-> E agentUploadNew
-> execution fence
-> A resource.create
-> execution fence
-> task.transition(succeeded, StructuredTaskResult)
```

AgentRuntime 返回 `failed` 或 `cancelled` 时，B 必须在重新读取 fence 后向 A 提交对应 terminal transition，并把本地 journal 写为 terminal 状态。

### 5.3 Execution fence

以下操作发送或执行前必须重新读取 A Task 并校验 `taskId`、`executionId`、assignee 和 revision：

- progress 写入
- E 输出上传
- A `resource.create`
- succeeded、failed、cancelled 等 terminal write
- retry 或 reassign

仅检查进程内 `AbortSignal` 不足以代替 A execution fence。

### 5.4 Crash recovery

- Agent 启动标记必须先于 AgentRuntime 副作用持久化。
- 上传开始标记必须先于 E 上传副作用持久化。
- 崩溃发生在已启动 Agent、但结果未知时，进入 `manual_recovery`，不得自动重跑 Agent。
- 崩溃发生在上传结果未知时，不得自动重复上传。
- A 请求超时只允许以相同 idempotency key、相同 requestId 和相同 payload 重放。
- outbox receipt 落盘前不得把写入视为完成。

## 6. C Identity and Transport 设计

### 6.1 身份链

C 负责以下顺序：

```text
OIDC Access Token
-> GET /v1/me
-> GET /v1/me/devices
-> POST /v1/device-enrollments
-> Ed25519 canonical enrollment signature
-> POST /v1/devices
-> agent.register
-> Agent credential
-> HTTPS/WSS connect
-> heartbeat and capability profile report
```

Access Token、Device 私钥、Agent credential 和临时轮询 secret 只进入 main-only secret store，不得进入 Renderer、日志、状态快照或 B。

切换 Cloud `baseUrl` 时必须清除旧 authority 的 token、Device/Agent credential、绑定 ID 和缓存投影，防止跨 authority 复用身份。

### 6.2 B/C 公共端口

C 通过 Host 内部服务 `collaboration.bc-node` 只向 B 提供：

- `current()`：当前 `userId`、`agentId` 和连接状态。
- `execute()`：受运行时白名单限制的 A 命令。
- `register()`：注册唯一 B inbox handler。
- `wake()`：唤醒 C 的 durable delivery。

C 对 B 开放的 A 命令白名单为：

```text
project.coordination_view.get
project.capability_directory.get
task.create
task.get
task.retry
task.transition
task.progress.report
resource.create
resource.get
human.needed.create
```

白名单必须在运行时校验，不能只依赖 TypeScript 类型。

### 6.3 传输与投递

C 负责 HTTPS 命令、WSS wake、durable inbox/outbox、receipt ledger 和顺序投递。C 必须先把 `task.offered` 交给 B 持久化成功，再向 A 完成 inbox ACK。B 返回 retry 时，C 不得吞掉消息。

C 不解释 Project 目标，不选择 Worker，不执行 Task，也不维护第二套云端 Task 真值。

## 7. B 与 E 的公共边界

当前 B 使用的最小 E port 为：

```ts
interface EContentSpacePort {
  materialize(reference): Promise<MaterializedInput>
  agentDownload(input, destinationName): Promise<DownloadedInput>
  agentUploadNew(input): Promise<UploadedOutput>
}
```

数据流为：

```text
A portableReference
-> E materialize
-> E agentDownload
-> AgentRuntime workspace
-> E agentUploadNew
-> A resource.create(output ResourceRef)
-> B succeeded
```

`authorizeTaskRoot`、真实 OpenContent grant、`updateFile` 和 provider 实现属于 E。B 只依赖公共 port，不复制 E 的 codec、授权或 provider 逻辑。

## 8. 数据安全边界

A 可以接收：

- Project、Task、execution、confirmation 和 receipt ID
- portable ResourceRef 的元数据
- `StructuredTaskResult`
- 可审计的短摘要和状态

A 不得接收：

- 文件正文
- Access Token 或 Agent credential
- 本地绝对路径或 workspace 路径
- E 的本地 `resourceHandle`
- provider 私有 token
- `rrf_*`、portable envelope、`res_*` 的混合表示

B 的云安全校验必须在每次对 A 写入前执行，而不是只依赖 Agent 提示词。

## 9. 当前代码映射

| 能力 | 当前代码位置 |
| --- | --- |
| B Coordinator、规划、资格校验、确认与 Task 创建 | `packages/domains/project-coordinator/src/coordinator.ts` |
| B Coordinator inbox 状态机 | `packages/domains/project-coordinator/src/runtime.ts` |
| B plan/confirmation 持久化 | `packages/domains/project-coordinator/src/coordinator-plan-store.ts` |
| B Worker 执行、fence、terminal | `packages/domains/project-coordinator/src/worker-runner.ts` |
| B journal、锁、outbox | `packages/domains/project-coordinator/src/journal.ts`、`locks.ts`、`outbox.ts` |
| B 对 A/C/E/AgentRuntime 的 ports | `packages/domains/project-coordinator/src/ports.ts` |
| C 身份、注册、连接、heartbeat/profile | `packages/domains/collaboration/src/main/connection.ts` |
| C HTTPS client | `packages/domains/collaboration/src/main/cloud-client.ts` |
| C 对 B 的受限内部服务 | `packages/domains/collaboration/src/main/bc-node-port.ts` |
| BC 组合路径测试 | `packages/domains/project-coordinator/src/bc-integration.test.ts` |

BC 作为独立 domain packages 由标准 manifest 和生成 composition 装配。当前没有新增 Project 管理 UI，BC 不依赖专用 Renderer 入口才能运行。

## 10. 当前验证结果

以下结果对应 `eabb746c` 的本地验证：

| 验证项 | 结果 |
| --- | --- |
| `@sciforge/collaboration-contracts` 测试 | 100/100 通过 |
| B `@sciforge/domain-project-coordinator` 测试 | 25/25 通过 |
| C `@sciforge/domain-collaboration` 测试 | 41/41 通过 |
| B TypeScript typecheck | 通过 |
| C TypeScript typecheck | 通过 |
| domain package composition 检查 | 通过 |
| B/C/A/E Mock 组合链 | 通过 |
| 真实 A Cloud + 真实 OIDC + 真实 E 联测 | 未执行 |

组合测试覆盖：

- C 收到 offer 后，B journal 已按 `(taskId, executionId)` 落盘再返回完成。
- A ResourceRef 经 E Mock materialize/download 进入 AgentRuntime。
- Agent 输出经 E Mock upload-new，再由 B 调 A `resource.create`。
- progress、ResourceRef 和 terminal write 使用 execution fence。
- succeeded 只包含 `summary`、`criterionEvidence`、`resourceRefIds`、`logSummary`。
- 发往 A 的 JSON 不包含 token、Bearer、正文、本地 handle 或 workspace path。
- AgentRuntime failed/cancelled 能写入 fenced terminal 状态。
- C 运行时拒绝不在 BC 白名单中的 A 命令。
- OIDC identity、Device enrollment 签名、Agent 注册、credential 恢复、heartbeat 和 capability profile 使用合同级 fake A 验证。

## 11. 完成度

### 已完成

- B Coordinator 的 plan、eligibility、proposal digest、human confirmation 和 task.create 状态机。
- B Worker Runner 的执行、journal、锁、outbox、fence、terminal 和 crash recovery 规则。
- C 的 Principal、Device enrollment、Agent credential、HTTP/WSS transport、heartbeat/profile 和 BC 内部端口。
- B 到 E 的公共 port 及 Mock 组合链。
- BC package 独立化、标准 composition、无新增 BC UI。
- B 不再使用旧 `project_record.submit(task_result)` 或旧 `resultSummary`。

### 条件完成

- C 已实现接收 Access Token 后的 `/v1/me`、Device enrollment 和 Agent 注册逻辑，但 Desktop 的系统浏览器 Keycloak/OIDC 登录入口及其对 `onboardCloudIdentity` 的正式调用仍需与共享身份入口合并。
- B 已按候选 A R0.1 合同实现并通过本地合同测试，但仍需以团队最终合入 AGI4Sci 的 A 合同和部署为验收真值。
- E port 已完成，当前只接 Mock；真实 OpenContent grant、download/upload 和 updateFile 由 E 接入。

### 未完成

- 两个真实账号、真实 Device、真实 Agent、真实 HTTPS/WSS、真实 A 数据库和真实 E provider 的端到端验收。
- macOS 与机构 Linux Worker 的真实断网、重启、超时、取消和恢复验收。
- AGI4Sci 公共分支中 A 身份链、A 业务合同和 E adapter 的单一可部署组合。

## 12. 为什么尚未完成真机云测试

SSH 隧道和云服务器账号只证明可以访问部署端口，不等于 Desktop 已获得 A 认可的应用身份。完整 BC 真机测试还要求同一个部署同时具备：

1. 可用的 Keycloak/OIDC issuer、client 和测试用户。
2. `/v1/me`、Device enrollment、Agent registration 和 credential 校验。
3. 与 B 当前请求字段一致的 Project/Task/confirmation/ResourceRef 合同。
4. WSS inbox、heartbeat 和 capability directory。
5. 可供 B 调用的真实 E Content Space adapter。

当前团队材料中，A 的身份 E2E 和 A 的候选业务合同来自不同交付快照；AGI4Sci `gui@c1c77123` 仍是合同包 `0.1.0`，BC 分支为验证 digest、portable resource 和身份签名引入的是候选 `0.2.0` 快照。尚无一个已合入并部署的统一 A commit 同时满足以上条件。因此本地能完成合同和 Mock 组合验证，但不能诚实宣称真实云端业务 E2E 已通过。

## 13. A 合同快照说明

当前 BC 分支使用的候选 A 合同来源为 A 同学交付的 `feat/a-r0-1-cloud-contracts@8c88e811b9ab0757c75e2c0a52c7e93c065ce496`，其报告中的 `@sciforge/collaboration-contracts@0.2.0` tgz SHA-256 为：

```text
411ceb837d6c8b35021a61cfda462d5c5399b32a5b775e81bc92572dfd6f6a5d
```

这只是 BC 当前适配和验证使用的候选快照，不代表该版本已经成为 AGI4Sci 主仓库的最终合同。协议字段中的 `protocolVersion: "1.0"` 与 npm package 的 `0.1.0/0.2.0` 版本号是两个不同概念，不得混淆。

当前 AGI4Sci 基线的 A Server/Provider 仍使用 `0.1.0` 接口，直接与候选 `0.2.0` 合同一起做全仓 typecheck 会出现 A 侧接口不匹配。这不是通过在 B/C 中恢复旧 wire 解决的问题，必须由 A 负责人将唯一最终合同和 Server 一起合入共同基线。

## 14. 真机验收清单

在宣称 BC 完成交付前，应在同一 A 部署上完成：

1. 两个 OIDC 用户分别完成 `/v1/me`。
2. 两台真实 Device 完成 Ed25519 enrollment。
3. 注册 Coordinator Agent 和 Worker Agent，确认 credential 不进入 Renderer。
4. 两个 Agent 上报 heartbeat 和 capability profile，并进入 capability directory。
5. A 创建 Project 并指定 Coordinator。
6. B 读取目标、拆分 Task、发起确认，用户批准后 A 创建 Task。
7. Worker 收到 offer，C 在 B journal 落盘后 ACK。
8. 输入 ResourceRef 经真实 E 下载，AgentRuntime 执行，输出经真实 E 上传。
9. B 创建 A output ResourceRef，并提交严格 StructuredTaskResult。
10. 验证取消、旧 execution、revision 冲突、超时重放、Desktop 重启和 Worker 重启。
11. 验证 A 中无正文、token、本地路径和 local handle。
12. 保存 Cloud 日志、A 数据库记录、Desktop journal 和 E 资源作为交付证据。

## 15. 对原六份 WIP 文档的处理

原六份文档继续用于追溯需求，但后续 BC 开发、评审和进度汇报以本文为入口：

- 保留：B 的规划、拆解、确认、执行恢复和结果验证目标。
- 保留：C 的身份、设备、Agent、通信、durable delivery 和 Principal 目标。
- 修正：Worker Runner 从 C 移至 B。
- 修正：旧命令、旧同名 Server、兼容 wire 和重复 Task adapter 不再使用。
- 修正：Worker 不手工提交 `project_record.submit(task_result)`。
- 新增：B 到 E 的 portable resource 公共 port 和内容安全边界。
- 新增：所有关键副作用前的 execution fence。
- 新增：候选合同、本地 Mock 验证和真实云验收三种状态必须分别报告。

本文描述的是 BC 的最终目标和当前事实，不以尚未完成的外部 A/E 合入为由降低 BC 的设计要求，也不把外部阻塞伪装成 BC 已完成的真机结果。
