#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_RECEIPT_BYTES = 256 * 1024
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u
const OPAQUE_SUFFIX = '[A-Za-z0-9](?:[A-Za-z0-9_]{10,62}[A-Za-z0-9])'
const FORBIDDEN_KEY = /(?:access|refresh|id)?token|secret|credential|private.?key|email|local.?path|absolute.?path|provider.?dto/iu
const FORBIDDEN_TEXT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+=*|(?:^|\s)(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu

export class RealFileRun0ReceiptError extends Error {
  constructor(readonlyCode) {
    super(readonlyCode)
    this.name = 'RealFileRun0ReceiptError'
    this.code = readonlyCode
  }
}

function fail(code) {
  throw new RealFileRun0ReceiptError(code)
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value, keys, label) {
  if (!record(value)) fail(`${label}_invalid`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label}_shape_invalid`)
  }
  return value
}

function sha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(`${label}_invalid`)
  return value
}

function commit(value, label) {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) fail(`${label}_invalid`)
  return value
}

function opaqueId(value, prefix, label) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_${OPAQUE_SUFFIX}$`, 'u').test(value)) {
    fail(`${label}_invalid`)
  }
  return value
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label}_invalid`)
  return value
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label}_invalid`)
  return value
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) {
    fail(`${label}_invalid`)
  }
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(`${label}_invalid`)
  return time
}

function providerOperationId(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\p{Cc}]/u.test(value)) {
    fail(`${label}_invalid`)
  }
  return value
}

function validateTransfer(value, label) {
  const transfer = exact(value, [
    'operationId',
    'outcome',
    'bytes',
    'sha256',
    'providerReceiptSha256'
  ], label)
  providerOperationId(transfer.operationId, `${label}_operation_id`)
  if (transfer.outcome !== 'succeeded') fail(`${label}_outcome_invalid`)
  nonnegativeInteger(transfer.bytes, `${label}_bytes`)
  sha256(transfer.sha256, `${label}_sha256`)
  sha256(transfer.providerReceiptSha256, `${label}_provider_receipt_sha256`)
  return transfer
}

function validateParticipant(value, role, finalCommit) {
  const participant = exact(value, [
    'role',
    'sourceCommit',
    'packagedArtifactSha256',
    'openContentPrincipalDigest',
    'userId',
    'deviceId',
    'agentId'
  ], role)
  if (participant.role !== role) fail(`${role}_role_invalid`)
  if (commit(participant.sourceCommit, `${role}_source_commit`) !== finalCommit) {
    fail(`${role}_commit_mismatch`)
  }
  sha256(participant.packagedArtifactSha256, `${role}_packaged_artifact_sha256`)
  sha256(participant.openContentPrincipalDigest, `${role}_opencontent_principal_digest`)
  opaqueId(participant.userId, 'usr', `${role}_user_id`)
  opaqueId(participant.deviceId, 'dev', `${role}_device_id`)
  opaqueId(participant.agentId, 'agt', `${role}_agent_id`)
  return participant
}

function rejectSensitiveMaterial(value, path = '$') {
  if (typeof value === 'string') {
    if (FORBIDDEN_TEXT.test(value)) fail('sensitive_material_detected')
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSensitiveMaterial(entry, `${path}[${index}]`))
    return
  }
  if (!record(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) fail('sensitive_field_detected')
    rejectSensitiveMaterial(nested, `${path}.${key}`)
  }
}

