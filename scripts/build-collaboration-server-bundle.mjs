#!/usr/bin/env node

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { createReadStream, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRepositoryRoot = resolve(scriptDirectory, '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const gitCommand = process.platform === 'win32' ? 'git.exe' : 'git'
const manifestFilename = 'RELEASE_MANIFEST.json'
const domainSdkPackageName = '@sciforge/domain-sdk'
const collaborationContractsPackageName = '@sciforge/collaboration-contracts'
const collaborationPortalPackageName = '@sciforge/collaboration-portal'
const contractArtifactPrefix = 'artifacts/protocol-1.0/'
const contractArtifactManifestFilename = 'ARTIFACT_MANIFEST.json'
const contractCommitPlaceholder = '__SCIFORGE_COLLABORATION_COMMIT__'
const collaborationDatabaseSchemaVersion = 10
const maximumUnpackedArchiveBytes = 128 * 1024 * 1024
const tarBlockBytes = 512
const immutableSnapshotGuardFilename = '.sciforge-collaboration-bundle-snapshot-guard.json'
const portalBasePath = '/portal/'
const portalViteManifestPath = 'dist/.vite/manifest.json'
const portalIntegrityManifestPath = 'dist/ASSET_INTEGRITY.json'
export const COLLABORATION_PORTAL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; manifest-src 'none'"
export const IMMUTABLE_SNAPSHOT_GUARD_ENVIRONMENT = Object.freeze({
  path: 'SCIFORGE_COLLABORATION_BUNDLE_INTERNAL_GUARD_PATH',
  token: 'SCIFORGE_COLLABORATION_BUNDLE_INTERNAL_GUARD_TOKEN'
})
const aHttpsTestEdgeImage = 'caddy:2.11.4-alpine@sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a'
const identityAcceptanceHarnessRelativePath = 'scripts/collaboration-a-identity-acceptance.mjs'
const multiWorkerAcceptanceHarnessRelativePath =
  'scripts/collaboration-a-multi-worker-acceptance.mjs'
const realFileRun0ReceiptHarnessRelativePath =
  'scripts/collaboration-real-file-task-loop-run-0.mjs'
const aHttpsSharedEdgeAssets = Object.freeze({
  edgeDockerignoreSha256: Object.freeze({
    relativePath: 'deploy/collaboration-private/.dockerignore'
  }),
  edgeBaseComposeSha256: Object.freeze({
    relativePath: 'deploy/collaboration-private/compose.yml'
  }),
  edgeRuntimeDockerfileSha256: Object.freeze({
    relativePath: 'deploy/collaboration-private/Dockerfile.runtime'
  }),
  edgePostgresInitScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/postgres-init/001-create-application-role.sh'
  }),
  edgeBaseDeployScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/deploy.sh'
  }),
  edgeBaseVerifyScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/verify.sh'
  }),
  edgeBackupScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/backup.sh'
  }),
  edgeBackupRestoreVerifyScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/verify-backup-restore.sh'
  }),
  edgePostgresRestartVerifyScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/verify-postgres-restart.sh'
  }),
  edgePostgresV5VerifyScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/verify-postgres-v5-integration.sh'
  }),
  edgePostgresV5IntegrationScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/postgres-v5-integration.mjs'
  }),
  edgeCommonScriptSha256: Object.freeze({
    relativePath: 'deploy/collaboration-private/scripts/common.sh'
  })
})
const aHttpsTestEdgeAssets = Object.freeze({
  ...aHttpsSharedEdgeAssets,
  edgeCaddyfileSha256: Object.freeze({
    relativePath: 'deploy/collaboration-private/Caddyfile.a-https-test-edge'
  }),
  edgeComposeSha256: Object.freeze({
    relativePath: 'deploy/collaboration-private/compose.a-https-test-edge.yml'
  }),
  edgeDeployScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/deploy-a-https-test-edge.sh'
  }),
  edgeDisableScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/disable-a-https-test-edge.sh'
  }),
  edgeExternalVerifyScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/verify-a-https-test-edge-external.sh'
  }),
  edgeVerifyScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/verify-a-https-test-edge.sh'
  })
})
const aHttpsOidcTestAssets = Object.freeze({
  ...aHttpsSharedEdgeAssets,
  portalComposeSha256: Object.freeze({
    relativePath: 'deploy/collaboration-private/compose.a-cloud-portal.yml'
  }),
  portalAssetVerifyScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/verify-portal-assets.mjs'
  }),
  identityEdgeCaddyfileSha256: Object.freeze({
    relativePath: 'deploy/collaboration-private/Caddyfile.a-https-oidc-test'
  }),
  identityEdgeComposeSha256: Object.freeze({
    relativePath: 'deploy/collaboration-private/compose.a-https-oidc-test.yml'
  }),
  identityEdgeDeployScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/deploy-a-https-oidc-test.sh'
  }),
  identityEdgeDisableScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/disable-a-https-oidc-test.sh'
  }),
  identityEdgeExternalVerifyScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/verify-a-https-oidc-test-external.sh'
  }),
  identityEdgeVerifyScriptSha256: Object.freeze({
    expectedMode: 0o755,
    relativePath: 'deploy/collaboration-private/scripts/verify-a-https-oidc-test.sh'
  })
})

export const COLLABORATION_RELEASE_PACKAGES = Object.freeze([
  Object.freeze({
    directory: 'packages/domain-sdk',
    name: domainSdkPackageName,
    buildScript: 'build',
    requiredFiles: Object.freeze([
      'package.json',
      'portable-resource-provenance.json',
      'dist/contract.js',
      'dist/contract.d.ts',
      'dist/principal.js',
      'dist/principal.d.ts',
      'dist/portable-resource-references.js',
      'dist/portable-resource-references.d.ts'
    ]),
    requiredPrefixes: Object.freeze(['dist/'])
  }),
  Object.freeze({
    directory: 'packages/collaboration-contracts',
    name: collaborationContractsPackageName,
    requiredFiles: Object.freeze([
      'package.json',
      `${contractArtifactPrefix}${contractArtifactManifestFilename}`
    ]),
    requiredPrefixes: Object.freeze(['dist/', contractArtifactPrefix])
  }),
  Object.freeze({
    directory: 'packages/collaboration-provider-zulip',
    name: '@sciforge/collaboration-provider-zulip',
    requiredFiles: Object.freeze(['package.json', 'README.md', 'sciforge.provider.json']),
    requiredPrefixes: Object.freeze(['dist/'])
  }),
  Object.freeze({
    directory: 'packages/collaboration-portal',
    name: collaborationPortalPackageName,
    packageFromDirectory: true,
    requiredFiles: Object.freeze([
      'package.json',
      portalViteManifestPath,
      portalIntegrityManifestPath
    ]),
    requiredPrefixes: Object.freeze(['dist/'])
  }),
  Object.freeze({
    directory: 'packages/collaboration-server',
    name: '@sciforge/collaboration-server',
    requiredFiles: Object.freeze(['package.json', 'README.md', '.env.example']),
    requiredPrefixes: Object.freeze(['dist/', 'migrations/', 'deploy/'])
  })
])

function usage() {
  return [
    'Usage: node scripts/build-collaboration-server-bundle.mjs [options]',
    '',
    'Options:',
    '  --commit <40-char-sha>  Approved origin/gui commit (defaults to clean HEAD).',
    '  --output <directory>    Bundle destination (must be absent or empty).',
    '  --private-test-release  TEST-ONLY: allow a clean HEAD descended from origin/gui.',
    '  --team-private-acceptance  TEAM-ONLY: clean descendant for loopback/tunnel acceptance.',
    '  --a-https-test-edge      A-ONLY: clean descendant for cloud-test HTTPS/WSS edge.',
    '  --a-https-oidc-test      A-ONLY: cloud-test API plus login-test OIDC ingress.',
    '  --cross-team-r0-contract  PUBLIC CONTRACT: clean descendant for R0 machine consumers.',
    '  -h, --help              Show this help.',
    ''
  ].join('\n')
}

