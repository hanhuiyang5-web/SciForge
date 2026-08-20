import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeTaskCreateProposalDigest
} from '@sciforge/collaboration-contracts'
import { TASK_CREATE_PROPOSAL_DIGEST_TEST_VECTOR } from '@sciforge/collaboration-contracts/testing'

test('B consumes A public Task proposal digest helper and fixed vector', () => {
  assert.equal(
    computeTaskCreateProposalDigest(TASK_CREATE_PROPOSAL_DIGEST_TEST_VECTOR.proposal),
    TASK_CREATE_PROPOSAL_DIGEST_TEST_VECTOR.digest
  )
})
