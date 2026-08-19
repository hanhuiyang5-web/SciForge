import { createHash, createPublicKey, verify } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  DEVICE_ENROLLMENT_SIGNING_DOMAIN,
  canonicalEnrollmentBytes,
  enrollmentSigningFactsSchema
} from './enrollment-signing.js'
import {
  TASK_CREATE_PROPOSAL_DIGEST_ALGORITHM,
  canonicalTaskCreateProposalJson,
  computeTaskCreateProposalDigest,
  normalizeTaskCreateProposal,
  taskCreateProposalInputSchema
} from './task-proposal.js'
import {
  DEVICE_ENROLLMENT_SIGNING_TEST_VECTOR,
  TASK_CREATE_PROPOSAL_DIGEST_TEST_VECTOR
} from './testing.js'

describe('client-safe Device enrollment signing contract', () => {
  it('matches the fixed Ed25519 signing vector without importing the server', () => {
    const vector = DEVICE_ENROLLMENT_SIGNING_TEST_VECTOR
    expect(DEVICE_ENROLLMENT_SIGNING_DOMAIN).toBe(vector.domain)
    expect(enrollmentSigningFactsSchema.parse(vector.facts)).toEqual(vector.facts)
    const bytes = canonicalEnrollmentBytes(vector.facts)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(bytes).toString('utf8')).toBe(vector.canonicalUtf8)
    expect(Buffer.from(bytes).toString('base64url')).toBe(vector.canonicalBase64Url)
    expect(verify(
      null,
      bytes,
      createPublicKey({ key: vector.publicKeyJwk, format: 'jwk' }),
      Buffer.from(vector.signature, 'base64url')
    )).toBe(true)
  })

  it('rejects malformed IDs, non-canonical nonces, line breaks, and timestamps', () => {
    const facts = DEVICE_ENROLLMENT_SIGNING_TEST_VECTOR.facts
    for (const candidate of [
      { ...facts, enrollmentId: 'enrollment-1' },
      { ...facts, nonce: `${facts.nonce}=` },
      { ...facts, nonce: `${facts.nonce.slice(0, -1)}9` },
      { ...facts, installationId: 'ins_Bad\nInstall0001' },
      { ...facts, expiresAt: 'tomorrow' }
    ]) {
      expect(() => canonicalEnrollmentBytes(candidate)).toThrow()
    }
  })
})

describe('public Task create proposal digest contract', () => {
  it('normalizes and hashes the complete fixed vector identically to Node SHA-256', () => {
    const vector = TASK_CREATE_PROPOSAL_DIGEST_TEST_VECTOR
    expect(TASK_CREATE_PROPOSAL_DIGEST_ALGORITHM).toBe(vector.algorithm)
    expect(normalizeTaskCreateProposal(vector.proposal)).toEqual(vector.normalizedProposal)
    expect(canonicalTaskCreateProposalJson(vector.proposal)).toBe(vector.canonicalJson)
    expect(computeTaskCreateProposalDigest(vector.proposal)).toBe(vector.digest)
    expect(createHash('sha256').update(vector.canonicalJson, 'utf8').digest('hex')).toBe(vector.digest)
  })

  it('applies public defaults, preserves list order, removes duplicate references, and freezes output', () => {
    const normalized = normalizeTaskCreateProposal({
      projectId: 'prj_ProposalDefaults01',
      assigneeAgentId: 'agt_ProposalDefaults01',
      title: '  Default proposal  ',
      objective: '  Exercise public normalization.  ',
      completionCriteria: ['  Return one result.  '],
      dependencyTaskIds: ['tsk_ProposalDependency01', 'tsk_ProposalDependency01'],
      resourceRefIds: ['rrf_ProposalResource02', 'rrf_ProposalResource01', 'rrf_ProposalResource02']
    })
    expect(normalized).toMatchObject({
      title: 'Default proposal',
      objective: 'Exercise public normalization.',
      completionCriteria: [{ text: 'Return one result.' }],
      dependencyTaskIds: ['tsk_ProposalDependency01'],
      requiredCapabilities: {
        capabilityIds: [],
        vpnAccessIds: [],
        slurmClusterIds: [],
        requiredResourceRefIds: []
      },
      resourceRefIds: ['rrf_ProposalResource02', 'rrf_ProposalResource01'],
      authorizationRequirements: []
    })
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(Object.isFrozen(normalized.completionCriteria)).toBe(true)
  })

  it('rejects duplicate explicit criterion and authorization identities before hashing', () => {
    const proposal = TASK_CREATE_PROPOSAL_DIGEST_TEST_VECTOR.proposal
    expect(taskCreateProposalInputSchema.safeParse({
      ...proposal,
      completionCriteria: [proposal.completionCriteria[1], proposal.completionCriteria[1]]
    }).success).toBe(false)
    expect(taskCreateProposalInputSchema.safeParse({
      ...proposal,
      authorizationRequirements: [
        proposal.authorizationRequirements[0],
        proposal.authorizationRequirements[0]
      ]
    }).success).toBe(false)
  })
})
