# `@sciforge/domain-collaboration`

SciForge 的统一用户—手机—Agent 协作领域包。

包通过标准 domain manifest 提供独立 main 与 renderer 入口。main 入口拥有 Agent
设备身份、A 认证传输、本地 Session 投影、durable inbox/outbox、每 projection 顺序队列
和 receipt ledger，并通过 Host 限定的 `collaboration.bc-node` 内部服务向 B 提供 Principal、
Cloud adapter 与 inbox 转交。Coordinator 和 Worker Runner 均由 B 的
`@sciforge/domain-project-coordinator` 负责；C 不保留第二套 Task adapter。renderer 只通过
Capability Broker 调用公开 capability，不使用领域专用 IPC、MCP 或 Host 私有路径。

本地高频状态写入 `<userData>/domains/collaboration/state.json`，使用 0600 原子替换。
Cloud 权威地址、Principal 与 ACTIVE Device 只来自 identity-access 的 main-only
`identity.cloud-session` 服务。OIDC access token 仅在 fresh-token 回调期间存在于内存，
不会写入 collaboration settings、secret store、状态或 renderer。Agent 注册后由 Cloud
返回的 Agent credential 与短期 pairing poll secret 只保存到 main-only package secret
store；logout、Device revoke/missing 或 Principal 变化会断开连接并清除绑定状态。

Owner 可从 Desktop 直接创建 Project、显式填写多个成员 userId，并把 Task 派给复制来的
Worker agentId。阶段 1 的 Task 固定 `resourceRefIds=[]` 和
`authorizationRequirements=[]`；Worker 进度与结果经 Cloud inbox 回拉并显示在同一面板。

远端个人消息始终通过 Host 提供的 thread-targeted `agentExecution` 进入明确 thread，并
携带 durable `clientDirectiveId`。模型、workspace policy、工具、审批和审计仍由唯一的
AgentRuntime/Capability Broker 路径负责。普通手机身份不会生成桌面批准。