export function parseArguments(argv) {
  const result = {
    aHttpsOidcTest: false,
    aHttpsTestEdge: false,
    help: false,
    privateTestRelease: false,
    teamPrivateAcceptance: false,
    crossTeamR0Contract: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      result.help = true
      continue
    }
    if (argument === '--private-test-release') {
      if (result.privateTestRelease) {
        throw new Error('--private-test-release may only be provided once.')
      }
      result.privateTestRelease = true
      continue
    }
    if (argument === '--team-private-acceptance') {
      if (result.teamPrivateAcceptance) {
        throw new Error('--team-private-acceptance may only be provided once.')
      }
      result.teamPrivateAcceptance = true
      continue
    }
    if (argument === '--a-https-test-edge') {
      if (result.aHttpsTestEdge) {
        throw new Error('--a-https-test-edge may only be provided once.')
      }
      result.aHttpsTestEdge = true
      continue
    }
    if (argument === '--a-https-oidc-test') {
      if (result.aHttpsOidcTest) {
        throw new Error('--a-https-oidc-test may only be provided once.')
      }
      result.aHttpsOidcTest = true
      continue
    }
    if (argument === '--cross-team-r0-contract') {
      if (result.crossTeamR0Contract) {
        throw new Error('--cross-team-r0-contract may only be provided once.')
      }
      result.crossTeamR0Contract = true
      continue
    }
    if (argument !== '--commit' && argument !== '--output') {
      throw new Error(`Unknown argument: ${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('-')) {
      throw new Error(`Missing value for ${argument}.`)
    }
    index += 1
    const property = argument === '--commit' ? 'commit' : 'outputDirectory'
    if (result[property]) throw new Error(`${argument} may only be provided once.`)
    result[property] = value
  }
  const selectedSpecialModes = [
    result.privateTestRelease,
    result.teamPrivateAcceptance,
    result.aHttpsTestEdge,
    result.aHttpsOidcTest,
    result.crossTeamR0Contract
  ].filter(Boolean).length
  if (selectedSpecialModes > 1) {
    throw new Error('Feature release modes are mutually exclusive.')
  }
  return result
}

export function assertFullCommit(commit) {
  if (!/^[0-9a-f]{40}$/iu.test(commit)) {
    throw new Error('The release commit must be a complete 40-character Git SHA.')
  }
  return commit.toLowerCase()
}

async function readRepositoryHead(repositoryRoot, runCommand) {
  const headResult = await runCommand({
    command: gitCommand,
    args: ['rev-parse', '--verify', 'HEAD^{commit}'],
    cwd: repositoryRoot
  })
  return assertFullCommit(headResult.stdout.trim())
}

function repositoryRelativePath(repositoryRoot, path) {
  const relativePath = relative(repositoryRoot, path)
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined
  }
  return relativePath.split(sep).join('/')
}

async function assertCleanWorktree(repositoryRoot, runCommand, ignoredPaths = []) {
  const statusArguments = ['status', '--porcelain=v1', '--untracked-files=all']
  const ignoredRepositoryPaths = ignoredPaths
    .map((path) => repositoryRelativePath(repositoryRoot, path))
    .filter((path) => path !== undefined)
  if (ignoredRepositoryPaths.length > 0) {
    statusArguments.push(
      '--',
      '.',
      ...ignoredRepositoryPaths.map((path) => `:(top,literal,exclude)${path}`)
    )
  }
  const statusResult = await runCommand({
    command: gitCommand,
    args: statusArguments,
    cwd: repositoryRoot
  })
  if (statusResult.stdout.trim().length > 0) {
    throw new Error('The collaboration release must be built from a clean worktree.')
  }
}

export function createImmutableSnapshotChildArguments(arguments_, approvedCommit, outputDirectory) {
  const childArguments = ['--commit', approvedCommit, '--output', outputDirectory]
  if (arguments_.privateTestRelease) childArguments.push('--private-test-release')
  if (arguments_.teamPrivateAcceptance) childArguments.push('--team-private-acceptance')
  if (arguments_.aHttpsTestEdge) childArguments.push('--a-https-test-edge')
  if (arguments_.aHttpsOidcTest) childArguments.push('--a-https-oidc-test')
  if (arguments_.crossTeamR0Contract) childArguments.push('--cross-team-r0-contract')
  return Object.freeze(childArguments)
}

function equalGuardTokens(left, right) {
  if (
    typeof left !== 'string' ||
    typeof right !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(left) ||
    !/^[0-9a-f]{64}$/u.test(right)
  ) {
    return false
  }
  return timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'))
}

export function validateImmutableSnapshotGuard({
  argv,
  environment,
  guard,
  repositoryRoot
}) {
  const guardPath = environment?.[IMMUTABLE_SNAPSHOT_GUARD_ENVIRONMENT.path]
  const guardToken = environment?.[IMMUTABLE_SNAPSHOT_GUARD_ENVIRONMENT.token]
  if (typeof guardPath !== 'string' || !isAbsolute(guardPath) || resolve(guardPath) !== guardPath) {
    throw new Error('The immutable snapshot guard path is missing or invalid.')
  }
  if (!guard || typeof guard !== 'object' || Array.isArray(guard)) {
    throw new Error('The immutable snapshot guard is invalid.')
  }
  const expectedFields = [
    'approvedCommit',
    'childArguments',
    'gitCommonDirectory',
    'originalRepositoryRoot',
    'outputDirectory',
    'schemaVersion',
    'snapshotRepositoryRoot',
    'token'
  ]
  if (JSON.stringify(Object.keys(guard).sort()) !== JSON.stringify(expectedFields)) {
    throw new Error('The immutable snapshot guard has an unexpected field set.')
  }
  if (guard.schemaVersion !== 1 || !equalGuardTokens(guardToken, guard.token)) {
    throw new Error('The immutable snapshot guard token is invalid.')
  }
  const snapshotRepositoryRoot = resolve(repositoryRoot)
  for (const [label, path] of [
    ['snapshot repository', guard.snapshotRepositoryRoot],
    ['original repository', guard.originalRepositoryRoot],
    ['Git common directory', guard.gitCommonDirectory],
    ['bundle output', guard.outputDirectory]
  ]) {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
      throw new Error(`The immutable snapshot ${label} path is invalid.`)
    }
  }
  if (
    guard.snapshotRepositoryRoot !== snapshotRepositoryRoot &&
    !pathsReferToSameFile(guard.snapshotRepositoryRoot, snapshotRepositoryRoot)
  ) {
    throw new Error('The immutable snapshot guard belongs to another worktree.')
  }
  if (
    guard.originalRepositoryRoot === snapshotRepositoryRoot ||
    pathsReferToSameFile(guard.originalRepositoryRoot, snapshotRepositoryRoot)
  ) {
    throw new Error('The immutable snapshot must not be the original worktree.')
  }
  if (
    guard.outputDirectory === snapshotRepositoryRoot ||
    repositoryRelativePath(snapshotRepositoryRoot, guard.outputDirectory) !== undefined
  ) {
    throw new Error('The immutable snapshot output must remain outside the snapshot worktree.')
  }
  if (!Array.isArray(argv) || !Array.isArray(guard.childArguments) ||
      JSON.stringify(argv) !== JSON.stringify(guard.childArguments)) {
    throw new Error('The immutable snapshot arguments do not match the guarded invocation.')
  }
  const arguments_ = parseArguments(argv)
  const approvedCommit = assertFullCommit(guard.approvedCommit)
  if (
    arguments_.help ||
    arguments_.commit !== approvedCommit ||
    arguments_.outputDirectory !== guard.outputDirectory ||
    resolve(guard.originalRepositoryRoot, arguments_.outputDirectory) !== guard.outputDirectory
  ) {
    throw new Error('The immutable snapshot invocation does not match its guarded release.')
  }
  return Object.freeze({
    approvedCommit,
    arguments_,
    gitCommonDirectory: guard.gitCommonDirectory,
    guardPath,
    originalRepositoryRoot: guard.originalRepositoryRoot,
    outputDirectory: guard.outputDirectory,
    snapshotRepositoryRoot
  })
}

async function readImmutableSnapshotGuard({ argv, environment, repositoryRoot, runCommand }) {
  const snapshotRepositoryRoot = resolve(repositoryRoot)
  const guardPathValue = environment?.[IMMUTABLE_SNAPSHOT_GUARD_ENVIRONMENT.path]
  if (typeof guardPathValue !== 'string' || !isAbsolute(guardPathValue)) {
    throw new Error('The immutable snapshot guard path is missing or invalid.')
  }
  const guardPath = resolve(guardPathValue)
  const expectedGuardPath = join(dirname(snapshotRepositoryRoot), immutableSnapshotGuardFilename)
  if (guardPath !== expectedGuardPath && !pathsReferToSameFile(guardPath, expectedGuardPath)) {
    throw new Error('The immutable snapshot guard is not adjacent to its worktree.')
  }
  const [guardDetails, gitMarkerDetails, parentDetails] = await Promise.all([
    lstat(guardPath),
    lstat(join(snapshotRepositoryRoot, '.git')),
    lstat(dirname(snapshotRepositoryRoot))
  ])
  if (
    !guardDetails.isFile() ||
    guardDetails.isSymbolicLink() ||
    (guardDetails.mode & 0o7777) !== 0o600
  ) {
    throw new Error('The immutable snapshot guard file is unsafe.')
  }
  if (!gitMarkerDetails.isFile() || gitMarkerDetails.isSymbolicLink()) {
    throw new Error('The immutable snapshot must be a detached linked Git worktree.')
  }
  if (
    !parentDetails.isDirectory() ||
    parentDetails.isSymbolicLink() ||
    (parentDetails.mode & 0o7777) !== 0o700
  ) {
    throw new Error('The immutable snapshot parent directory is unsafe.')
  }
  const guard = parseJson(await readFile(guardPath), 'Immutable snapshot guard')
  const context = validateImmutableSnapshotGuard({
    argv,
    environment,
    guard,
    repositoryRoot: snapshotRepositoryRoot
  })
  const [topLevelResult, commonDirectoryResult, symbolicHeadResult] = await Promise.all([
    runCommand({
      command: gitCommand,
      args: ['rev-parse', '--path-format=absolute', '--show-toplevel'],
      cwd: snapshotRepositoryRoot
    }),
    runCommand({
      command: gitCommand,
      args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      cwd: snapshotRepositoryRoot
    }),
    runCommand({
      command: gitCommand,
      args: ['rev-parse', '--symbolic-full-name', 'HEAD'],
      cwd: snapshotRepositoryRoot
    })
  ])
  const topLevelPath = topLevelResult.stdout.trim()
  const commonDirectoryPath = commonDirectoryResult.stdout.trim()
  if (
    !isAbsolute(topLevelPath) ||
    (resolve(topLevelPath) !== snapshotRepositoryRoot &&
      !pathsReferToSameFile(topLevelPath, snapshotRepositoryRoot))
  ) {
    throw new Error('The immutable snapshot guard does not match the Git worktree root.')
  }
  if (!isAbsolute(commonDirectoryPath) ||
      (resolve(commonDirectoryPath) !== context.gitCommonDirectory &&
        !pathsReferToSameFile(commonDirectoryPath, context.gitCommonDirectory))) {
    throw new Error('The immutable snapshot is not linked to the approved Git repository.')
  }
  if (symbolicHeadResult.stdout.trim() !== 'HEAD') {
    throw new Error('The immutable snapshot Git worktree is not detached.')
  }
  return context
}

function normalizePackPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\\')) {
    throw new Error('npm pack returned an invalid file path.')
  }
  const normalized = path.startsWith('package/') ? path.slice('package/'.length) : path
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`npm pack returned an unsafe file path: ${path}`)
  }
  return normalized
}

function isEnvironmentSecretPath(path) {
  const filename = basename(path).toLowerCase()
  if (filename.endsWith('.env.example')) return false
  return filename === '.env' || filename.endsWith('.env') || filename.includes('.env.')
}

function forbiddenPackPathReason(path) {
  const lower = path.toLowerCase()
  const segments = lower.split('/')
  const filename = segments.at(-1)

  if (isEnvironmentSecretPath(path)) return 'environment file'
  if (filename === '.npmrc' || filename === '.yarnrc' || filename === '.pypirc') {
    return 'package-manager credential file'
  }
  if (segments.some((segment) => /^(?:src|source|sources|test|tests|__tests__)$/u.test(segment))) {
    return 'source or test tree'
  }
  if (segments.some((segment) => /(?:^|[-_.])secrets?(?:$|[-_.])/u.test(segment))) {
    return 'secret path'
  }
  if (segments.some((segment) => /^(?:log|logs)$/u.test(segment)) || /\.log(?:\.|$)/u.test(filename)) {
    return 'log path'
  }
  if (/\.map$/u.test(filename) && !lower.startsWith('dist/')) return 'source map outside dist'
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/u.test(filename)) {
    return 'credential material'
  }
  if (
    /\.(?:ts|tsx|mts|cts|jsx)$/u.test(filename) &&
    !/\.d\.(?:ts|mts|cts)$/u.test(filename)
  ) {
    return 'source file'
  }
  if (/(?:^|[.-])(?:test|spec)\.[cm]?[jt]sx?$/u.test(filename)) return 'test file'
  return undefined
}

export function validatePackManifest(packageSpecification, packed) {
  if (!packed || typeof packed !== 'object') throw new Error('npm pack returned no package metadata.')
  if (packed.name !== packageSpecification.name) {
    throw new Error(`npm pack returned ${String(packed.name)} for ${packageSpecification.name}.`)
  }
  if (typeof packed.version !== 'string' || packed.version.length === 0) {
    throw new Error(`npm pack omitted the version for ${packageSpecification.name}.`)
  }
  if (!Array.isArray(packed.files) || packed.files.length === 0) {
    throw new Error(`npm pack omitted the file manifest for ${packageSpecification.name}.`)
  }
  if (
    typeof packed.filename !== 'string' ||
    packed.filename !== basename(packed.filename) ||
    !packed.filename.endsWith('.tgz')
  ) {
    throw new Error(`npm pack returned an unsafe archive name for ${packageSpecification.name}.`)
  }

  const files = packed.files.map((entry) => normalizePackPath(entry?.path))
  for (const path of files) {
    const reason = forbiddenPackPathReason(path)
    if (reason) {
      throw new Error(`${packageSpecification.name} archive contains forbidden ${reason}: ${path}`)
    }
  }

  const fileSet = new Set(files)
  for (const requiredFile of packageSpecification.requiredFiles) {
    if (!fileSet.has(requiredFile)) {
      throw new Error(`${packageSpecification.name} archive is missing ${requiredFile}.`)
    }
  }
  for (const requiredPrefix of packageSpecification.requiredPrefixes) {
    if (!files.some((path) => path.startsWith(requiredPrefix))) {
      throw new Error(`${packageSpecification.name} archive is missing ${requiredPrefix}.`)
    }
  }

  return Object.freeze({
    filename: packed.filename,
    files: Object.freeze(files),
    name: packed.name,
    version: packed.version
  })
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function hashAcceptanceHarness(repositoryRoot, relativePath, label) {
  const absolutePath = join(repositoryRoot, relativePath)
  let before
  try {
    before = await lstat(absolutePath, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `A HTTPS OIDC ${label} acceptance harness is missing: ${relativePath}`,
        { cause: error }
      )
    }
    throw error
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o022n) !== 0n ||
    before.size <= 0n ||
    before.size > 1024n * 1024n
  ) {
    throw new Error(
      `A HTTPS OIDC ${label} acceptance harness is unsafe: ${relativePath}`
    )
  }

  const digest = await sha256File(absolutePath)
  let after
  try {
    after = await lstat(absolutePath, { bigint: true })
  } catch (error) {
    throw new Error(`A HTTPS OIDC ${label} acceptance harness changed while it was hashed.`, {
      cause: error
    })
  }
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(`A HTTPS OIDC ${label} acceptance harness changed while it was hashed.`)
  }
  return digest
}

function sha256Content(content) {
  return createHash('sha256').update(content).digest('hex')
}

function parseJson(content, label) {
  try {
    return JSON.parse(Buffer.isBuffer(content) ? content.toString('utf8') : content)
  } catch {
    throw new Error(`${label} is not valid JSON.`)
  }
}

function collectContractCommits(value, commits = []) {
  if (Array.isArray(value)) {
    for (const nested of value) collectContractCommits(nested, commits)
    return commits
  }
  if (value === null || typeof value !== 'object') return commits
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'contractCommit') commits.push(nested)
    collectContractCommits(nested, commits)
  }
  return commits
}

export function validateContractArtifactFiles(files, expectedCommitInput) {
  const expectedCommit = assertFullCommit(expectedCommitInput)
  if (!(files instanceof Map)) {
    throw new Error('Generated collaboration contract artifacts must be a Map.')
  }

  const normalizedFiles = new Map()
  for (const [relativePath, content] of files) {
    const normalizedPath = normalizePackPath(relativePath)
    if (normalizedPath !== relativePath || !normalizedPath.endsWith('.json')) {
      throw new Error(`Contract artifact has an invalid path: ${String(relativePath)}`)
    }
    if (normalizedFiles.has(normalizedPath)) {
      throw new Error(`Contract artifact path is duplicated: ${normalizedPath}`)
    }
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
      throw new Error(`Contract artifact is not text: ${normalizedPath}`)
    }
    normalizedFiles.set(normalizedPath, Buffer.from(content))
  }

  const manifestContent = normalizedFiles.get(contractArtifactManifestFilename)
  if (!manifestContent) {
    throw new Error(`Contract artifacts are missing ${contractArtifactManifestFilename}.`)
  }
  const manifest = parseJson(manifestContent, contractArtifactManifestFilename)
  if (manifest?.contractCommit !== expectedCommit) {
    throw new Error('Contract artifact manifest commit does not match the release commit.')
  }
  if (manifest?.databaseSchemaVersion !== collaborationDatabaseSchemaVersion) {
    throw new Error(
      `Contract artifact database schema version must be ${collaborationDatabaseSchemaVersion}.`
    )
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Contract artifact manifest has no file inventory.')
  }

  const describedPaths = new Set()
  for (const entry of manifest.files) {
    const relativePath = normalizePackPath(entry?.path)
    if (relativePath !== entry.path || relativePath === contractArtifactManifestFilename) {
      throw new Error(`Contract artifact manifest has an invalid file path: ${String(entry?.path)}`)
    }
    if (describedPaths.has(relativePath)) {
      throw new Error(`Contract artifact manifest duplicates ${relativePath}.`)
    }
    describedPaths.add(relativePath)
    const content = normalizedFiles.get(relativePath)
    if (!content) throw new Error(`Contract artifact manifest references missing ${relativePath}.`)
    if (!/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      throw new Error(`Contract artifact manifest has an invalid SHA-256 for ${relativePath}.`)
    }
    if (entry.sha256 !== sha256Content(content)) {
      throw new Error(`Contract artifact SHA-256 mismatch for ${relativePath}.`)
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes !== content.byteLength) {
      throw new Error(`Contract artifact byte count mismatch for ${relativePath}.`)
    }
  }

  const actualPaths = [...normalizedFiles.keys()]
    .filter((relativePath) => relativePath !== contractArtifactManifestFilename)
    .sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify([...describedPaths].sort())) {
    throw new Error('Contract artifact package contains an unlisted file.')
  }

  for (const [relativePath, content] of normalizedFiles) {
    const document = parseJson(content, relativePath)
    const commits = collectContractCommits(document)
    if (commits.length === 0 || commits.some((commit) => commit !== expectedCommit)) {
      throw new Error(`Contract artifact commit provenance mismatch for ${relativePath}.`)
    }
    if (
      relativePath !== contractArtifactManifestFilename &&
      content.includes(Buffer.from(contractCommitPlaceholder))
    ) {
      throw new Error(`Contract artifact still contains the source commit placeholder: ${relativePath}`)
    }
  }

  return Object.freeze({ manifest, files: normalizedFiles })
}

function normalizePortalAssetPath(path) {
  const normalized = normalizePackPath(path)
  if (
    normalized !== path ||
    normalized.length > 256 ||
    normalized.startsWith('.vite/') ||
    normalized === 'ASSET_INTEGRITY.json' ||
    normalized.endsWith('.map') ||
    (normalized !== 'index.html' && !/^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(normalized))
  ) {
    throw new Error(`Portal integrity manifest has an invalid asset path: ${String(path)}`)
  }
  return normalized
}

function collectViteRuntimePaths(value, paths = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectViteRuntimePaths(item, paths)
    return paths
  }
  if (value === null || typeof value !== 'object') return paths
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'file' && typeof nested === 'string') paths.add(normalizePortalAssetPath(nested))
    if ((key === 'css' || key === 'assets') && Array.isArray(nested)) {
      for (const path of nested) paths.add(normalizePortalAssetPath(path))
    }
    if (key !== 'file' && key !== 'css' && key !== 'assets') {
      collectViteRuntimePaths(nested, paths)
    }
  }
  return paths
}

export function validatePortalAssetFiles(files) {
  if (!(files instanceof Map)) {
    throw new Error('Packed collaboration portal files must be a Map.')
  }
  const viteManifestContent = files.get(portalViteManifestPath)
  const integrityManifestContent = files.get(portalIntegrityManifestPath)
  if (!viteManifestContent || !integrityManifestContent) {
    throw new Error('Portal archive is missing its Vite or integrity manifest.')
  }

  const viteManifest = parseJson(viteManifestContent, portalViteManifestPath)
  if (
    !viteManifest ||
    typeof viteManifest !== 'object' ||
    Array.isArray(viteManifest) ||
    Object.keys(viteManifest).length === 0 ||
    !Object.values(viteManifest).some((entry) => entry?.isEntry === true)
  ) {
    throw new Error('Portal Vite manifest has no entry asset.')
  }
  const integrityManifest = parseJson(integrityManifestContent, portalIntegrityManifestPath)
  if (
    !integrityManifest ||
    typeof integrityManifest !== 'object' ||
    Array.isArray(integrityManifest) ||
    JSON.stringify(Object.keys(integrityManifest).sort()) !==
      JSON.stringify(['basePath', 'files', 'schemaVersion']) ||
    integrityManifest.schemaVersion !== 1 ||
    integrityManifest.basePath !== portalBasePath ||
    !Array.isArray(integrityManifest.files) ||
    integrityManifest.files.length < 2 ||
    integrityManifest.files.length > 256
  ) {
    throw new Error('Portal integrity manifest has an invalid schema or base path.')
  }

  const describedPaths = new Set()
  const portalAssets = []
  let previousPath = ''
  let totalAssetBytes = 0
  for (const entry of integrityManifest.files) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['bytes', 'path', 'sha256'])
    ) {
      throw new Error('Portal integrity manifest has an invalid file entry.')
    }
    const relativePath = normalizePortalAssetPath(entry.path)
    if (relativePath <= previousPath) {
      throw new Error('Portal integrity manifest files must be strictly sorted and unique.')
    }
    previousPath = relativePath
    describedPaths.add(relativePath)
    const content = files.get(`dist/${relativePath}`)
    if (!content) throw new Error(`Portal integrity manifest references missing ${relativePath}.`)
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 ||
        entry.bytes > 4 * 1024 * 1024 || entry.bytes !== content.byteLength) {
      throw new Error(`Portal asset byte count mismatch for ${relativePath}.`)
    }
    totalAssetBytes += entry.bytes
    if (totalAssetBytes > 12 * 1024 * 1024) {
      throw new Error('Portal assets exceed the bounded release size.')
    }
    if (!/^[0-9a-f]{64}$/u.test(entry.sha256) || entry.sha256 !== sha256Content(content)) {
      throw new Error(`Portal asset SHA-256 mismatch for ${relativePath}.`)
    }
    if (
      content.includes(Buffer.from('SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET')) ||
      content.includes(Buffer.from('replace_with_portal_client_secret'))
    ) {
      throw new Error(`Portal browser asset contains a forbidden secret marker: ${relativePath}`)
    }
    portalAssets.push(Object.freeze({
      path: relativePath,
      bytes: entry.bytes,
      sha256: entry.sha256
    }))
  }
  if (!describedPaths.has('index.html')) {
    throw new Error('Portal integrity manifest must describe index.html.')
  }

  const viteRuntimePaths = collectViteRuntimePaths(viteManifest)
  for (const relativePath of viteRuntimePaths) {
    if (!describedPaths.has(relativePath)) {
      throw new Error(`Portal Vite manifest references an unlisted asset: ${relativePath}`)
    }
  }

  const actualArchivePaths = [...files.keys()].sort()
  const expectedArchivePaths = [
    'package.json',
    portalViteManifestPath,
    portalIntegrityManifestPath,
    ...portalAssets.map(({ path }) => `dist/${path}`)
  ].sort()
  if (JSON.stringify(actualArchivePaths) !== JSON.stringify(expectedArchivePaths)) {
    throw new Error('Portal archive contains an unlisted or unexpected file.')
  }

  return Object.freeze({
    assets: Object.freeze(portalAssets),
    basePath: portalBasePath,
    integrityManifestPath: portalIntegrityManifestPath,
    integrityManifestSha256: sha256Content(integrityManifestContent),
    viteManifestPath: portalViteManifestPath,
    viteManifestSha256: sha256Content(viteManifestContent)
  })
}

function readTarString(header, offset, length) {
  const field = header.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8')
}

function readTarOctal(header, offset, length, label) {
  const field = readTarString(header, offset, length).trim()
  if (!/^[0-7]+$/u.test(field)) throw new Error(`Packed archive has an invalid ${label}.`)
  const value = Number.parseInt(field, 8)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Packed archive has an unsafe ${label}.`)
  }
  return value
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0)
}

