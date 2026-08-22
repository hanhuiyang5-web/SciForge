import assert from 'node:assert/strict'
import test from 'node:test'
import { A_CONTRACT_COMMIT, A_CONTRACT_TGZ_SHA256 } from './a-contract.js'

test('pins the A contract commit and release artifact SHA', () => {
  assert.equal(A_CONTRACT_COMMIT, '9507390cb65d9be27522bb02d7ae2e4cf0993c7b')
  assert.equal(A_CONTRACT_TGZ_SHA256, '1400f659eb3ad88624b716ebe7f484619c06240133b065df079c68d7d06eb8f0')
})
