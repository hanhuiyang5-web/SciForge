import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PortalAssetStore } from './portal-assets.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Portal fixed asset loader', () => {
  it('loads only the Vite assets bound by the canonical integrity manifest', async () => {
    const directory = await createFixture()
    const store = await PortalAssetStore.load(directory)
    expect(store.get('/portal/')).toMatchObject({
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-store'
    })
    expect(store.get('/portal/assets/app-abcd1234.js')).toMatchObject({
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: 'public, max-age=31536000, immutable'
    })
    expect(store.get('/portal/ASSET_INTEGRITY.json')).toBeUndefined()
    expect(store.get('/portal/unknown.js')).toBeUndefined()
  })

  it('rejects content tampering, unbound files, unsafe mode, symlinks, and non-canonical order', async () => {
    const tampered = await createFixture()
    await writeFile(join(tampered, 'assets', 'app-abcd1234.js'), 'tampered')
    await expect(PortalAssetStore.load(tampered)).rejects.toThrow(/integrity/u)

    const unbound = await createFixture()
    await writeFile(join(unbound, 'assets', 'extra.js'), 'extra')
    await expect(PortalAssetStore.load(unbound)).rejects.toThrow(/unbound file/u)

    const unsafe = await createFixture()
    await chmod(join(unsafe, 'index.html'), 0o666)
    await expect(PortalAssetStore.load(unsafe)).rejects.toThrow(/protected regular file/u)

    const linked = await createFixture()
    await rm(join(linked, 'assets', 'app-abcd1234.js'))
    await symlink(join(linked, 'index.html'), join(linked, 'assets', 'app-abcd1234.js'))
    await expect(PortalAssetStore.load(linked)).rejects.toThrow(/symlinks|protected regular/u)

    const unsorted = await createFixture({ reverse: true })
    await expect(PortalAssetStore.load(unsorted)).rejects.toThrow(/not canonical/u)
  })

  it('rejects Vite references outside the bound inventory and multiple entries', async () => {
    const outside = await createFixture({ viteFile: 'assets/not-bound.js' })
    await expect(PortalAssetStore.load(outside)).rejects.toThrow(/unbound asset/u)

    const multiple = await createFixture({ secondEntry: true })
    await expect(PortalAssetStore.load(multiple)).rejects.toThrow(/one application entry/u)
  })
})

async function createFixture(options: { reverse?: boolean; viteFile?: string; secondEntry?: boolean } = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sciforge-portal-assets-'))
  directories.push(directory)
  await mkdir(join(directory, '.vite'), { mode: 0o755 })
  await mkdir(join(directory, 'assets'), { mode: 0o755 })
  const files = new Map([
    ['index.html', Buffer.from('<!doctype html><div id="root"></div>')],
    ['assets/app-abcd1234.js', Buffer.from('document.body.dataset.portal="ready"')],
    ['assets/app-abcd1234.css', Buffer.from(':root{color-scheme:light dark}')]
  ])
  for (const [path, bytes] of files) await writeFile(join(directory, ...path.split('/')), bytes, { mode: 0o644 })
  const entries = [...files].map(([path, bytes]) => ({
    path,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  })).sort((left, right) => left.path.localeCompare(right.path))
  if (options.reverse) entries.reverse()
  await writeFile(join(directory, 'ASSET_INTEGRITY.json'), `${JSON.stringify({
    schemaVersion: 1,
    basePath: '/portal/',
    files: entries
  })}\n`, { mode: 0o644 })
  await writeFile(join(directory, '.vite', 'manifest.json'), `${JSON.stringify({
    'src/main.tsx': {
      file: options.viteFile ?? 'assets/app-abcd1234.js',
      css: ['assets/app-abcd1234.css'],
      isEntry: true
    },
    ...(options.secondEntry ? { 'src/second.tsx': { file: 'assets/app-abcd1234.js', isEntry: true } } : {})
  })}\n`, { mode: 0o644 })
  return directory
}
