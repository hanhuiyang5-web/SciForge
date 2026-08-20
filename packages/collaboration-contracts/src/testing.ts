import type { z } from 'zod'
import { redactCredentials } from './core.js'
import {
  actionConfirmationSchema,
  agentNodeSchema,
  agentCapabilityProfileSchema,
  endpointChallengeSchema,
  humanAnswerSchema,
  humanEndpointBindingSchema,
  humanNeededSchema,
  participantProfileSchema,
  projectInputSchema,
  projectCapabilityDirectorySchema,
  projectCoordinationViewSchema,
  projectRecordSchema,
  resourceRefSchema,
  projectSchema,
  remoteSessionProjectionSchema,
  taskSchema,
  userPrincipalSchema
} from './entities.js'
import {
  agentInboxMessageSchema,
  agentInboxPayloadSchema,
  operationReceiptSchema,
  restRequestSchema,
  webSocketMessageSchema
} from './protocol.js'
import {
  providerEventSchema,
  providerIdentitySchema,
  providerLocatorSchema
} from './provider.js'

export const TEST_TIMESTAMP = '2026-08-15T08:00:00.000Z'
export const TEST_LATER_TIMESTAMP = '2026-08-15T08:01:00.000Z'
export const TEST_HASH = 'a'.repeat(64)

export const DEVICE_ENROLLMENT_SIGNING_TEST_VECTOR = Object.freeze({
  algorithm: 'Ed25519' as const,
  domain: 'SCIFORGE-DEVICE-ENROLLMENT-V1' as const,
  facts: Object.freeze({
    enrollmentId: 'enr_Vector0000001',
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    userId: 'usr_Vector0000001',
    installationId: 'ins_Vector0000001',
    expiresAt: '2026-08-19T12:05:00.000Z'
  }),
  canonicalUtf8: [
    'SCIFORGE-DEVICE-ENROLLMENT-V1',
    'enr_Vector0000001',
    'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    'usr_Vector0000001',
    'ins_Vector0000001',
    '2026-08-19T12:05:00.000Z'
  ].join('\n'),
  canonicalBase64Url:
    'U0NJRk9SR0UtREVWSUNFLUVOUk9MTE1FTlQtVjEKZW5yX1ZlY3RvcjAwMDAwMDEKQUFFQ0F3UUZCZ2NJQ1FvTERBME9EeEFSRWhNVUZSWVhHQmthR3h3ZEhoOAp1c3JfVmVjdG9yMDAwMDAwMQppbnNfVmVjdG9yMDAwMDAwMQoyMDI2LTA4LTE5VDEyOjA1OjAwLjAwMFo',
  publicKeyJwk: Object.freeze({
    kty: 'OKP' as const,
    crv: 'Ed25519' as const,
    alg: 'EdDSA' as const,
    use: 'sig' as const,
    kid: 'device-enrollment-vector-01',
    x: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg'
  }),
  signature: 'MZGCHrdaZJaArrdyAOmbFIIthXnxXebx-618S4T__NuYbmkDs8GGjyYLEjBr7YKQf5TLwLTNvyZeX8PEkuqHDw'
})