function verifyTarHeaderChecksum(header) {
  const expected = readTarOctal(header, 148, 8, 'header checksum')
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index]
  }
  if (actual !== expected) throw new Error('Packed archive has an invalid header checksum.')
}

export async function readNpmPackageArchiveFiles(path) {
  let archive
  try {
    archive = gunzipSync(await readFile(path), { maxOutputLength: maximumUnpackedArchiveBytes })
  } catch (error) {
    throw new Error('Unable to safely decompress the packed npm archive.', { cause: error })
  }
  if (archive.length === 0 || archive.length % tarBlockBytes !== 0) {
    throw new Error('Packed npm archive is not a complete tar stream.')
  }

  const files = new Map()
  let offset = 0
  let terminated = false
  while (offset < archive.length) {
    const header = archive.subarray(offset, offset + tarBlockBytes)
    if (isZeroBlock(header)) {
      const secondEndBlock = archive.subarray(offset + tarBlockBytes, offset + (2 * tarBlockBytes))
      if (secondEndBlock.length !== tarBlockBytes || !isZeroBlock(secondEndBlock)) {
        throw new Error('Packed npm archive has an incomplete end marker.')
      }
      if (!isZeroBlock(archive.subarray(offset))) {
        throw new Error('Packed npm archive contains data after its end marker.')
      }
      terminated = true
      break
    }

    verifyTarHeaderChecksum(header)
    if (!readTarString(header, 257, 6).startsWith('ustar')) {
      throw new Error('Packed npm archive is not in the supported USTAR format.')
    }
    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const archivePath = prefix ? `${prefix}/${name}` : name
    if (!archivePath.startsWith('package/')) {
      throw new Error(`Packed npm archive has an invalid root path: ${archivePath}`)
    }
    const normalizedPath = normalizePackPath(archivePath)
    const size = readTarOctal(header, 124, 12, 'entry size')
    const type = header[156]
    if (type !== 0 && type !== 48) {
      throw new Error(`Packed npm archive contains a non-regular entry: ${normalizedPath}`)
    }
    const contentStart = offset + tarBlockBytes
    const contentEnd = contentStart + size
    if (contentEnd > archive.length) {
      throw new Error(`Packed npm archive truncates ${normalizedPath}.`)
    }
    if (files.has(normalizedPath)) {
      throw new Error(`Packed npm archive duplicates ${normalizedPath}.`)
    }
    files.set(normalizedPath, Buffer.from(archive.subarray(contentStart, contentEnd)))
    offset = contentStart + Math.ceil(size / tarBlockBytes) * tarBlockBytes
  }
  if (!terminated) throw new Error('Packed npm archive has no end marker.')
  return files
}

