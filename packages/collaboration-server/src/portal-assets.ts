import { constants as fsConstants } from 'node:fs'
import { lstat, open, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_ASSET_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 12 * 1024 * 1024
const MAX_ASSET_COUNT = 256

export type PortalAsset = Readonly<{
  body: Buffer
  contentType: string
  cacheControl: string
  etag: string
}>

type IntegrityEntry = Readonly<{
  path: string
  bytes: number
  sha256: string
}>

export class PortalAssetStore {
  private constructor(private readonly assets: ReadonlyMap<string, PortalAsset>) {}

  static async load(directory: string): Promise<PortalAssetStore> {
    if (!isAbsolute(directory) || directory !== resolve(directory)) throw new Error('Portal asset directory must be absolute.')
    const directoryInfo = await lstat(directory)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o022) !== 0) {
      throw new Error('Portal asset directory is not a protected directory.')
    }

    const integrityBytes = await secureRead(join(directory, 'ASSET_INTEGRITY.json'), 256 * 1024)
    const viteBytes = await secureRead(join(directory, '.vite', 'manifest.json'), 256 * 1024)
    const entries = parseIntegrity(integrityBytes)
    validateViteManifest(viteBytes, entries)
    await assertExactInventory(directory, entries)

    let total = 0
    const assets = new Map<string, PortalAsset>()
    for (const entry of entries) {
      const body = await secureRead(join(directory, ...entry.path.split('/')), MAX_ASSET_BYTES)
      const sha256 = createHash('sha256').update(body).digest('hex')
      if (body.byteLength !== entry.bytes || sha256 !== entry.sha256) {
        throw new Error('Portal asset integrity verification failed.')
      }
      total += body.byteLength
      if (total > MAX_TOTAL_BYTES) throw new Error('Portal assets exceed the bounded release size.')
      const requestPath = entry.path === 'index.html' ? '/portal/' : `/portal/${entry.path}`
      assets.set(requestPath, Object.freeze({
        body,
        contentType: contentType(entry.path),
        cacheControl: entry.path === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
        etag: `"${sha256}"`
      }))
    }
    if (!assets.has('/portal/')) throw new Error('Portal release does not contain index.html.')
    return new PortalAssetStore(assets)
  }

  get(pathname: string): PortalAsset | undefined {
    return this.assets.get(pathname)
  }
}

function parseIntegrity(bytes: Buffer): IntegrityEntry[] {
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('Portal integrity manifest is invalid.') }
  if (!record(raw) || !exactKeys(raw, ['schemaVersion', 'basePath', 'files']) ||
      raw.schemaVersion !== 1 || raw.basePath !== '/portal/' ||
      !Array.isArray(raw.files) || raw.files.length < 2 || raw.files.length > MAX_ASSET_COUNT) {
    throw new Error('Portal integrity manifest is invalid.')
  }
  const entries = raw.files.map((candidate): IntegrityEntry => {
    if (!record(candidate) || !exactKeys(candidate, ['path', 'bytes', 'sha256']) ||
        typeof candidate.path !== 'string' || !validAssetPath(candidate.path) ||
        !Number.isSafeInteger(candidate.bytes) || Number(candidate.bytes) < 1 || Number(candidate.bytes) > MAX_ASSET_BYTES ||
        typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.sha256)) {
      throw new Error('Portal integrity manifest is invalid.')
    }
    return Object.freeze({ path: candidate.path, bytes: Number(candidate.bytes), sha256: candidate.sha256 })
  })
  const paths = entries.map((entry) => entry.path)
  if (new Set(paths).size !== paths.length || paths.join('\n') !== [...paths].sort().join('\n')) {
    throw new Error('Portal integrity manifest is not canonical.')
  }
  return entries
}

function validateViteManifest(bytes: Buffer, entries: readonly IntegrityEntry[]): void {
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('Portal Vite manifest is invalid.') }
  if (!record(raw) || Object.keys(raw).length < 1 || Object.keys(raw).length > 64) {
    throw new Error('Portal Vite manifest is invalid.')
  }
  const allowed = new Set(entries.map((entry) => entry.path))
  let entryCount = 0
  for (const value of Object.values(raw)) {
    if (!record(value) || typeof value.file !== 'string' || !allowed.has(value.file)) {
      throw new Error('Portal Vite manifest references an unbound asset.')
    }
    if (value.isEntry === true) entryCount += 1
    if (value.css !== undefined && (!Array.isArray(value.css) ||
        !value.css.every((path) => typeof path === 'string' && allowed.has(path)))) {
      throw new Error('Portal Vite manifest references an unbound asset.')
    }
    if (value.assets !== undefined && (!Array.isArray(value.assets) ||
        !value.assets.every((path) => typeof path === 'string' && allowed.has(path)))) {
      throw new Error('Portal Vite manifest references an unbound asset.')
    }
  }
  if (entryCount !== 1) throw new Error('Portal Vite manifest must contain one application entry.')
}

async function assertExactInventory(directory: string, entries: readonly IntegrityEntry[]): Promise<void> {
  const expected = new Set([
    'ASSET_INTEGRITY.json',
    '.vite/manifest.json',
    ...entries.map((entry) => entry.path)
  ])
  const observed = await walk(directory)
  if (observed.length !== expected.size || observed.some((path) => !expected.has(path))) {
    throw new Error('Portal release contains an unbound file.')
  }
}

async function walk(root: string, directory = root): Promise<string[]> {
  const items = await readdir(directory, { withFileTypes: true })
  const result: string[] = []
  for (const item of items) {
    const absolute = join(directory, item.name)
    if (item.isSymbolicLink()) throw new Error('Portal release cannot contain symlinks.')
    if (item.isDirectory()) {
      result.push(...await walk(root, absolute))
      continue
    }
    if (!item.isFile()) throw new Error('Portal release contains a special file.')
    result.push(relative(root, absolute).split(sep).join('/'))
  }
  return result.sort()
}

async function secureRead(path: string, maximumBytes: number): Promise<Buffer> {
  const before = await stat(path, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o022n) !== 0n ||
      before.size < 1n || before.size > BigInt(maximumBytes)) {
    throw new Error('Portal release asset is not a protected regular file.')
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
        before.nlink !== after.nlink || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        BigInt(bytes.byteLength) !== before.size) {
      throw new Error('Portal release asset changed while it was read.')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function validAssetPath(value: string): boolean {
  if (value === 'index.html') return true
  return /^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)
}

function contentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.woff2')) return 'font/woff2'
  throw new Error('Portal release contains an unsupported asset type.')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index])
}
