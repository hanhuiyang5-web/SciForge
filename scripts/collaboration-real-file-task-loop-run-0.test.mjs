import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  RealFileRun0ReceiptError,
  readAndVerifyRealFileTaskLoopRun0Receipt,
  verifyRealFileTaskLoopRun0Receipt
} from './collaboration-real-file-task-loop-run-0.mjs'

const COMMIT = '1'.repeat(40)
const HARNESS_SHA256 = createHash('sha256')
  .update(await readFile(new URL('./collaboration-real-file-task-loop-run-0.mjs', import.meta.url)))
  .digest('hex')

function id(prefix, suffix) {
  return `${prefix}_${suffix.padEnd(12, '0')}`
}

function transfer(operationId, bytes, sha) {
  return {
    operationId,
    outcome: 'succeeded',
    bytes,
    sha256: sha,
    providerReceiptSha256: createHash('sha256').update(`receipt:${operationId}`).digest('hex')
  }
}

function fixture() {
  const inputSha = createHash('sha256').update('real input').digest('hex')
  const outputSha = createHash('sha256').update('real output').digest('hex')
  const outputResourceRefId = id('rrf', 'output')
  return {
    schemaVersion: 1,
    type: 'sciforge.real_file_task_loop_run_0.receipt',
    status: 'passed',
    finalCommit: COMMIT,
    harnessSha256: HARNESS_SHA256,
    release: {
      contractCommit: COMMIT,
      releaseManifestSha256: '2'.repeat(64),
      databaseSchemaVersion: 10,
      appImageId: `sha256:${'3'.repeat(64)}`,
      appRevision: COMMIT
    },
    coordinator: {
      role: 'coordinator',
      sourceCommit: COMMIT,
      packagedArtifactSha256: '4'.repeat(64),
      openContentPrincipalDigest: '5'.repeat(64),
      userId: id('usr', 'coordinator'),
      deviceId: id('dev', 'coordinator'),
      agentId: id('agt', 'coordinator')
    },
    worker: {
      role: 'worker',
      sourceCommit: COMMIT,
      packagedArtifactSha256: '4'.repeat(64),
      openContentPrincipalDigest: '6'.repeat(64),
      userId: id('usr', 'worker'),
      deviceId: id('dev', 'worker'),
      agentId: id('agt', 'worker')
    },
    project: {
      projectId: id('prj', 'project'),
      bindingRevision: 1,
      rootResourceRefId: id('rrf', 'root'),
      taskId: id('tsk', 'task'),
      executionId: id('exe', 'execution'),
      projectRecordId: id('rec', 'record')
    },
    inputs: [{
      resourceRefId: id('rrf', 'input'),
      sourceBytes: 10,
      sourceSha256: inputSha,
      workerDownload: transfer('download-input-op', 10, inputSha)
    }],
    output: {
      resourceRefId: outputResourceRefId,
      portableReferenceSha256: '7'.repeat(64),
      workerUpload: transfer('upload-output-op', 11, outputSha),
      coordinatorRedownload: transfer('redownload-output-op', 11, outputSha)
    },
    result: {
      taskStatus: 'succeeded',
      taskResultResourceRefIds: [outputResourceRefId],
      projectRecordStatus: 'candidate',
      projectRecordResourceRefIds: [outputResourceRefId]
    },
    startedAt: '2026-08-23T04:00:00.000Z',
    completedAt: '2026-08-23T04:05:00.000Z'
  }
}

test('accepts one exact-SHA two-account packaged real-file loop receipt', () => {
  const verified = verifyRealFileTaskLoopRun0Receipt(fixture(), {
    expectedHarnessSha256: HARNESS_SHA256,
    expectedCommit: COMMIT,
    expectedReleaseManifestSha256: '2'.repeat(64)
  })
  assert.equal(verified.status, 'passed')
  assert.equal(verified.outputSha256, fixture().output.workerUpload.sha256)
})

test('rejects identity reuse, transfer mismatch, stale schema, and sensitive material', () => {
  for (const mutate of [
    (value) => { value.worker.userId = value.coordinator.userId },
    (value) => { value.output.coordinatorRedownload.sha256 = '8'.repeat(64) },
    (value) => { value.release.databaseSchemaVersion = 9 },
    (value) => { value.worker.localPath = '/Users/example/output.csv' }
  ]) {
    const value = fixture()
    mutate(value)
    assert.throws(
      () => verifyRealFileTaskLoopRun0Receipt(value, { expectedHarnessSha256: HARNESS_SHA256 }),
      RealFileRun0ReceiptError
    )
  }
})

test('reads only one bounded regular JSON receipt and binds the harness digest', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-real-file-run0-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const receiptPath = join(directory, 'receipt.json')
  await writeFile(receiptPath, `${JSON.stringify(fixture())}\n`, { mode: 0o600 })
  await chmod(receiptPath, 0o600)
  const verified = await readAndVerifyRealFileTaskLoopRun0Receipt(receiptPath, {
    expectedHarnessSha256: HARNESS_SHA256
  })
  assert.equal(verified.finalCommit, COMMIT)
  await assert.rejects(
    readAndVerifyRealFileTaskLoopRun0Receipt(receiptPath, { expectedHarnessSha256: 'f'.repeat(64) }),
    (error) => error instanceof RealFileRun0ReceiptError && error.code === 'harness_sha256_mismatch'
  )
})
