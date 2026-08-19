# SciForge Collaboration Contracts

`@sciforge/collaboration-contracts@0.2.0` 是 SciForge Cloud 与 B/C 客户端共享的严格公共合同。
包版本 `0.2.0` 与 wire protocol `1.0` 是两个独立版本：本次不改变协议主版本，只增加唯一、可复用的公共算法实现与固定向量。

## C：Device enrollment 签名

Desktop 直接从合同包导入签名 facts 与 canonical bytes helper；不得导入
`@sciforge/collaboration-server`，也不得复制字段顺序或分隔算法。

```ts
import {
  canonicalEnrollmentBytes,
  type EnrollmentSigningFacts
} from '@sciforge/collaboration-contracts'
// 也可从 @sciforge/collaboration-contracts/enrollment-signing 精确导入。

const facts: EnrollmentSigningFacts = {
  enrollmentId,
  nonce,
  userId,
  installationId,
  expiresAt
}
const payload = canonicalEnrollmentBytes(facts)
// 使用 Device Ed25519 私钥直接签名 payload。
```

固定公钥、canonical payload 与 Ed25519 signature 位于
`artifacts/protocol-1.0/fixtures/device-enrollment-signing-vector.json`。

## B：Task proposal digest

Coordinator 与 Cloud Server 必须调用同一个 helper；不得各自实现 JSON 排序或 SHA-256。

```ts
import {
  computeTaskCreateProposalDigest,
  normalizeTaskCreateProposal
} from '@sciforge/collaboration-contracts'
// 也可从 @sciforge/collaboration-contracts/task-proposal 精确导入。

const normalized = normalizeTaskCreateProposal(taskCreateProposal)
const proposalDigest = computeTaskCreateProposalDigest(taskCreateProposal)
```

完整 proposal、规范化结果、canonical JSON 与 digest 位于
`artifacts/protocol-1.0/fixtures/task-create-proposal-digest-vector.json`。机器可读算法元数据位于
`artifacts/protocol-1.0/algorithms.json`。

测试代码如需直接读取 TypeScript 向量，可从
`@sciforge/collaboration-contracts/testing` 导入；生产代码只应使用根导出的 helper 和类型。