export const TASK_CREATE_PROPOSAL_DIGEST_TEST_VECTOR = Object.freeze({
  algorithm: 'sha256-canonical-json-v1' as const,
  proposal: Object.freeze({
    projectId: 'prj_ProposalVector01',
    assigneeAgentId: 'agt_ProposalWorker01',
    title: '  Produce the R0.1 portable result  ',
    objective: '  Validate the full Task proposal digest across A and B.  ',
    completionCriteria: Object.freeze([
      '  Return a portable artifact reference.  ',
      Object.freeze({
        criterionId: 'cri_ProposalCriterion01',
        text: '  Preserve the artifact SHA-256 digest.  '
      })
    ]),
    dependencyTaskIds: Object.freeze(['tsk_ProposalDependency01']),
    requiredCapabilities: Object.freeze({
      osFamilies: Object.freeze(['linux' as const, 'macos' as const]),
      capabilityIds: Object.freeze(['research.execute', 'content-space.read']),
      minimumEvidenceLevel: 'verified' as const,
      minGpuMemoryGB: 16,
      vpnAccessIds: Object.freeze(['vpn_lab']),
      slurmClusterIds: Object.freeze(['slurm_main']),
      requiredResourceRefIds: Object.freeze(['rrf_ProposalResource01']),
      requireLogSummary: true
    }),
    resourceRefIds: Object.freeze(['rrf_ProposalResource01', 'rrf_ProposalResource02']),
    authorizationRequirements: Object.freeze([
      Object.freeze({
        id: 'auth_ProposalRequirement01',
        kind: 'resource_access' as const,
        targetRefId: 'rrf_ProposalResource01',
        description: '  Confirm access to the portable input.  '
      }),
      Object.freeze({
        id: 'auth_ProposalRequirement02',
        kind: 'data_egress' as const,
        description: '  Confirm the bounded result return.  '
      })
    ])
  }),
  normalizedProposal: Object.freeze({
    projectId: 'prj_ProposalVector01',
    assigneeAgentId: 'agt_ProposalWorker01',
    title: 'Produce the R0.1 portable result',
    objective: 'Validate the full Task proposal digest across A and B.',
    completionCriteria: Object.freeze([
      Object.freeze({ text: 'Return a portable artifact reference.' }),
      Object.freeze({
        criterionId: 'cri_ProposalCriterion01',
        text: 'Preserve the artifact SHA-256 digest.'
      })
    ]),
    dependencyTaskIds: Object.freeze(['tsk_ProposalDependency01']),
    requiredCapabilities: Object.freeze({
      osFamilies: Object.freeze(['linux' as const, 'macos' as const]),
      capabilityIds: Object.freeze(['research.execute', 'content-space.read']),
      minimumEvidenceLevel: 'verified' as const,
      minGpuMemoryGB: 16,
      vpnAccessIds: Object.freeze(['vpn_lab']),
      slurmClusterIds: Object.freeze(['slurm_main']),
      requiredResourceRefIds: Object.freeze(['rrf_ProposalResource01']),
      requireLogSummary: true
    }),
    resourceRefIds: Object.freeze(['rrf_ProposalResource01', 'rrf_ProposalResource02']),
    authorizationRequirements: Object.freeze([
      Object.freeze({
        id: 'auth_ProposalRequirement01',
        kind: 'resource_access' as const,
        targetRefId: 'rrf_ProposalResource01',
        description: 'Confirm access to the portable input.'
      }),
      Object.freeze({
        id: 'auth_ProposalRequirement02',
        kind: 'data_egress' as const,
        description: 'Confirm the bounded result return.'
      })
    ])
  }),
  canonicalJson: [
    '{"assigneeAgentId":"agt_ProposalWorker01","authorizationRequirements":[',
    '{"description":"Confirm access to the portable input.","id":"auth_ProposalRequirement01",',
    '"kind":"resource_access","targetRefId":"rrf_ProposalResource01"},',
    '{"description":"Confirm the bounded result return.","id":"auth_ProposalRequirement02",',
    '"kind":"data_egress"}],"completionCriteria":[',
    '{"text":"Return a portable artifact reference."},',
    '{"criterionId":"cri_ProposalCriterion01","text":"Preserve the artifact SHA-256 digest."}],',
    '"dependencyTaskIds":["tsk_ProposalDependency01"],',
    '"objective":"Validate the full Task proposal digest across A and B.",',
    '"projectId":"prj_ProposalVector01","requiredCapabilities":{',
    '"capabilityIds":["research.execute","content-space.read"],"minGpuMemoryGB":16,',
    '"minimumEvidenceLevel":"verified","osFamilies":["linux","macos"],',
    '"requireLogSummary":true,"requiredResourceRefIds":["rrf_ProposalResource01"],',
    '"slurmClusterIds":["slurm_main"],"vpnAccessIds":["vpn_lab"]},',
    '"resourceRefIds":["rrf_ProposalResource01","rrf_ProposalResource02"],',
    '"title":"Produce the R0.1 portable result"}'
  ].join(''),
  digest: '0f01d88e8befc4f645493c8137275a659ec8952cc82a53d2c7d205edef4adaa8'
})