export function verifyRealFileTaskLoopRun0Receipt(value, options = {}) {
  const receipt = exact(value, [
    'schemaVersion',
    'type',
    'status',
    'finalCommit',
    'harnessSha256',
    'release',
    'coordinator',
    'worker',
    'project',
    'inputs',
    'output',
    'result',
    'startedAt',
    'completedAt'
  ], 'receipt')
  rejectSensitiveMaterial(receipt)
  if (receipt.schemaVersion !== 1 || receipt.type !== 'sciforge.real_file_task_loop_run_0.receipt' ||
      receipt.status !== 'passed') fail('receipt_identity_invalid')
  const finalCommit = commit(receipt.finalCommit, 'final_commit')
  const harnessSha256 = sha256(receipt.harnessSha256, 'harness_sha256')
  if (options.expectedHarnessSha256 !== undefined && harnessSha256 !== options.expectedHarnessSha256) {
    fail('harness_sha256_mismatch')
  }

  const release = exact(receipt.release, [
    'contractCommit',
    'releaseManifestSha256',
    'databaseSchemaVersion',
    'appImageId',
    'appRevision'
  ], 'release')
  if (commit(release.contractCommit, 'release_contract_commit') !== finalCommit ||
      commit(release.appRevision, 'release_app_revision') !== finalCommit) {
    fail('release_commit_mismatch')
  }
  if (release.databaseSchemaVersion !== 10) fail('release_schema_mismatch')
  sha256(release.releaseManifestSha256, 'release_manifest_sha256')
  if (options.expectedReleaseManifestSha256 !== undefined &&
      release.releaseManifestSha256 !== options.expectedReleaseManifestSha256) {
    fail('release_manifest_sha256_mismatch')
  }
  if (typeof release.appImageId !== 'string' || !IMAGE_ID_PATTERN.test(release.appImageId)) {
    fail('release_image_id_invalid')
  }
  if (options.expectedCommit !== undefined && finalCommit !== options.expectedCommit) {
    fail('final_commit_mismatch')
  }

  const coordinator = validateParticipant(receipt.coordinator, 'coordinator', finalCommit)
  const worker = validateParticipant(receipt.worker, 'worker', finalCommit)
  for (const field of ['userId', 'deviceId', 'agentId', 'openContentPrincipalDigest']) {
    if (coordinator[field] === worker[field]) fail(`participant_${field}_not_distinct`)
  }

  const project = exact(receipt.project, [
    'projectId',
    'bindingRevision',
    'rootResourceRefId',
    'taskId',
    'executionId',
    'projectRecordId'
  ], 'project')
  opaqueId(project.projectId, 'prj', 'project_id')
  positiveInteger(project.bindingRevision, 'binding_revision')
  opaqueId(project.rootResourceRefId, 'rrf', 'root_resource_ref_id')
  opaqueId(project.taskId, 'tsk', 'task_id')
  opaqueId(project.executionId, 'exe', 'execution_id')
  opaqueId(project.projectRecordId, 'rec', 'project_record_id')

  if (!Array.isArray(receipt.inputs) || receipt.inputs.length < 1 || receipt.inputs.length > 100) {
    fail('inputs_invalid')
  }
  const inputIds = new Set()
  for (const [index, value] of receipt.inputs.entries()) {
    const input = exact(value, [
      'resourceRefId',
      'sourceBytes',
      'sourceSha256',
      'workerDownload'
    ], `input_${index}`)
    const resourceRefId = opaqueId(input.resourceRefId, 'rrf', `input_${index}_resource_ref_id`)
    if (inputIds.has(resourceRefId) || resourceRefId === project.rootResourceRefId) {
      fail('input_resource_ref_invalid')
    }
    inputIds.add(resourceRefId)
    nonnegativeInteger(input.sourceBytes, `input_${index}_source_bytes`)
    sha256(input.sourceSha256, `input_${index}_source_sha256`)
    const download = validateTransfer(input.workerDownload, `input_${index}_worker_download`)
    if (download.bytes !== input.sourceBytes || download.sha256 !== input.sourceSha256) {
      fail('input_download_mismatch')
    }
  }

  const output = exact(receipt.output, [
    'resourceRefId',
    'portableReferenceSha256',
    'workerUpload',
    'coordinatorRedownload'
  ], 'output')
  const outputResourceRefId = opaqueId(output.resourceRefId, 'rrf', 'output_resource_ref_id')
  if (inputIds.has(outputResourceRefId) || outputResourceRefId === project.rootResourceRefId) {
    fail('output_resource_ref_invalid')
  }
  sha256(output.portableReferenceSha256, 'output_portable_reference_sha256')
  const upload = validateTransfer(output.workerUpload, 'worker_upload')
  const redownload = validateTransfer(output.coordinatorRedownload, 'coordinator_redownload')
  if (upload.bytes !== redownload.bytes || upload.sha256 !== redownload.sha256) {
    fail('output_redownload_mismatch')
  }

  const result = exact(receipt.result, [
    'taskStatus',
    'taskResultResourceRefIds',
    'projectRecordStatus',
    'projectRecordResourceRefIds'
  ], 'result')
  if (result.taskStatus !== 'succeeded' || !['candidate', 'accepted'].includes(result.projectRecordStatus)) {
    fail('result_status_invalid')
  }
  for (const [field, values] of [
    ['task_result_resource_refs', result.taskResultResourceRefIds],
    ['project_record_resource_refs', result.projectRecordResourceRefIds]
  ]) {
    if (!Array.isArray(values) || values.length !== 1 || values[0] !== outputResourceRefId) {
      fail(`${field}_mismatch`)
    }
  }

  const startedAt = timestamp(receipt.startedAt, 'started_at')
  const completedAt = timestamp(receipt.completedAt, 'completed_at')
  if (completedAt < startedAt) fail('receipt_time_order_invalid')

  return Object.freeze({
    type: receipt.type,
    status: receipt.status,
    finalCommit,
    releaseManifestSha256: release.releaseManifestSha256,
    projectId: project.projectId,
    taskId: project.taskId,
    executionId: project.executionId,
    outputResourceRefId,
    projectRecordId: project.projectRecordId,
    outputSha256: upload.sha256,
    completedAt: receipt.completedAt
  })
}

export async function readAndVerifyRealFileTaskLoopRun0Receipt(path, options = {}) {
  const absolutePath = resolve(path)
  const details = await lstat(absolutePath)
  if (!details.isFile() || details.isSymbolicLink() || details.size < 2 || details.size > MAX_RECEIPT_BYTES) {
    fail('receipt_file_invalid')
  }
  const text = await readFile(absolutePath, 'utf8')
  let value
  try {
    value = JSON.parse(text)
  } catch {
    fail('receipt_json_invalid')
  }
  return verifyRealFileTaskLoopRun0Receipt(value, options)
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!['--receipt', '--expected-commit', '--expected-release-manifest-sha256'].includes(name)) {
      fail('argument_invalid')
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail('argument_invalid')
    index += 1
    if (name === '--receipt') options.receipt = value
    if (name === '--expected-commit') options.expectedCommit = commit(value, 'expected_commit')
    if (name === '--expected-release-manifest-sha256') {
      options.expectedReleaseManifestSha256 = sha256(value, 'expected_release_manifest_sha256')
    }
  }
  if (!options.receipt) fail('receipt_argument_missing')
  return options
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2))
    const harnessSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')
    const verified = await readAndVerifyRealFileTaskLoopRun0Receipt(options.receipt, {
      expectedHarnessSha256: harnessSha256,
      ...(options.expectedCommit ? { expectedCommit: options.expectedCommit } : {}),
      ...(options.expectedReleaseManifestSha256
        ? { expectedReleaseManifestSha256: options.expectedReleaseManifestSha256 }
        : {})
    })
    process.stdout.write(`${JSON.stringify(verified)}\n`)
  } catch (error) {
    const code = error instanceof RealFileRun0ReceiptError ? error.code : 'internal_error'
    process.stderr.write(`REAL_FILE_TASK_LOOP_RUN_0 verification failed: ${code}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
