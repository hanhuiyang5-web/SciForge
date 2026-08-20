import assert from 'node:assert/strict'
import test from 'node:test'
import { A_CONTRACT_COMMIT, A_CONTRACT_TGZ_SHA256 } from './a-contract.js'

test('pins the A contract commit and release artifact SHA', () => {
  assert.equal(A_CONTRACT_COMMIT, '8c88e811b9ab0757c75e2c0a52c7e93c065ce496')
  assert.equal(A_CONTRACT_TGZ_SHA256, '411ceb837d6c8b35021a61cfda462d5c5399b32a5b775e81bc92572dfd6f6a5d')
})