export const TEST_IDS = Object.freeze({
  userId: 'usr_User00000001',
  secondUserId: 'usr_User00000002',
  humanEndpointId: 'hep_Endp00000001',
  agentId: 'agt_Agent0000001',
  secondAgentId: 'agt_Agent0000002',
  participantId: 'par_Part00000001',
  projectionId: 'rsp_Proj00000001',
  projectInputId: 'pin_Input0000001',
  projectId: 'prj_Proj00000001',
  taskId: 'tsk_Task00000001',
  executionId: 'exe_Exec00000001',
  secondExecutionId: 'exe_Exec00000002',
  firstCriterionId: 'cri_Criterion0001',
  secondCriterionId: 'cri_Criterion0002',
  projectRecordId: 'rec_Rec000000001',
  resourceRefId: 'rrf_ResRef000001',
  inboxMessageId: 'ibx_Inbox0000001',
  receiptId: 'rcp_Receip000001',
  humanRequestId: 'hrq_Human0000001',
  humanAnswerId: 'han_Answer000001',
  confirmationId: 'cnf_Confirm000001',
  challengeId: 'chl_Chall0000001',
  requestId: 'req_Reque0000001',
  traceId: 'trc_Trace0000001',
  localItemId: 'lit_Local0000001',
  turnId: 'trn_Turn00000001',
  installationId: 'ins_Insta0000001',
  deviceId: 'dev_Device0000001'
})

export const providerIdentityFixture = providerIdentitySchema.parse({
  type: 'provider_identity',
  provider: 'example-im',
  realmId: 'realm-hong-kong',
  providerUserId: 'provider-user-42',
  displayName: '测试用户'
})

export const chineseProviderLocatorFixture = providerLocatorSchema.parse({
  type: 'provider_locator',
  provider: 'example-im',
  realmId: 'realm-hong-kong',
  containerId: 'container-100',
  topicId: 'topic-stable-100',
  containerDisplayName: '科研协作',
  topicDisplayName: '蛋白质结构分析（上海样本）'
})