async function verifyPackedPackageArchive(archivePath, packed, specification, expectedCommit) {
  const files = await readNpmPackageArchiveFiles(archivePath)
  const actualPaths = [...files.keys()].sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify([...packed.files].sort())) {
    throw new Error(`${specification.name} archive does not match the npm pack file manifest.`)
  }

  const packageJsonContent = files.get('package.json')
  if (!packageJsonContent) throw new Error(`${specification.name} archive is missing package.json.`)
  const packageJson = parseJson(packageJsonContent, `${specification.name} package.json`)
  if (packageJson.name !== packed.name || packageJson.version !== packed.version) {
    throw new Error(`${specification.name} archive package identity does not match npm pack metadata.`)
  }

  if (specification.name === collaborationContractsPackageName) {
    const artifactFiles = new Map([...files]
      .filter(([relativePath]) => relativePath.startsWith(contractArtifactPrefix))
      .map(([relativePath, content]) => [relativePath.slice(contractArtifactPrefix.length), content]))
    validateContractArtifactFiles(artifactFiles, expectedCommit)
  }
  if (specification.name === collaborationPortalPackageName) {
    return validatePortalAssetFiles(files)
  }
  return undefined
}

async function defaultGenerateContractArtifactFiles(commit) {
  const { tsImport } = await import('tsx/esm/api')
  const artifacts = await tsImport('./collaboration-contract-artifacts.mjs', import.meta.url)
  return artifacts.generateContractArtifactFiles(commit)
}

