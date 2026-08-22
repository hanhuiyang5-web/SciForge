import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'

const packageRoot = resolve(import.meta.dirname, '..')
const distRoot = resolve(packageRoot, 'dist')
const outputPath = resolve(distRoot, 'ASSET_INTEGRITY.json')

const files = []
for (const path of await walk(distRoot)) {
  const normalized = relative(distRoot, path).split(sep).join('/')
  if (normalized === 'ASSET_INTEGRITY.json' || normalized === '.vite/manifest.json') continue
  const bytes = await readFile(path)
  files.push({
    path: normalized,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  })
}
files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
await writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, basePath: '/portal/', files }, null, 2)}\n`, { mode: 0o644 })

async function walk(directory) {
  const paths = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await walk(path))
    else if (entry.isFile() && (await stat(path)).isFile()) paths.push(path)
  }
  return paths
}