export const userPrincipalFixture = userPrincipalSchema.parse({
  schemaVersion: 1,
  type: 'user_principal',
  userId: TEST_IDS.userId,
  displayName: '测试用户',
  status: 'active',
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const humanEndpointBindingFixture = humanEndpointBindingSchema.parse({
  schemaVersion: 1,
  type: 'human_endpoint_binding',
  humanEndpointId: TEST_IDS.humanEndpointId,
  userId: TEST_IDS.userId,
  identity: providerIdentityFixture,
  displayName: '测试手机',
  assurance: 'verified',
  status: 'active',
  verifiedAt: TEST_TIMESTAMP,
  lastSeenAt: TEST_LATER_TIMESTAMP,
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const endpointChallengeFixture = endpointChallengeSchema.parse({
  schemaVersion: 1,
  type: 'endpoint_challenge',
  challengeId: TEST_IDS.challengeId,
  userId: TEST_IDS.userId,
  expectedIdentity: providerIdentityFixture,
  status: 'pending',
  expiresAt: TEST_LATER_TIMESTAMP,
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const agentNodeFixture = agentNodeSchema.parse({
  schemaVersion: 1,
  type: 'agent_node',
  agentId: TEST_IDS.agentId,
  deviceId: TEST_IDS.deviceId,
  ownerUserId: TEST_IDS.userId,
  displayName: '实验室桌面机',
  nodeType: 'desktop',
  capabilities: ['agent.execute', 'workspace.read'],
  lifecycleStatus: 'active',
  connectionStatus: 'online',
  credentialVersion: 1,
  lastSeenAt: TEST_LATER_TIMESTAMP,
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const participantProfileFixture = participantProfileSchema.parse({
  schemaVersion: 1,
  type: 'participant_profile',
  participantId: TEST_IDS.participantId,
  userId: TEST_IDS.userId,
  primaryHumanEndpointId: TEST_IDS.humanEndpointId,
  primaryAgentId: TEST_IDS.agentId,
  status: 'active',
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const remoteSessionProjectionFixture = remoteSessionProjectionSchema.parse({
  schemaVersion: 1,
  type: 'remote_session_projection',
  projectionId: TEST_IDS.projectionId,
  ownerUserId: TEST_IDS.userId,
  agentId: TEST_IDS.agentId,
  humanEndpointId: TEST_IDS.humanEndpointId,
  locator: chineseProviderLocatorFixture,
  locatorRevision: 1,
  displayName: '蛋白质结构分析',
  status: 'active',
  allowedSenderUserIds: [TEST_IDS.userId],
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const projectInputFixture = projectInputSchema.parse({
  schemaVersion: 1,
  type: 'project_input',
  projectInputId: TEST_IDS.projectInputId,
  projectId: TEST_IDS.projectId,
  senderUserId: TEST_IDS.userId,
  sourceHumanEndpointId: TEST_IDS.humanEndpointId,
  providerMessageId: 'provider-message-1',
  sequence: 1,
  text: '请分析这批样本。',
  status: 'queued',
  occurredAt: TEST_TIMESTAMP,
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const projectFixture = projectSchema.parse({
  schemaVersion: 1,
  type: 'project',
  projectId: TEST_IDS.projectId,
  ownerUserId: TEST_IDS.userId,
  displayName: '联合研究项目',
  goal: '完成样本分析并形成可审查结论。',
  memberUserIds: [TEST_IDS.userId, TEST_IDS.secondUserId],
  coordinatorAgentId: TEST_IDS.agentId,
  status: 'active',
  budget: {
    maxTasks: 20,
    maxTasksPerRound: 4,
    maxCoordinationRounds: 10,
    maxTaskRetries: 2
  },
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const agentCapabilityProfileFixture = agentCapabilityProfileSchema.parse({
  schemaVersion: 1,
  type: 'agent_capability_profile',
  agentId: TEST_IDS.agentId,
  ownerUserId: TEST_IDS.userId,
  nodeType: 'personal_computer',
  os: { family: 'macos', architecture: 'arm64', version: '15.6' },
  runtimeIds: ['runtime.default'],
  capabilities: [{
    capabilityId: 'research.coordinate',
    version: '1',
    evidence: { level: 'verified', checkedAt: TEST_TIMESTAMP, summary: 'Local runtime probe passed.' }
  }],
  gpu: [],
  vpnAccessIds: [],
  slurmClusterIds: [],
  accessibleResourceRefIds: [],
  resultReturnPolicy: {
    summary: true,
    evidenceRefs: true,
    resourceRefs: true,
    logSummary: true,
    fullFileRequiresConfirmation: true,
    fullLogRequiresConfirmation: true
  },
  reportedAt: TEST_TIMESTAMP,
  expiresAt: TEST_LATER_TIMESTAMP,
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const projectCapabilityDirectoryFixture = projectCapabilityDirectorySchema.parse({
  schemaVersion: 1,
  type: 'project_capability_directory',
  projectId: TEST_IDS.projectId,
  projectRevision: 1,
  agents: [{
    agentId: TEST_IDS.agentId,
    ownerUserId: TEST_IDS.userId,
    displayName: '协调节点',
    nodeType: 'desktop',
    capabilities: ['research.coordinate'],
    status: 'online',
    lastSeenAt: TEST_LATER_TIMESTAMP,
    profile: agentCapabilityProfileFixture,
    revision: 1
  }]
})

export const taskFixture = taskSchema.parse({
  schemaVersion: 1,
  type: 'task',
  taskId: TEST_IDS.taskId,
  projectId: TEST_IDS.projectId,
  executionId: TEST_IDS.executionId,
  createdByCoordinatorAgentId: TEST_IDS.agentId,
  assigneeAgentId: TEST_IDS.secondAgentId,
  assigneeUserId: TEST_IDS.secondUserId,
  title: '分析样本',
  objective: '验证样本质量并总结异常。',
  completionCriteria: [
    { criterionId: TEST_IDS.firstCriterionId, text: '提交结果摘要' },
    { criterionId: TEST_IDS.secondCriterionId, text: '标记异常样本' }
  ],
  dependencyTaskIds: [],
  requiredCapabilities: {
    capabilityIds: [], vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: []
  },
  resourceRefIds: [],
  authorizationRequirements: [],
  status: 'offered',
  attempt: 1,
  maxRetries: 2,
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const projectRecordFixture = projectRecordSchema.parse({
  schemaVersion: 1,
  type: 'project_record',
  projectRecordId: TEST_IDS.projectRecordId,
  projectId: TEST_IDS.projectId,
  kind: 'observation',
  status: 'proposed',
  body: '样本质量满足后续分析要求。',
  authorUserId: TEST_IDS.userId,
  authorAgentId: TEST_IDS.agentId,
  sourceTaskId: TEST_IDS.taskId,
  sourceExecutionId: TEST_IDS.executionId,
  sourceRevision: 1,
  criterionEvidence: [],
  resourceRefIds: [],
  logSummary: null,
  acceptedByUserId: null,
  acceptedByAgentId: null,
  acceptedAt: null,
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const resourceRefFixture = resourceRefSchema.parse({
  schemaVersion: 1,
  type: 'resource_ref',
  resourceRefId: TEST_IDS.resourceRefId,
  projectId: TEST_IDS.projectId,
  taskId: TEST_IDS.taskId,
  executionId: TEST_IDS.executionId,
  taskRevision: 1,
  createdByUserId: TEST_IDS.userId,
  createdByAgentId: TEST_IDS.agentId,
  provider: 'example-content',
  externalId: 'document-42',
  kind: 'shared_document',
  name: '模型分析记录',
  openUrl: 'https://content.example.invalid/resources/document-42',
  portableReference: null,
  version: '1',
  status: 'available',
  statusReasonCode: null,
  unavailableAt: null,
  revokedAt: null,
  invalidatedAt: null,
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const humanNeededFixture = humanNeededSchema.parse({
  schemaVersion: 1,
  type: 'human_needed',
  humanRequestId: TEST_IDS.humanRequestId,
  projectId: TEST_IDS.projectId,
  sourceKind: 'worker',
  taskId: TEST_IDS.taskId,
  executionId: TEST_IDS.executionId,
  sourceInboxMessageId: null,
  targetUserId: TEST_IDS.userId,
  requestedByAgentId: TEST_IDS.agentId,
  requiredAssurance: 'verified',
  prompt: '是否继续处理异常样本？',
  confirmableAction: null,
  status: 'pending',
  expiresAt: TEST_LATER_TIMESTAMP,
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const humanAnswerFixture = humanAnswerSchema.parse({
  schemaVersion: 1,
  type: 'human_answer',
  humanAnswerId: TEST_IDS.humanAnswerId,
  humanRequestId: TEST_IDS.humanRequestId,
  projectId: TEST_IDS.projectId,
  taskId: TEST_IDS.taskId,
  executionId: TEST_IDS.executionId,
  requestRevision: 1,
  answeredByUserId: TEST_IDS.userId,
  answeredFromHumanEndpointId: TEST_IDS.humanEndpointId,
  assurance: 'verified',
  answer: '继续，但请保留原始结果。',
  decision: null,
  confirmationId: null,
  answeredAt: TEST_LATER_TIMESTAMP,
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_LATER_TIMESTAMP
})

export const actionConfirmationFixture = actionConfirmationSchema.parse({
  schemaVersion: 1,
  type: 'action_confirmation',
  confirmationId: TEST_IDS.confirmationId,
  humanRequestId: TEST_IDS.humanRequestId,
  projectId: TEST_IDS.projectId,
  targetUserId: TEST_IDS.userId,
  coordinatorAgentId: TEST_IDS.agentId,
  action: { kind: 'tasks.create', projectId: TEST_IDS.projectId, proposalDigest: TEST_HASH },
  actionDigest: TEST_HASH,
  status: 'approved',
  approvedAt: TEST_TIMESTAMP,
  expiresAt: TEST_LATER_TIMESTAMP,
  consumedAt: null,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

export const projectCoordinationViewFixture = projectCoordinationViewSchema.parse({
  schemaVersion: 1,
  type: 'project_coordination_view',
  projectId: TEST_IDS.projectId,
  projectRevision: projectFixture.revision,
  project: projectFixture,
  members: [
    { userId: TEST_IDS.userId, displayName: '项目负责人', role: 'owner', active: true },
    { userId: TEST_IDS.secondUserId, displayName: '项目成员', role: 'member', active: true }
  ],
  tasks: [taskFixture],
  records: [projectRecordFixture],
  humanRequests: [humanNeededFixture],
  humanAnswers: [humanAnswerFixture],
  readAt: TEST_LATER_TIMESTAMP
})

export const providerEventFixture = providerEventSchema.parse({
  protocolVersion: '1.0',
  type: 'provider.message.created',
  provider: 'example-im',
  eventId: 'provider-event-1',
  eventCursor: 'cursor-1',
  occurredAt: TEST_TIMESTAMP,
  identity: providerIdentityFixture,
  locator: chineseProviderLocatorFixture,
  providerMessageId: 'provider-message-1',
  text: '从手机发送的测试消息',
  isSelfEcho: false
})

export const providerHumanAnswerEventFixture = providerEventSchema.parse({
  protocolVersion: '1.0',
  type: 'provider.human_answer.responded',
  provider: 'example-im',
  eventId: 'provider-event-answer-1',
  eventCursor: 'cursor-answer-1',
  occurredAt: TEST_TIMESTAMP,
  identity: providerIdentityFixture,
  locator: chineseProviderLocatorFixture,
  providerMessageId: 'provider-message-answer-1',
  humanRequestId: TEST_IDS.humanRequestId,
  requestRevision: 1,
  answer: '继续处理，并保留原始结果。'
})

export const projectionUpdatedPayloadFixture = agentInboxPayloadSchema.parse({
  protocolVersion: '1.0',
  type: 'projection.updated',
  projectionId: TEST_IDS.projectionId,
  revision: 2
})

export const agentInboxMessageFixture = agentInboxMessageSchema.parse({
  schemaVersion: 1,
  type: 'inbox_message',
  inboxMessageId: TEST_IDS.inboxMessageId,
  recipientType: 'agent',
  recipientAgentId: TEST_IDS.agentId,
  sequence: 1,
  status: 'pending',
  disposition: 'active',
  createdAt: TEST_TIMESTAMP,
  payload: {
    protocolVersion: '1.0',
    type: 'personal.message.received',
    projectionId: TEST_IDS.projectionId,
    projectionRevision: 1,
    senderUserId: TEST_IDS.userId,
    humanEndpointId: TEST_IDS.humanEndpointId,
    providerMessageId: 'provider-message-1',
    text: '从手机发送的测试消息',
    occurredAt: TEST_TIMESTAMP
  }
})

export const operationReceiptFixture = operationReceiptSchema.parse({
  schemaVersion: 1,
  type: 'operation.receipt',
  receiptId: TEST_IDS.receiptId,
  actor: {
    actorType: 'agent',
    userId: TEST_IDS.userId,
    agentId: TEST_IDS.agentId,
    assurance: 'strong'
  },
  idempotencyKey: 'idem_fixture_operation_0001',
  requestHash: TEST_HASH,
  status: 'succeeded',
  resultHash: TEST_HASH,
  createdAt: TEST_TIMESTAMP
})

export const restRequestFixture = restRequestSchema.parse({
  protocolVersion: '1.0',
  requestId: TEST_IDS.requestId,
  type: 'project.get',
  projectId: TEST_IDS.projectId
})

export const webSocketMessageFixture = webSocketMessageSchema.parse({
  protocolVersion: '1.0',
  type: 'inbox.available',
  recipientType: 'agent',
  highestSequence: 1
})

export function invalidTestOnlyValue(label: string): string {
  return ['INVALID', 'TEST', 'ONLY', label].join('_')
}

export const INVALID_TEST_ONLY_CREDENTIAL_FIXTURE = Object.freeze({
  authorization: ['Bearer', invalidTestOnlyValue('BEARER_VALUE')].join(' '),
  nested: {
    deviceToken: invalidTestOnlyValue('DEVICE_VALUE'),
    apiKey: invalidTestOnlyValue('API_VALUE'),
    privateKey: [
      ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '),
      invalidTestOnlyValue('KEY_MATERIAL'),
      ['-----END', 'PRIVATE', 'KEY-----'].join(' ')
    ].join('\n')
  },
  safe: 'diagnostic-safe-value'
})

export const redactedCredentialFixture = redactCredentials(INVALID_TEST_ONLY_CREDENTIAL_FIXTURE)

export const agentOwnerTransferredResponseFixture = {
  protocolVersion: '1.0' as const,
  type: 'agent.owner_transferred' as const,
  requestId: TEST_IDS.requestId,
  agent: agentNodeSchema.parse({
    ...agentNodeFixture,
    ownerUserId: TEST_IDS.secondUserId,
    credentialVersion: 2,
    revision: 2,
    updatedAt: TEST_LATER_TIMESTAMP
  }),
  deviceCredential: invalidTestOnlyValue('DEVICE_CREDENTIAL').padEnd(40, '0')
}

export const collaborationFixtures = Object.freeze({
  userPrincipal: userPrincipalFixture,
  humanEndpointBinding: humanEndpointBindingFixture,
  endpointChallenge: endpointChallengeFixture,
  agentNode: agentNodeFixture,
  participantProfile: participantProfileFixture,
  remoteSessionProjection: remoteSessionProjectionFixture,
  projectInput: projectInputFixture,
  project: projectFixture,
  agentCapabilityProfile: agentCapabilityProfileFixture,
  projectCapabilityDirectory: projectCapabilityDirectoryFixture,
  projectCoordinationView: projectCoordinationViewFixture,
  task: taskFixture,
  projectRecord: projectRecordFixture,
  resourceRef: resourceRefFixture,
  humanNeeded: humanNeededFixture,
  humanAnswer: humanAnswerFixture,
  actionConfirmation: actionConfirmationFixture,
  providerEvent: providerEventFixture,
  providerHumanAnswerEvent: providerHumanAnswerEventFixture,
  projectionUpdatedPayload: projectionUpdatedPayloadFixture,
  agentInboxMessage: agentInboxMessageFixture,
  operationReceipt: operationReceiptFixture,
  restRequest: restRequestFixture,
  webSocketMessage: webSocketMessageFixture
})

export type CollaborationFixtures = typeof collaborationFixtures
export type TestIds = typeof TEST_IDS
export type FixtureSchemaOutput<Schema extends z.ZodType> = z.output<Schema>