async function stageCollaborationContractsPackage({
  commit,
  generateContractArtifactFiles,
  repositoryRoot,
  stagingDirectory
}) {
  const sourceDirectory = join(repositoryRoot, 'packages/collaboration-contracts')
  const packageDirectory = join(stagingDirectory, '.collaboration-contracts-package')
  await mkdir(packageDirectory)
  await copyFile(join(sourceDirectory, 'package.json'), join(packageDirectory, 'package.json'))
  await cp(join(sourceDirectory, 'dist'), join(packageDirectory, 'dist'), { recursive: true })

  const generatedFiles = await generateContractArtifactFiles(commit)
  const validated = validateContractArtifactFiles(generatedFiles, commit)
  const artifactDirectory = join(packageDirectory, contractArtifactPrefix)
  for (const [relativePath, content] of validated.files) {
    const destination = join(artifactDirectory, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content, { mode: 0o644 })
  }
  return packageDirectory
}

async function stageDomainSdkPackage({ repositoryRoot, stagingDirectory }) {
  const sourceDirectory = join(repositoryRoot, 'packages/domain-sdk')
  const sourcePackageJson = parseJson(
    await readFile(join(sourceDirectory, 'package.json')),
    `${domainSdkPackageName} package.json`
  )
  const packageDirectory = join(stagingDirectory, '.domain-sdk-package')
  await mkdir(packageDirectory)
  await cp(join(sourceDirectory, 'dist'), join(packageDirectory, 'dist'), { recursive: true })
  await copyFile(
    join(sourceDirectory, 'portable-resource-provenance.json'),
    join(packageDirectory, 'portable-resource-provenance.json')
  )
  await writeJson(join(packageDirectory, 'package.json'), {
    name: sourcePackageJson.name,
    version: sourcePackageJson.version,
    license: sourcePackageJson.license,
    type: 'module',
    description: sourcePackageJson.description,
    exports: {
      './portable-resource-references': {
        types: './dist/portable-resource-references.d.ts',
        import: './dist/portable-resource-references.js'
      },
      './principal': {
        types: './dist/principal.d.ts',
        import: './dist/principal.js'
      }
    },
    files: ['dist', 'portable-resource-provenance.json', 'package.json'],
    dependencies: { zod: sourcePackageJson.dependencies.zod }
  })
  return packageDirectory
}

async function defaultRunCommand({ command, args, cwd, environment, inheritOutput = false }) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...environment,
        NPM_CONFIG_CACHE: environment?.NPM_CONFIG_CACHE ||
          process.env.NPM_CONFIG_CACHE || join(tmpdir(), 'sciforge-a-npm-cache')
      },
      shell: false,
      stdio: inheritOutput ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe']
    })
    const stdout = []
    const stderr = []
    let capturedBytes = 0
    const maximumCapturedBytes = 16 * 1024 * 1024
    const capture = (target) => (chunk) => {
      capturedBytes += chunk.length
      if (capturedBytes > maximumCapturedBytes) {
        child.kill('SIGKILL')
        return
      }
      target.push(chunk)
    }
    child.stdout?.on('data', capture(stdout))
    child.stderr?.on('data', capture(stderr))
    child.once('error', (error) => rejectPromise(new Error(`Unable to run ${command}: ${error.message}`)))
    child.once('close', (code, signal) => {
      if (capturedBytes > maximumCapturedBytes) {
        rejectPromise(new Error(`${command} produced more than 16 MiB of output.`))
        return
      }
      if (code !== 0) {
        const termination = signal ? `signal ${signal}` : `exit code ${String(code)}`
        rejectPromise(new Error(`${command} ${args[0] ?? ''} failed with ${termination}.`))
        return
      }
      resolvePromise({
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8')
      })
    })
  })
}

