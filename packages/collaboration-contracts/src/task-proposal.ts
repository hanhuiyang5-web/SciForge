import { z } from 'zod'

import {
  agentIdSchema,
  criterionIdSchema,
  projectIdSchema,
  resourceRefIdSchema,
  taskIdSchema
} from './core.js'
import {
  authorizationRequirementSchema,
  taskFileIntentSchema,
  workerRequirementSchema
} from './entities.js'

export const TASK_CREATE_PROPOSAL_DIGEST_ALGORITHM = 'sha256-canonical-json-v1' as const

const taskCreateProposalCriterionSchema = z.union([
  z.string().trim().min(1).max(2_000),
  z.object({
    criterionId: criterionIdSchema,
    text: z.string().trim().min(1).max(2_000)
  }).strict()
])

export const taskCreateProposalInputSchema = z.object({
  projectId: projectIdSchema,
  assigneeAgentId: agentIdSchema,
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(32_000),
  completionCriteria: z.array(taskCreateProposalCriterionSchema).min(1).max(100),
  dependencyTaskIds: z.array(taskIdSchema).max(1_000),
  requiredCapabilities: workerRequirementSchema.default({
    capabilityIds: [],
    vpnAccessIds: [],
    slurmClusterIds: [],
    requiredResourceRefIds: []
  }),
  resourceRefIds: z.array(resourceRefIdSchema).max(1_000).default([]),
  fileIntent: taskFileIntentSchema.optional(),
  authorizationRequirements: z.array(authorizationRequirementSchema).max(100).default([])
}).strict().superRefine((proposal, context) => {
  const criterionIds = proposal.completionCriteria.flatMap((criterion) => (
    typeof criterion === 'string' ? [] : [criterion.criterionId]
  ))
  if (new Set(criterionIds).size !== criterionIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['completionCriteria'],
      message: 'Explicit Task criterion IDs must be unique.'
    })
  }
  const authorizationIds = proposal.authorizationRequirements.map((requirement) => requirement.id)
  if (new Set(authorizationIds).size !== authorizationIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['authorizationRequirements'],
      message: 'Task authorization requirement IDs must be unique.'
    })
  }
  if (proposal.fileIntent) {
    const expectedResourceRefIds = [
      ...proposal.fileIntent.inputs.map((input) => input.resourceRefId),
      proposal.fileIntent.output.containerResourceRefId
    ]
    if (
      proposal.resourceRefIds.length !== expectedResourceRefIds.length ||
      proposal.resourceRefIds.some((resourceRefId, index) => resourceRefId !== expectedResourceRefIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['resourceRefIds'],
        message: 'File Task ResourceRefs must exactly match ordered inputs followed by the output container.'
      })
    }
  }
})

export type TaskCreateProposalInput = z.input<typeof taskCreateProposalInputSchema>

export type NormalizedTaskCreateProposal = Readonly<{
  projectId: string
  assigneeAgentId: string
  title: string
  objective: string
  completionCriteria: readonly Readonly<{ criterionId?: string; text: string }>[]
  dependencyTaskIds: readonly string[]
  requiredCapabilities: Readonly<z.output<typeof workerRequirementSchema>>
  resourceRefIds: readonly string[]
  fileIntent?: Readonly<z.output<typeof taskFileIntentSchema>>
  authorizationRequirements: readonly Readonly<z.output<typeof authorizationRequirementSchema>>[]
}>

/** Normalizes exactly the business fields covered by a tasks.create confirmation. */
export function normalizeTaskCreateProposal(input: unknown): NormalizedTaskCreateProposal {
  const parsed = taskCreateProposalInputSchema.parse(input)
  return deepFreeze({
    projectId: parsed.projectId,
    assigneeAgentId: parsed.assigneeAgentId,
    title: parsed.title,
    objective: parsed.objective,
    completionCriteria: parsed.completionCriteria.map((criterion) => (
      typeof criterion === 'string'
        ? { text: criterion }
        : { criterionId: criterion.criterionId, text: criterion.text }
    )),
    dependencyTaskIds: [...new Set(parsed.dependencyTaskIds)],
    requiredCapabilities: parsed.requiredCapabilities,
    resourceRefIds: [...new Set(parsed.resourceRefIds)],
    ...(parsed.fileIntent ? { fileIntent: parsed.fileIntent } : {}),
    authorizationRequirements: parsed.authorizationRequirements
  })
}

/** Returns a lowercase SHA-256 digest of the normalized proposal canonical JSON. */
export function computeTaskCreateProposalDigest(input: unknown): string {
  const canonicalJson = canonicalJsonValue(normalizeTaskCreateProposal(input))
  return sha256Hex(new TextEncoder().encode(canonicalJson))
}

/** Exposed for fixed-vector verification and language-independent adapters. */
export function canonicalTaskCreateProposalJson(input: unknown): string {
  return canonicalJsonValue(normalizeTaskCreateProposal(input))
}

function canonicalJsonValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Task proposal canonical JSON requires finite numbers.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`
  if (!value || typeof value !== 'object') {
    throw new TypeError('Task proposal canonical JSON accepts JSON values only.')
  }
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`)
  return `{${entries.join(',')}}`
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

// FIPS 180-4 SHA-256, kept here so browser/Desktop consumers do not import the
// Node-only collaboration server or maintain their own proposal digest code.
const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
] as const

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const

function sha256Hex(bytes: Uint8Array): string {
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  const bitLength = bytes.length * 8
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  const hash: number[] = [...SHA256_INITIAL]
  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false)
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!
      const previous2 = words[index - 2]!
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3)
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10)
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = hash as [
      number, number, number, number, number, number, number, number
    ]
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temporary1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temporary2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temporary1) >>> 0
      d = c
      c = b
      b = a
      a = (temporary1 + temporary2) >>> 0
    }
    hash[0] = (hash[0]! + a) >>> 0
    hash[1] = (hash[1]! + b) >>> 0
    hash[2] = (hash[2]! + c) >>> 0
    hash[3] = (hash[3]! + d) >>> 0
    hash[4] = (hash[4]! + e) >>> 0
    hash[5] = (hash[5]! + f) >>> 0
    hash[6] = (hash[6]! + g) >>> 0
    hash[7] = (hash[7]! + h) >>> 0
  }
  return hash.map((word) => word.toString(16).padStart(8, '0')).join('')
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count))
}
