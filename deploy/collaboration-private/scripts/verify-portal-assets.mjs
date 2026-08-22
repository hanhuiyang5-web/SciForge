#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const [releaseManifestInput, assetDirectoryInput] = process.argv.slice(2)
if (!releaseManifestInput || !assetDirectoryInput) {
  throw new Error('Usage: verify-portal-assets.mjs <release-manifest> <portal-asset-directory>')
}

const releaseManifestPath = resolve(releaseManifestInput)
const assetDirectory = resolve(assetDirectoryInput)
const viteManifestRelativePath = '.vite/manifest.json'
const integrityManifestRelativePath = 'ASSET_INTEGRITY.json'
const sha256 = (content) => createHash('sha256').update(content).digest('hex')

function parseJson(content, label) {
  try {
    return JSON.parse(content.toString('utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON.`)
  }
}

function normalizeAssetPath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 256 ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    path.startsWith('.vite/') ||
    path === integrityManifestRelativePath ||
    path.endsWith('.map') ||
    (path !== 'index.html' && !/^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(path))
  ) {
    throw new Error(`Portal integrity manifest has an invalid path: ${String(path)}`)
  }
  return path
}

async function readRegularFile(path, label) {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file.`)
  }
  return readFile(path)
}

async function inventoryDirectory(root, current = root, files = []) {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(current, entry.name)
    const details = await lstat(path)
    if (details.isSymbolicLink()) throw new Error('Portal asset directory contains a symlink.')
    if (details.isDirectory()) {
      await inventoryDirectory(root, path, files)
      continue
    }
    if (!details.isFile()) throw new Error('Portal asset directory contains a non-regular entry.')
    const relativePath = relative(root, path).split(sep).join('/')
    if (!relativePath || relativePath.startsWith('../')) {
      throw new Error('Portal asset escaped its fixed directory.')
    }
    files.push(relativePath)
  }
  return files
}

function collectViteRuntimePaths(value, paths = new Set()) {
  if (Array.isArray(value)) {
    for (const nested of value) collectViteRuntimePaths(nested, paths)
    return paths
  }
  if (value === null || typeof value !== 'object') return paths
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'file' && typeof nested === 'string') paths.add(normalizeAssetPath(nested))
    if ((key === 'css' || key === 'assets') && Array.isArray(nested)) {
      for (const path of nested) paths.add(normalizeAssetPath(path))
    }
    if (key !== 'file' && key !== 'css' && key !== 'assets') {
      collectViteRuntimePaths(nested, paths)
    }
  }
  return paths
}

const releaseManifestContent = await readRegularFile(releaseManifestPath, 'Release manifest')
const releaseManifest = parseJson(releaseManifestContent, 'Release manifest')
if (/portalOidcClientSecret|SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET|client_secret/iu
  .test(releaseManifestContent.toString('utf8'))) {
  throw new Error('Release manifest contains forbidden Portal secret material.')
}

const packageJsonPath = join(dirname(assetDirectory), 'package.json')
const packageJson = parseJson(await readRegularFile(packageJsonPath, 'Portal package.json'),
  'Portal package.json')
if (packageJson.name !== '@sciforge/collaboration-portal' ||
    typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
  throw new Error('Installed Portal package identity is invalid.')
}

const viteManifestContent = await readRegularFile(
  join(assetDirectory, viteManifestRelativePath),
  'Portal Vite manifest'
)
const integrityManifestContent = await readRegularFile(
  join(assetDirectory, integrityManifestRelativePath),
  'Portal integrity manifest'
)
const viteManifest = parseJson(viteManifestContent, 'Portal Vite manifest')
if (!viteManifest || typeof viteManifest !== 'object' || Array.isArray(viteManifest) ||
    Object.keys(viteManifest).length === 0 ||
    !Object.values(viteManifest).some((entry) => entry?.isEntry === true)) {
  throw new Error('Portal Vite manifest has no entry asset.')
}
const integrityManifest = parseJson(integrityManifestContent, 'Portal integrity manifest')
if (!integrityManifest || typeof integrityManifest !== 'object' || Array.isArray(integrityManifest) ||
    JSON.stringify(Object.keys(integrityManifest).sort()) !==
      JSON.stringify(['basePath', 'files', 'schemaVersion']) ||
    integrityManifest.schemaVersion !== 1 || integrityManifest.basePath !== '/portal/' ||
    !Array.isArray(integrityManifest.files) || integrityManifest.files.length < 2 ||
    integrityManifest.files.length > 256) {
  throw new Error('Portal integrity manifest schema is invalid.')
}

const verifiedAssets = []
let previousPath = ''
let totalAssetBytes = 0
for (const entry of integrityManifest.files) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['bytes', 'path', 'sha256'])) {
    throw new Error('Portal integrity manifest has an invalid file entry.')
  }
  const path = normalizeAssetPath(entry.path)
  if (path <= previousPath) throw new Error('Portal asset inventory is not strictly sorted.')
  previousPath = path
  const content = await readRegularFile(join(assetDirectory, path), `Portal asset ${path}`)
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 ||
      entry.bytes > 4 * 1024 * 1024 || entry.bytes !== content.byteLength) {
    throw new Error(`Portal asset byte count mismatch for ${path}.`)
  }
  totalAssetBytes += entry.bytes
  if (totalAssetBytes > 12 * 1024 * 1024) {
    throw new Error('Portal assets exceed the bounded release size.')
  }
  if (!/^[0-9a-f]{64}$/u.test(entry.sha256) || entry.sha256 !== sha256(content)) {
    throw new Error(`Portal asset digest mismatch for ${path}.`)
  }
  if (content.includes(Buffer.from('SCIFORGE_COLLABORATION_PORTAL_OIDC_CLIENT_SECRET')) ||
      content.includes(Buffer.from('replace_with_portal_client_secret'))) {
    throw new Error(`Portal browser asset contains a forbidden secret marker: ${path}`)
  }
  verifiedAssets.push({ path, bytes: entry.bytes, sha256: entry.sha256 })
}
if (!verifiedAssets.some(({ path }) => path === 'index.html')) {
  throw new Error('Portal asset inventory is missing index.html.')
}
const describedPaths = new Set(verifiedAssets.map(({ path }) => path))
for (const path of collectViteRuntimePaths(viteManifest)) {
  if (!describedPaths.has(path)) throw new Error(`Vite references unlisted Portal asset ${path}.`)
}

const actualFiles = (await inventoryDirectory(assetDirectory)).sort()
const expectedFiles = [
  viteManifestRelativePath,
  integrityManifestRelativePath,
  ...verifiedAssets.map(({ path }) => path)
].sort()
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error('Installed Portal directory contains an unlisted or missing file.')
}

if (releaseManifest.releaseMode === 'a-https-oidc-test') {
  const expected = {
    schemaVersion: 4,
    portalEnabled: true,
    portalMode: 'confidential-bff',
    portalBasePath: '/portal/',
    portalAuthPathPrefix: '/portal/auth/',
    portalApiPathPrefix: '/portal/api/',
    portalEventsPath: '/portal/events',
    portalAssetDirectory: assetDirectory,
    portalViteManifestPath: 'dist/.vite/manifest.json',
    portalViteManifestSha256: sha256(viteManifestContent),
    portalIntegrityManifestPath: 'dist/ASSET_INTEGRITY.json',
    portalIntegrityManifestSha256: sha256(integrityManifestContent),
    portalPublicOrigin: 'https://cloud-test.sciforge.cn',
    portalAuthorizedParty: 'sciforge-cloud-console',
    portalOidcClientId: 'sciforge-cloud-console',
    portalOidcRedirectUri: 'https://cloud-test.sciforge.cn/portal/auth/callback',
    portalHumanNeededMode: 'display-only',
    portalTestWorkerDirectoryEnabled: true,
    portalSessionIdleSeconds: 1800,
    portalSessionAbsoluteSeconds: 28800,
    portalContentSecurityPolicy: "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; manifest-src 'none'"
  }
  for (const [key, value] of Object.entries(expected)) {
    if (releaseManifest[key] !== value) throw new Error(`Release manifest Portal field mismatch: ${key}`)
  }
  if (JSON.stringify(releaseManifest.portalAssets) !== JSON.stringify(verifiedAssets)) {
    throw new Error('Release manifest Portal asset inventory does not match the installed package.')
  }
  const releasePackage = releaseManifest.packages?.find((entry) =>
    entry?.name === '@sciforge/collaboration-portal')
  if (!releasePackage || releasePackage.version !== packageJson.version ||
      releasePackage.filename !== releaseManifest.portalPackageArchive ||
      releasePackage.sha256 !== releaseManifest.portalPackageSha256) {
    throw new Error('Release manifest Portal package binding is invalid.')
  }
} else {
  for (const key of Object.keys(releaseManifest)) {
    if (key.startsWith('portal')) {
      throw new Error('A non-OIDC release manifest must not enable Portal metadata.')
    }
  }
}

process.stdout.write(`Verified fixed Portal assets (${verifiedAssets.length} files).\n`)