async function outputDirectoryState(path) {
  try {
    const details = await lstat(path)
    if (!details.isDirectory()) throw new Error(`Bundle output is not a directory: ${path}`)
    if ((await readdir(path)).length > 0) {
      throw new Error(`Refusing to overwrite non-empty bundle output: ${path}`)
    }
    return 'empty'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function readWorkspacePackages(repositoryRoot) {
  const packages = []
  for (const specification of COLLABORATION_RELEASE_PACKAGES) {
    const packageJson = JSON.parse(await readFile(
      join(repositoryRoot, specification.directory, 'package.json'),
      'utf8'
    ))
    if (packageJson.name !== specification.name) {
      throw new Error(`${specification.directory} does not contain ${specification.name}.`)
    }
    if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
      throw new Error(`${specification.name} does not declare a version.`)
    }
    packages.push({ packageJson, specification })
  }
  return packages
}

function parsePackOutput(stdout, packageName) {
  let parsed
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new Error(`npm pack returned invalid JSON for ${packageName}.`)
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`npm pack did not produce exactly one archive for ${packageName}.`)
  }
  return parsed[0]
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
}

async function assertGeneratedLock(stagingDirectory, dependencies) {
  const lock = JSON.parse(await readFile(join(stagingDirectory, 'package-lock.json'), 'utf8'))
  if (lock?.packages?.['']?.dependencies === undefined) {
    throw new Error('npm did not generate a root dependency lock.')
  }
  for (const [name, expected] of Object.entries(dependencies)) {
    if (lock.packages[''].dependencies[name] !== expected) {
      throw new Error(`package-lock.json did not pin ${name} to its release archive.`)
    }
  }
  return lock
}

async function assertBundleFileSet(stagingDirectory, expectedFilenames) {
  const entries = await readdir(stagingDirectory, { withFileTypes: true })
  const actualFilenames = entries.map((entry) => entry.name).sort()
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('Release bundle may only contain immutable files.')
  }
  const expected = [...expectedFilenames].sort()
  if (JSON.stringify(actualFilenames) !== JSON.stringify(expected)) {
    throw new Error('Release bundle contains an unexpected file.')
  }
}

export async function buildCollaborationServerBundle({
  aHttpsOidcTest = false,
  aHttpsTestEdge = false,
  commit,
  generateContractArtifactFiles = defaultGenerateContractArtifactFiles,
  log = () => {},
  outputDirectory,
  privateTestRelease = false,
  teamPrivateAcceptance = false,
  crossTeamR0Contract = false,
  repositoryRoot = defaultRepositoryRoot,
  runCommand = defaultRunCommand
} = {}) {
  if (typeof aHttpsOidcTest !== 'boolean') {
    throw new Error('aHttpsOidcTest must be an explicit boolean.')
  }
  if (typeof aHttpsTestEdge !== 'boolean') {
    throw new Error('aHttpsTestEdge must be an explicit boolean.')
  }
  if (typeof privateTestRelease !== 'boolean') {
    throw new Error('privateTestRelease must be an explicit boolean.')
  }
  if (typeof teamPrivateAcceptance !== 'boolean') {
    throw new Error('teamPrivateAcceptance must be an explicit boolean.')
  }
  if (typeof crossTeamR0Contract !== 'boolean') {
    throw new Error('crossTeamR0Contract must be an explicit boolean.')
  }
  const selectedSpecialModes = [
    privateTestRelease,
    teamPrivateAcceptance,
    aHttpsTestEdge,
    aHttpsOidcTest,
    crossTeamR0Contract
  ].filter(Boolean).length
  if (selectedSpecialModes > 1) {
    throw new Error('Feature release modes are mutually exclusive.')
  }
  if (typeof generateContractArtifactFiles !== 'function') {
    throw new Error('generateContractArtifactFiles must be a function.')
  }
  const featureRelease = privateTestRelease || teamPrivateAcceptance || aHttpsTestEdge ||
    aHttpsOidcTest || crossTeamR0Contract
  const root = resolve(repositoryRoot)
  const head = await readRepositoryHead(root, runCommand)
  const approvedCommit = assertFullCommit(commit ?? head)
  if (approvedCommit !== head) {
    throw new Error('The approved release commit must equal the currently checked out HEAD.')
  }
  await assertCleanWorktree(root, runCommand)
  let baseCommit
  if (featureRelease) {
    const baseResult = await runCommand({
      command: gitCommand,
      args: ['rev-parse', '--verify', 'origin/gui^{commit}'],
      cwd: root
    })
    baseCommit = assertFullCommit(baseResult.stdout.trim())
    try {
      await runCommand({
        command: gitCommand,
        args: ['merge-base', '--is-ancestor', baseCommit, approvedCommit],
        cwd: root
      })
    } catch (error) {
      throw new Error(
        `${aHttpsTestEdge || aHttpsOidcTest
          ? 'A HTTPS test release'
          : crossTeamR0Contract
          ? 'Cross-team R0 contract release'
          : teamPrivateAcceptance
            ? 'Team private acceptance'
            : 'Private test release'} HEAD must descend from the current origin/gui commit.`,
        { cause: error }
      )
    }
  } else {
    await runCommand({
      command: gitCommand,
      args: ['merge-base', '--is-ancestor', approvedCommit, 'origin/gui'],
      cwd: root
    })
  }

  const destination = resolve(
    root,
    outputDirectory ?? join('dist', `collaboration-server-bundle-${approvedCommit.slice(0, 12)}`)
  )
  const destinationState = await outputDirectoryState(destination)
  const destinationParent = dirname(destination)
  await mkdir(destinationParent, { recursive: true })
  const stagingDirectory = await mkdtemp(join(destinationParent, '.collaboration-bundle-tmp-'))
  let published = false

  try {
    if (aHttpsOidcTest) {
      log('*** A-ONLY HTTPS OIDC TEST: cloud-test API plus login-test issuer ingress; Provider and binding confirm stay disabled. ***')
      log(`Verified clean A HTTPS OIDC test commit ${approvedCommit} descends from origin/gui ${baseCommit}.`)
    } else if (aHttpsTestEdge) {
      log('*** A-ONLY HTTPS TEST EDGE: cloud-test.sciforge.cn core-only boundary; not a product login or Provider deployment. ***')
      log(`Verified clean A HTTPS edge commit ${approvedCommit} descends from origin/gui ${baseCommit}.`)
    } else if (crossTeamR0Contract) {
      log('*** CROSS-TEAM R0 CONTRACT: public machine contract; not a production deployment approval. ***')
      log(`Verified clean R0 contract commit ${approvedCommit} descends from origin/gui ${baseCommit}.`)
    } else if (teamPrivateAcceptance) {
      log('*** TEAM-PRIVATE ACCEPTANCE: loopback + SSH tunnel only; never publish as production. ***')
      log(`Verified clean team acceptance commit ${approvedCommit} descends from origin/gui ${baseCommit}.`)
    } else if (privateTestRelease) {
      log('*** TEST-ONLY PRIVATE RELEASE: loopback-only A ECS; never publish as production. ***')
      log(`Verified clean feature commit ${approvedCommit} descends from origin/gui ${baseCommit}.`)
    } else {
      log(`Verified origin/gui release commit ${approvedCommit}.`)
    }
    const workspacePackages = await readWorkspacePackages(root)
    const packedPackages = []
    let portalAssetProfile

    log('Checking collaboration provider composition.')
    await runCommand({
      command: process.execPath,
      args: ['scripts/collaboration-providers.mjs', '--check'],
      cwd: root
    })

    for (const { specification } of workspacePackages) {
      log(`Building ${specification.name}.`)
      await rm(join(root, specification.directory, 'dist'), { recursive: true, force: true })
      await runCommand({
        command: npmCommand,
        args: specification.packageFromDirectory
          ? ['--prefix', specification.directory, 'run', specification.buildScript ?? 'build']
          : ['--workspace', specification.name, 'run', specification.buildScript ?? 'build'],
        cwd: root
      })
    }

    log(`Generating ${collaborationContractsPackageName} artifacts for ${approvedCommit}.`)
    const contractsPackageDirectory = await stageCollaborationContractsPackage({
      commit: approvedCommit,
      generateContractArtifactFiles,
      repositoryRoot: root,
      stagingDirectory
    })
    const domainSdkPackageDirectory = await stageDomainSdkPackage({
      repositoryRoot: root,
      stagingDirectory
    })

    for (const { packageJson, specification } of workspacePackages) {
      log(`Packing ${specification.name}.`)
      const packageTarget = specification.name === collaborationContractsPackageName
        ? [contractsPackageDirectory]
        : specification.name === domainSdkPackageName
          ? [domainSdkPackageDirectory]
          : specification.packageFromDirectory
            ? [join(root, specification.directory)]
          : ['--workspace', specification.name]
      const packResult = await runCommand({
        command: npmCommand,
        args: [
          'pack',
          ...packageTarget,
          '--json',
          '--ignore-scripts',
          '--pack-destination', stagingDirectory
        ],
        cwd: root
      })
      const packed = validatePackManifest(
        specification,
        parsePackOutput(packResult.stdout, specification.name)
      )
      if (packed.version !== packageJson.version) {
        throw new Error(`${specification.name} packed version does not match its package.json.`)
      }
      if (packedPackages.some((candidate) => candidate.filename === packed.filename)) {
        throw new Error(`npm pack produced duplicate archive name ${packed.filename}.`)
      }
      const archiveDetails = await lstat(join(stagingDirectory, packed.filename))
      if (!archiveDetails.isFile()) {
        throw new Error(`npm pack did not create a regular archive for ${specification.name}.`)
      }
      const archiveVerification = await verifyPackedPackageArchive(
        join(stagingDirectory, packed.filename),
        packed,
        specification,
        approvedCommit
      )
      if (specification.name === collaborationPortalPackageName) {
        portalAssetProfile = archiveVerification
      }
      packedPackages.push(packed)
    }
    await rm(contractsPackageDirectory, { recursive: true, force: true })
    await rm(domainSdkPackageDirectory, { recursive: true, force: true })

    const dependencies = Object.fromEntries(packedPackages.map((packed) => [
      packed.name,
      `file:./${packed.filename}`
    ]))
    const serverPackage = workspacePackages.find(({ specification }) => (
      specification.name === '@sciforge/collaboration-server'
    )).packageJson
    const bundlePackageJson = {
      name: '@sciforge/collaboration-server-release',
      version: serverPackage.version,
      private: true,
      description: 'Immutable SciForge collaboration server release bundle.',
      engines: { node: '>=22.12.0' },
      scripts: {
        migrate: 'sciforge-collaboration-server migrate',
        start: 'sciforge-collaboration-server'
      },
      dependencies
    }
    await writeJson(join(stagingDirectory, 'package.json'), bundlePackageJson)
    await runCommand({
      command: npmCommand,
      args: [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund'
      ],
      cwd: stagingDirectory
    })
    const lock = await assertGeneratedLock(stagingDirectory, dependencies)
    await writeFile(join(stagingDirectory, 'CONTRACT_COMMIT'), `${approvedCommit}\n`, {
      encoding: 'utf8',
      mode: 0o644
    })

    const releasePackages = []
    for (const packed of packedPackages) {
      releasePackages.push({
        name: packed.name,
        version: packed.version,
        filename: packed.filename,
        sha256: await sha256File(join(stagingDirectory, packed.filename))
      })
    }
    if (!portalAssetProfile) {
      throw new Error('The collaboration portal archive did not produce a verified asset profile.')
    }
    const portalReleasePackage = releasePackages.find(({ name }) => (
      name === collaborationPortalPackageName
    ))
    if (!portalReleasePackage) {
      throw new Error('The collaboration portal archive is missing from the release package set.')
    }
    const edgeProfile = {}
    const selectedEdgeAssets = aHttpsOidcTest
      ? aHttpsOidcTestAssets
      : aHttpsTestEdge
        ? aHttpsTestEdgeAssets
        : undefined
    if (selectedEdgeAssets) {
      for (const [field, { expectedMode, relativePath }] of Object.entries(selectedEdgeAssets)) {
        const absolutePath = join(root, relativePath)
        let details
        try {
          details = await lstat(absolutePath)
        } catch (error) {
          if (error?.code === 'ENOENT') {
            throw new Error(`A HTTPS test release asset is missing: ${relativePath}`, { cause: error })
          }
          throw error
        }
        if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o022) !== 0) {
          throw new Error(`A HTTPS test release asset is unsafe: ${relativePath}`)
        }
        const actualMode = details.mode & 0o7777
        if (expectedMode !== undefined && actualMode !== expectedMode) {
          throw new Error(
            `A HTTPS test release script must have mode ${expectedMode.toString(8)}: ${relativePath}`
          )
        }
        edgeProfile[field] = await sha256File(absolutePath)
      }
    }
    const identityAcceptanceHarnessSha256 = aHttpsOidcTest
      ? await hashAcceptanceHarness(
          root,
          identityAcceptanceHarnessRelativePath,
          'identity'
        )
      : undefined
    const multiWorkerAcceptanceHarnessSha256 = aHttpsOidcTest
      ? await hashAcceptanceHarness(
          root,
          multiWorkerAcceptanceHarnessRelativePath,
          'multi-worker'
        )
      : undefined
    const realFileRun0ReceiptHarnessSha256 = aHttpsOidcTest
      ? await hashAcceptanceHarness(
          root,
          realFileRun0ReceiptHarnessRelativePath,
          'real-file-run-0 receipt'
        )
      : undefined
    const manifest = {
      schemaVersion: aHttpsOidcTest ? 4 : 1,
      artifact: 'sciforge-collaboration-server-bundle',
      contractCommit: approvedCommit,
      releaseMode: teamPrivateAcceptance
        ? 'team-private-acceptance'
        : aHttpsOidcTest
          ? 'a-https-oidc-test'
          : aHttpsTestEdge
          ? 'a-https-test-edge'
          : crossTeamR0Contract
          ? 'cross-team-r0-contract'
          : privateTestRelease
            ? 'private-test'
            : 'origin-gui',
      ...(featureRelease ? { baseCommit } : {}),
      ...(teamPrivateAcceptance
        ? { deploymentBoundary: 'loopback-ssh-tunnel-only' }
        : aHttpsOidcTest
          ? {
              deploymentBoundary: 'public-https-oidc-test',
              hostname: 'cloud-test.sciforge.cn',
              identityHostname: 'login-test.sciforge.cn',
              oidcIssuer: 'https://login-test.sciforge.cn/realms/SciForge',
              oidcAudience: 'sciforge-cloud-api',
              oidcAuthorizedParties: 'sciforge-desktop,sciforge-web-mobile',
              oidcAllowInsecureLoopback: false,
              bindingConfirmMode: 'disabled',
              providerMode: 'disabled',
              identityEdgeNetwork: 'sciforge-keycloak_identity-edge',
              identityAcceptanceHarnessSha256,
              multiWorkerAcceptanceHarnessSha256,
              realFileRun0ReceiptHarnessSha256,
              portalEnabled: true,
              portalMode: 'confidential-bff',
              portalPackageArchive: portalReleasePackage.filename,
              portalPackageSha256: portalReleasePackage.sha256,
              portalBasePath,
              portalAuthPathPrefix: '/portal/auth/',
              portalApiPathPrefix: '/portal/api/',
              portalEventsPath: '/portal/events',
              portalAssetDirectory: '/app/node_modules/@sciforge/collaboration-portal/dist',
              portalViteManifestPath: portalAssetProfile.viteManifestPath,
              portalViteManifestSha256: portalAssetProfile.viteManifestSha256,
              portalIntegrityManifestPath: portalAssetProfile.integrityManifestPath,
              portalIntegrityManifestSha256: portalAssetProfile.integrityManifestSha256,
              portalAssets: portalAssetProfile.assets,
              portalPublicOrigin: 'https://cloud-test.sciforge.cn',
              portalAuthorizedParty: 'sciforge-cloud-console',
              portalOidcClientId: 'sciforge-cloud-console',
              portalOidcRedirectUri: 'https://cloud-test.sciforge.cn/portal/auth/callback',
              portalHumanNeededMode: 'display-only',
              portalTestWorkerDirectoryEnabled: true,
              portalSessionIdleSeconds: 1800,
              portalSessionAbsoluteSeconds: 28800,
              portalContentSecurityPolicy: COLLABORATION_PORTAL_CSP,
              edgeCaddyImage: aHttpsTestEdgeImage,
              ...edgeProfile
            }
          : aHttpsTestEdge
          ? {
              deploymentBoundary: 'public-https-core-only',
              hostname: 'cloud-test.sciforge.cn',
              edgeCaddyImage: aHttpsTestEdgeImage,
              ...edgeProfile
            }
          : crossTeamR0Contract
          ? { deploymentBoundary: 'contract-consumption-only' }
          : {}),
      packageManager: {
        name: 'npm',
        lockfileVersion: lock.lockfileVersion
      },
      packages: releasePackages
    }
    await writeJson(join(stagingDirectory, manifestFilename), manifest)

    const checksumFilenames = [
      ...packedPackages.map((packed) => packed.filename),
      'CONTRACT_COMMIT',
      manifestFilename,
      'package-lock.json',
      'package.json'
    ].sort()
    const checksumLines = []
    for (const filename of checksumFilenames) {
      checksumLines.push(`${await sha256File(join(stagingDirectory, filename))}  ${filename}`)
    }
    await writeFile(join(stagingDirectory, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o644
    })
    await assertBundleFileSet(stagingDirectory, [...checksumFilenames, 'SHA256SUMS'])

    const publishingHead = await readRepositoryHead(root, runCommand)
    if (publishingHead !== approvedCommit) {
      throw new Error('The collaboration release HEAD changed while the bundle was being built.')
    }
    await assertCleanWorktree(root, runCommand, [stagingDirectory])

    if (destinationState === 'empty') await rmdir(destination)
    try {
      await rename(stagingDirectory, destination)
    } catch (error) {
      if (destinationState === 'empty') await mkdir(destination).catch(() => {})
      throw error
    }
    published = true
    log(aHttpsOidcTest
      ? `Created A-ONLY HTTPS OIDC test collaboration bundle at ${destination}.`
      : aHttpsTestEdge
        ? `Created A-ONLY HTTPS test edge collaboration bundle at ${destination}.`
        : crossTeamR0Contract
          ? `Created public cross-team R0 machine-contract bundle at ${destination}.`
          : teamPrivateAcceptance
            ? `Created TEAM-PRIVATE acceptance collaboration bundle at ${destination}.`
            : privateTestRelease
              ? `Created TEST-ONLY private collaboration bundle at ${destination}.`
              : `Created immutable collaboration release bundle at ${destination}.`)
    return Object.freeze({
      commit: approvedCommit,
      manifest,
      outputDirectory: destination
    })
  } finally {
    if (!published) await rm(stagingDirectory, { recursive: true, force: true })
  }
}

export async function buildCollaborationServerBundleFromImmutableSnapshot({
  arguments_,
  createGuardToken = () => randomBytes(32).toString('hex'),
  log = () => {},
  repositoryRoot = defaultRepositoryRoot,
  runCommand = defaultRunCommand
} = {}) {
  if (!arguments_ || typeof arguments_ !== 'object' || arguments_.help) {
    throw new Error('Immutable snapshot release arguments are missing or invalid.')
  }
  const originalRepositoryRoot = resolve(repositoryRoot)
  const head = await readRepositoryHead(originalRepositoryRoot, runCommand)
  const approvedCommit = assertFullCommit(arguments_.commit ?? head)
  if (approvedCommit !== head) {
    throw new Error('The approved release commit must equal the currently checked out HEAD.')
  }
  await assertCleanWorktree(originalRepositoryRoot, runCommand)

  const commonDirectoryResult = await runCommand({
    command: gitCommand,
    args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd: originalRepositoryRoot
  })
  const gitCommonDirectoryPath = commonDirectoryResult.stdout.trim()
  if (!isAbsolute(gitCommonDirectoryPath)) {
    throw new Error('Git did not return an absolute common directory for the release repository.')
  }
  const gitCommonDirectory = resolve(gitCommonDirectoryPath)

  const outputDirectory = resolve(
    originalRepositoryRoot,
    arguments_.outputDirectory ??
      join('dist', `collaboration-server-bundle-${approvedCommit.slice(0, 12)}`)
  )
  const childArguments = createImmutableSnapshotChildArguments(
    arguments_,
    approvedCommit,
    outputDirectory
  )
  const guardToken = createGuardToken()
  if (typeof guardToken !== 'string' || !/^[0-9a-f]{64}$/u.test(guardToken)) {
    throw new Error('The immutable snapshot guard generator returned an invalid token.')
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'sciforge-collaboration-bundle-worktree-')
  )
  const snapshotRepositoryRoot = join(temporaryDirectory, 'source')
  const guardPath = join(temporaryDirectory, immutableSnapshotGuardFilename)
  let worktreeAdded = false
  try {
    const temporaryDetails = await lstat(temporaryDirectory)
    if (
      !temporaryDetails.isDirectory() ||
      temporaryDetails.isSymbolicLink() ||
      (temporaryDetails.mode & 0o7777) !== 0o700
    ) {
      throw new Error('The immutable snapshot parent directory is unsafe.')
    }

    log(`Creating detached immutable release snapshot for ${approvedCommit}.`)
    await runCommand({
      command: gitCommand,
      args: ['worktree', 'add', '--detach', snapshotRepositoryRoot, approvedCommit],
      cwd: originalRepositoryRoot
    })
    worktreeAdded = true

    const guard = {
      schemaVersion: 1,
      approvedCommit,
      childArguments: [...childArguments],
      gitCommonDirectory,
      originalRepositoryRoot,
      outputDirectory,
      snapshotRepositoryRoot,
      token: guardToken
    }
    await writeFile(guardPath, `${JSON.stringify(guard, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })

    log('Installing locked release dependencies inside the immutable snapshot.')
    await runCommand({
      command: npmCommand,
      args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      cwd: snapshotRepositoryRoot,
      inheritOutput: true
    })

    log('Building the collaboration release from the immutable snapshot.')
    await runCommand({
      command: process.execPath,
      args: [
        join(snapshotRepositoryRoot, 'scripts', basename(fileURLToPath(import.meta.url))),
        ...childArguments
      ],
      cwd: snapshotRepositoryRoot,
      environment: {
        [IMMUTABLE_SNAPSHOT_GUARD_ENVIRONMENT.path]: guardPath,
        [IMMUTABLE_SNAPSHOT_GUARD_ENVIRONMENT.token]: guardToken
      },
      inheritOutput: true
    })
    return Object.freeze({ approvedCommit, outputDirectory })
  } finally {
    try {
      if (worktreeAdded) {
        await runCommand({
          command: gitCommand,
          args: ['worktree', 'remove', '--force', snapshotRepositoryRoot],
          cwd: originalRepositoryRoot
        })
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}

function immutableSnapshotGuardWasRequested(environment) {
  return Object.values(IMMUTABLE_SNAPSHOT_GUARD_ENVIRONMENT).some((name) => (
    Object.hasOwn(environment ?? {}, name)
  ))
}

export async function runCollaborationServerBundleCli({
  argv = process.argv.slice(2),
  createGuardToken,
  environment = process.env,
  log = () => {},
  repositoryRoot = defaultRepositoryRoot,
  runCommand = defaultRunCommand
} = {}) {
  const arguments_ = parseArguments(argv)
  if (arguments_.help) return Object.freeze({ help: true })

  if (immutableSnapshotGuardWasRequested(environment)) {
    const context = await readImmutableSnapshotGuard({
      argv,
      environment,
      repositoryRoot,
      runCommand
    })
    await rm(context.guardPath)
    if (environment === process.env) {
      delete process.env[IMMUTABLE_SNAPSHOT_GUARD_ENVIRONMENT.path]
      delete process.env[IMMUTABLE_SNAPSHOT_GUARD_ENVIRONMENT.token]
    }
    return await buildCollaborationServerBundle({
      aHttpsOidcTest: context.arguments_.aHttpsOidcTest,
      aHttpsTestEdge: context.arguments_.aHttpsTestEdge,
      commit: context.approvedCommit,
      log,
      outputDirectory: context.outputDirectory,
      privateTestRelease: context.arguments_.privateTestRelease,
      crossTeamR0Contract: context.arguments_.crossTeamR0Contract,
      repositoryRoot: context.snapshotRepositoryRoot,
      runCommand,
      teamPrivateAcceptance: context.arguments_.teamPrivateAcceptance
    })
  }

  return await buildCollaborationServerBundleFromImmutableSnapshot({
    arguments_,
    createGuardToken,
    log,
    repositoryRoot,
    runCommand
  })
}

export function pathsReferToSameFile(leftPath, rightPath) {
  if (typeof leftPath !== 'string' || typeof rightPath !== 'string') return false
  try {
    return realpathSync(leftPath) === realpathSync(rightPath)
  } catch {
    return false
  }
}

const invokedAsMain = pathsReferToSameFile(process.argv[1], fileURLToPath(import.meta.url))
if (invokedAsMain) {
  try {
    const result = await runCollaborationServerBundleCli({
      log: (message) => process.stdout.write(`[collaboration-bundle] ${message}\n`)
    })
    if (result.help) {
      process.stdout.write(usage())
    }
  } catch (error) {
    process.stderr.write(`[collaboration-bundle] ${error instanceof Error ? error.message : 'Build failed.'}\n`)
    process.exitCode = 1
  }
}
