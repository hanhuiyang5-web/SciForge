import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants as fsConstants, type Dirent } from 'node:fs'
import { access, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, join, relative as pathRelative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { generateKeyBetween } from 'fractional-indexing'
import type {
  SciforgeCanvasArtifactKind,
  SciforgeCanvasArtifactMetadata,
  SciforgeCanvasBounds,
  SciforgeCanvasImportRecentArtifactsRequest,
  SciforgeCanvasImportRecentArtifactsResult,
  SciforgeCanvasInsertArtifactRequest,
  SciforgeCanvasInsertArtifactResult,
  SciforgeCanvasOpenRequest,
  SciforgeCanvasRecentArtifact,
  SciforgeCanvasOpenResult,
  SciforgeCanvasReviewPacket,
  SciforgeCanvasReviewPacketRequest,
  SciforgeCanvasReviewPacketResult,
  SciforgeCanvasSaveRequest,
  SciforgeCanvasSaveResult,
  SciforgeCanvasSelectionSaveRequest,
  SciforgeCanvasSelectionState,
  SciforgeCanvasStatusResult
} from '../shared/sciforge-canvas'
import {
  SCIFORGE_CANVAS_ARTIFACT_KINDS
} from '../shared/sciforge-canvas'
import {
  canonicalPath,
  extensionFromName,
  resolveOpenTargetPath,
  resolveTargetPathWithinWorkspace
} from './services/workspace-paths'

type JsonRecord = Record<string, unknown>

type TldrawSnapshot = {
  store: Record<string, JsonRecord>
  schema: JsonRecord
}

type CanvasPaths = {
  workspaceRoot: string
  canvasId: string
  canvasDir: string
  canvasPath: string
  assetsDir: string
  selectionPath: string
  packetPath: string
  rendersDir: string
}

type ImageDimensions = {
  width: number
  height: number
}

type PptRenderTools = {
  sofficePath?: string
  pdftoppmPath?: string
  qlmanagePath?: string
}

type PptxPreviewResult = {
  pngPath: string
  pdfPath: string
  slideIndex: number
  pageNumber: number
}

const SERVER_VERSION = '0.1.0'
const DEFAULT_CANVAS_ID = 'default'
const CANVAS_ROOT_RELATIVE = '.sciforge/canvases'
const DEFAULT_PAGE_ID = 'page:sciforge-canvas'
const DEFAULT_PAGE_NAME = 'SciForge Canvas'
const DEFAULT_PAGE_INDEX = 'a1'
const DEFAULT_IMAGE_WIDTH = 640
const PLACEHOLDER_WIDTH = 460
const PLACEHOLDER_HEIGHT = 260
const MAX_IMAGE_BYTES = 40 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg'])
const RECENT_ARTIFACT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.pptx'])
const RECENT_ARTIFACT_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const RECENT_ARTIFACT_DEFAULT_LIMIT = 8
const RECENT_ARTIFACT_MAX_LIMIT = 20
const RECENT_ARTIFACT_MAX_DEPTH = 5
const RECENT_ARTIFACT_MAX_VISITED = 3000
const SKIPPED_SCAN_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.vite', '.turbo'])
const PPT_PREVIEW_DPI = 160
const PPT_RENDER_TIMEOUT_MS = 120_000
const execFileAsync = promisify(execFile)

const EMPTY_TLDRAW_SCHEMA: JsonRecord = {
  schemaVersion: 2,
  sequences: {
    'com.tldraw.store': 5,
    'com.tldraw.asset': 1,
    'com.tldraw.camera': 1,
    'com.tldraw.document': 2,
    'com.tldraw.instance': 26,
    'com.tldraw.instance_page_state': 5,
    'com.tldraw.page': 1,
    'com.tldraw.instance_presence': 6,
    'com.tldraw.pointer': 1,
    'com.tldraw.shape': 4,
    'com.tldraw.user': 1,
    'com.tldraw.asset.image': 6,
    'com.tldraw.asset.video': 5,
    'com.tldraw.asset.bookmark': 2,
    'com.tldraw.shape.group': 0,
    'com.tldraw.shape.text': 4,
    'com.tldraw.shape.bookmark': 2,
    'com.tldraw.shape.draw': 4,
    'com.tldraw.shape.geo': 11,
    'com.tldraw.shape.note': 12,
    'com.tldraw.shape.line': 5,
    'com.tldraw.shape.frame': 1,
    'com.tldraw.shape.arrow': 8,
    'com.tldraw.shape.highlight': 3,
    'com.tldraw.shape.embed': 4,
    'com.tldraw.shape.image': 5,
    'com.tldraw.shape.video': 4,
    'com.tldraw.binding.arrow': 1
  }
}

export async function getSciforgeCanvasStatus(
  workspaceRoot?: string
): Promise<SciforgeCanvasStatusResult> {
  const pptRenderTools = await detectPptRenderTools()
  return {
    ok: true,
    serverName: 'sciforge_canvas',
    version: SERVER_VERSION,
    ...(workspaceRoot?.trim() ? { workspaceRoot: await resolveWorkspaceRoot(workspaceRoot) } : {}),
    defaultRelativeDir: CANVAS_ROOT_RELATIVE,
    supportedArtifactKinds: [...SCIFORGE_CANVAS_ARTIFACT_KINDS],
    cowartCompatibility: {
      aiImageHolderMeta: 'cowartAiImageHolder',
      annotationArrowMeta: 'cowartAnnotationArrow',
      annotationEditMeta: 'cowartGeneratedFromAnnotationEdit',
      sourceShapeMeta: 'cowartAnnotationSourceShapeId',
      annotationScreenshotMeta: 'cowartAnnotationScreenshot'
    },
    guardrails: [
      'Canvas state and assets are written only inside the selected workspace.',
      'Cowart-compatible metadata is preserved for AI image holders, annotation arrows, and before/after edits.',
      'Scientific plot and ppt-master source artifacts are not overwritten.',
      'Canvas review packets describe requested adjustments; they do not directly mutate scientific data or ppt-master projects.'
    ],
    pptRendering: {
      svgSlidePreview: true,
      pptxPreview: (pptRenderTools.sofficePath && pptRenderTools.pdftoppmPath) || pptRenderTools.qlmanagePath
        ? 'available'
        : 'unavailable',
      ...(pptRenderTools.sofficePath ? { sofficePath: pptRenderTools.sofficePath } : {}),
      ...(pptRenderTools.pdftoppmPath ? { pdftoppmPath: pptRenderTools.pdftoppmPath } : {}),
      ...(pptRenderTools.qlmanagePath ? { qlmanagePath: pptRenderTools.qlmanagePath } : {})
    }
  }
}

export async function openOrCreateSciforgeCanvas(
  request: SciforgeCanvasOpenRequest
): Promise<SciforgeCanvasOpenResult> {
  try {
    const paths = await resolveCanvasPaths(request.workspaceRoot, request.canvasId)
    await mkdir(paths.assetsDir, { recursive: true })
    const existed = await fileExists(paths.canvasPath)
    const snapshot = existed ? await readCanvasSnapshot(paths) : createInitialCanvasSnapshot()
    if (!existed) await writeJsonAtomic(paths.canvasPath, snapshot)
    const selection = await readSelectionState(paths)
    return {
      ok: true,
      status: existed ? 'opened' : 'created',
      workspaceRoot: paths.workspaceRoot,
      canvasId: paths.canvasId,
      canvasDir: paths.canvasDir,
      canvasPath: paths.canvasPath,
      assetsDir: paths.assetsDir,
      selectionPath: paths.selectionPath,
      snapshot,
      selection,
      warnings: []
    }
  } catch (error) {
    return {
      ok: false,
      status: error instanceof Error && error.message.includes('workspace') ? 'invalid_workspace' : 'invalid_request',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function saveSciforgeCanvasSnapshot(
  request: SciforgeCanvasSaveRequest
): Promise<SciforgeCanvasSaveResult> {
  try {
    const paths = await resolveCanvasPaths(request.workspaceRoot, request.canvasId)
    const snapshot = normalizeSnapshot(request.snapshot)
    await mkdir(paths.assetsDir, { recursive: true })
    await writeJsonAtomic(paths.canvasPath, snapshot)
    return {
      ok: true,
      status: 'saved',
      canvasId: paths.canvasId,
      canvasPath: paths.canvasPath,
      updatedAt: new Date().toISOString()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: message.includes('workspace') ? 'invalid_workspace' : message.includes('snapshot') ? 'invalid_snapshot' : 'invalid_request',
      message
    }
  }
}

export async function saveSciforgeCanvasSelection(
  request: SciforgeCanvasSelectionSaveRequest
): Promise<SciforgeCanvasSaveResult> {
  try {
    const paths = await resolveCanvasPaths(request.workspaceRoot, request.canvasId)
    const selection = normalizeSelection(request.selection)
    await mkdir(paths.canvasDir, { recursive: true })
    await writeJsonAtomic(paths.selectionPath, {
      ...selection,
      updatedAt: selection.updatedAt ?? new Date().toISOString()
    })
    return {
      ok: true,
      status: 'saved',
      canvasId: paths.canvasId,
      canvasPath: paths.selectionPath,
      updatedAt: new Date().toISOString()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: message.includes('workspace') ? 'invalid_workspace' : 'invalid_request',
      message
    }
  }
}

export async function insertSciforgeCanvasArtifact(
  request: SciforgeCanvasInsertArtifactRequest
): Promise<SciforgeCanvasInsertArtifactResult> {
  const warnings: string[] = []
  try {
    const paths = await resolveCanvasPaths(request.workspaceRoot, request.canvasId)
    await mkdir(paths.assetsDir, { recursive: true })
    const snapshot = await ensureCanvasSnapshot(paths)
    const pageId = findPageId(snapshot) ?? DEFAULT_PAGE_ID
    ensurePageRecord(snapshot, pageId)
    let artifact = await buildArtifactMetadata(request, paths.workspaceRoot, warnings)
    artifact = await prepareCanvasArtifactPreview({
      artifact,
      request,
      paths,
      warnings
    })
    const anchorShape = request.anchorShapeId ? snapshot.store[request.anchorShapeId] : null
    const parentId = anchorShape?.parentId && snapshot.store[String(anchorShape.parentId)]?.typeName === 'page'
      ? String(anchorShape.parentId)
      : pageId

    const shapeMeta = buildShapeMeta(request, artifact)
    let result: Extract<SciforgeCanvasInsertArtifactResult, { ok: true }>
    if (artifact.pptxPath && request.artifactKind === 'ppt_export' && !displayPathForArtifact(artifact)) {
      result = insertPlaceholderArtifact({
        snapshot,
        paths,
        artifact,
        request,
        pageId,
        parentId,
        anchorShape: asRecord(anchorShape),
        shapeMeta
      })
    } else {
      result = await insertImageArtifact({
        snapshot,
        paths,
        artifact,
        request,
        pageId,
        parentId,
        anchorShape: asRecord(anchorShape),
        shapeMeta,
        warnings
      })
    }

    if (!request.dryRun) {
      await writeJsonAtomic(paths.canvasPath, snapshot)
    }
    return {
      ...result,
      status: request.dryRun ? 'planned' : 'inserted',
      dryRun: Boolean(request.dryRun),
      warnings
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: statusForInsertError(message),
      message,
      warnings
    }
  }
}

export async function importRecentSciforgeCanvasArtifacts(
  request: SciforgeCanvasImportRecentArtifactsRequest
): Promise<SciforgeCanvasImportRecentArtifactsResult> {
  const warnings: string[] = []
  try {
    const paths = await resolveCanvasPaths(request.workspaceRoot, request.canvasId)
    await mkdir(paths.assetsDir, { recursive: true })
    const snapshot = await ensureCanvasSnapshot(paths)
    const existingPaths = request.includeExisting ? new Set<string>() : artifactPathsInSnapshot(snapshot)
    const limit = Math.min(
      RECENT_ARTIFACT_MAX_LIMIT,
      Math.max(1, Math.floor(request.limit ?? RECENT_ARTIFACT_DEFAULT_LIMIT))
    )
    const maxAgeMs = Math.max(0, Math.floor(request.maxAgeMs ?? RECENT_ARTIFACT_DEFAULT_MAX_AGE_MS))
    const discovered = await discoverRecentCanvasArtifacts({
      workspaceRoot: paths.workspaceRoot,
      canvasDir: paths.canvasDir,
      existingPaths,
      maxAgeMs,
      limit,
      warnings
    })
    const inserted: Extract<SciforgeCanvasImportRecentArtifactsResult, { ok: true }>['inserted'] = []

    for (const artifact of discovered.artifacts.slice(0, limit)) {
      if (artifact.alreadyOnCanvas && !request.includeExisting) continue
      const result = await insertSciforgeCanvasArtifact({
        workspaceRoot: paths.workspaceRoot,
        canvasId: paths.canvasId,
        artifactKind: artifact.artifactKind,
        ...(artifact.artifactKind === 'ppt_export'
          ? { pptxPath: artifact.path, slideIndex: 0 }
          : artifact.artifactKind === 'ppt_slide'
            ? { svgPath: artifact.path }
            : artifact.artifactKind === 'scientific_plot'
              ? { outputPath: artifact.path }
              : { sourcePath: artifact.path }),
        ...(artifact.manifestPath ? { manifestPath: artifact.manifestPath } : {}),
        title: artifact.title,
        sourceTool: artifact.sourceTool ?? 'workspace_artifact_import',
        placement: 'below',
        margin: 56,
        dryRun: request.dryRun
      })
      if (result.ok) {
        inserted.push({ artifact, result })
        warnings.push(...result.warnings)
      } else {
        warnings.push(`Skipped ${artifact.relativePath}: ${result.message}`)
      }
    }

    return {
      ok: true,
      status: request.dryRun ? 'planned' : inserted.length > 0 ? 'imported' : 'empty',
      canvasId: paths.canvasId,
      canvasPath: paths.canvasPath,
      scanned: discovered.scanned,
      imported: inserted.length,
      skipped: Math.max(0, discovered.artifacts.length - inserted.length),
      artifacts: discovered.artifacts,
      inserted,
      warnings: [...new Set(warnings)],
      dryRun: Boolean(request.dryRun)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: message.includes('workspace') ? 'invalid_workspace' : message.includes('write') ? 'canvas_write_failed' : 'scan_failed',
      message,
      warnings
    }
  }
}

export async function exportSciforgeCanvasReviewPacket(
  request: SciforgeCanvasReviewPacketRequest
): Promise<SciforgeCanvasReviewPacketResult> {
  const warnings: string[] = []
  try {
    const paths = await resolveCanvasPaths(request.workspaceRoot, request.canvasId)
    const snapshot = await readCanvasSnapshot(paths)
    const selection = await readSelectionState(paths)
    const packet = buildReviewPacket({
      canvasId: paths.canvasId,
      title: request.title?.trim() || `SciForge Canvas Review ${paths.canvasId}`,
      snapshot,
      selection
    })
    const packetPath = request.packetId?.trim()
      ? join(paths.canvasDir, `${sanitizeId(request.packetId, 'review-packet')}.json`)
      : paths.packetPath
    await writeJsonAtomic(packetPath, packet)
    return {
      ok: true,
      status: 'created',
      canvasId: paths.canvasId,
      packetPath,
      packet,
      warnings
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: message.includes('workspace') ? 'invalid_workspace' : message.includes('snapshot') ? 'canvas_read_failed' : 'invalid_request',
      message,
      warnings
    }
  }
}

async function resolveCanvasPaths(workspaceRoot: string, canvasId?: string): Promise<CanvasPaths> {
  const resolvedWorkspace = await resolveWorkspaceRoot(workspaceRoot)
  const normalizedCanvasId = sanitizeId(canvasId, DEFAULT_CANVAS_ID)
  const canvasDir = join(resolvedWorkspace, CANVAS_ROOT_RELATIVE, normalizedCanvasId)
  return {
    workspaceRoot: resolvedWorkspace,
    canvasId: normalizedCanvasId,
    canvasDir,
    canvasPath: join(canvasDir, 'canvas.json'),
    assetsDir: join(canvasDir, 'assets'),
    selectionPath: join(canvasDir, 'selection.json'),
    packetPath: join(canvasDir, 'review-packet.json'),
    rendersDir: join(canvasDir, 'renders')
  }
}

async function resolveWorkspaceRoot(raw: string): Promise<string> {
  const workspaceRoot = await canonicalPath(resolve(raw))
  const info = await stat(workspaceRoot)
  if (!info.isDirectory()) throw new Error('workspaceRoot must be a directory.')
  return workspaceRoot
}

function sanitizeId(raw: string | undefined, fallback: string): string {
  const value = String(raw || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  if (!value || value === '.' || value === '..') return fallback
  return value
}

function createInitialCanvasSnapshot(): TldrawSnapshot {
  return {
    schema: structuredClone(EMPTY_TLDRAW_SCHEMA),
    store: {
      [DEFAULT_PAGE_ID]: {
        id: DEFAULT_PAGE_ID,
        typeName: 'page',
        name: DEFAULT_PAGE_NAME,
        index: DEFAULT_PAGE_INDEX,
        meta: {
          sciforgeCanvas: true
        }
      }
    }
  }
}

function normalizeSnapshot(value: unknown): TldrawSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Expected a tldraw snapshot object.')
  const snapshot = value as Partial<TldrawSnapshot>
  if (!snapshot.store || typeof snapshot.store !== 'object') throw new Error('Expected snapshot.store.')
  if (!snapshot.schema || typeof snapshot.schema !== 'object') throw new Error('Expected snapshot.schema.')
  const normalized = {
    store: snapshot.store as Record<string, JsonRecord>,
    schema: snapshot.schema as JsonRecord
  }
  sanitizeSnapshotForTldraw(normalized)
  return normalized
}

function sanitizeSnapshotForTldraw(snapshot: TldrawSnapshot): void {
  for (const record of Object.values(snapshot.store)) {
    if (record?.typeName !== 'shape' || record.type !== 'arrow') continue
    const props = asRecord(record.props)
    if (!props) continue

    const legacyText = typeof props.text === 'string' ? props.text.trim() : ''
    if (!props.richText && legacyText) {
      props.richText = richTextFromPlainText(legacyText)
    }
    delete props.text

    sanitizeArrowEndpoint(props.start)
    sanitizeArrowEndpoint(props.end)

    if (typeof props.elbowMidPoint !== 'number') {
      props.elbowMidPoint = 0.5
    }
  }
}

function sanitizeArrowEndpoint(value: unknown): void {
  const endpoint = asRecord(value)
  if (!endpoint) return
  delete endpoint.type
}

function richTextFromPlainText(text: string): JsonRecord {
  return {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text
      }]
    }]
  }
}

async function ensureCanvasSnapshot(paths: CanvasPaths): Promise<TldrawSnapshot> {
  if (await fileExists(paths.canvasPath)) return readCanvasSnapshot(paths)
  const snapshot = createInitialCanvasSnapshot()
  await writeJsonAtomic(paths.canvasPath, snapshot)
  return snapshot
}

async function readCanvasSnapshot(paths: CanvasPaths): Promise<TldrawSnapshot> {
  const snapshot = normalizeSnapshot(JSON.parse(await readFile(paths.canvasPath, 'utf8')))
  ensurePageRecord(snapshot, findPageId(snapshot) ?? DEFAULT_PAGE_ID)
  return snapshot
}

function ensurePageRecord(snapshot: TldrawSnapshot, pageId: string): void {
  if (snapshot.store[pageId]?.typeName === 'page') return
  snapshot.store[pageId] = {
    id: pageId,
    typeName: 'page',
    name: DEFAULT_PAGE_NAME,
    index: DEFAULT_PAGE_INDEX,
    meta: {
      sciforgeCanvas: true
    }
  }
}

async function readSelectionState(paths: CanvasPaths): Promise<SciforgeCanvasSelectionState> {
  try {
    return normalizeSelection(JSON.parse(await readFile(paths.selectionPath, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { selectedShapes: [], updatedAt: null }
    }
    throw error
  }
}

function normalizeSelection(value: unknown): SciforgeCanvasSelectionState {
  if (!value || typeof value !== 'object') return { selectedShapes: [], updatedAt: null }
  const selectedShapes = Array.isArray((value as SciforgeCanvasSelectionState).selectedShapes)
    ? (value as SciforgeCanvasSelectionState).selectedShapes
    : []
  return {
    selectedShapes,
    updatedAt: typeof (value as SciforgeCanvasSelectionState).updatedAt === 'string'
      ? (value as SciforgeCanvasSelectionState).updatedAt
      : null
  }
}

async function buildArtifactMetadata(
  request: SciforgeCanvasInsertArtifactRequest,
  workspaceRoot: string,
  warnings: string[]
): Promise<SciforgeCanvasArtifactMetadata> {
  if (!SCIFORGE_CANVAS_ARTIFACT_KINDS.includes(request.artifactKind)) {
    throw new Error(`Unsupported artifactKind: ${request.artifactKind}`)
  }
  const sourcePath = await resolveOptionalPath(request.sourcePath, workspaceRoot)
  const outputPath = await resolveOptionalPath(request.outputPath, workspaceRoot)
  const previewPath = await resolveOptionalPath(request.previewPath, workspaceRoot)
  const renderedPagePath = await resolveOptionalPath(request.renderedPagePath, workspaceRoot)
  const renderedFromPptxPath = await resolveOptionalPath(request.renderedFromPptxPath, workspaceRoot)
  const manifestPath = await resolveOptionalPath(request.manifestPath, workspaceRoot)
  const styleSpecPath = await resolveOptionalPath(request.styleSpecPath, workspaceRoot)
  const referencePath = await resolveOptionalPath(request.referencePath, workspaceRoot)
  const projectPath = await resolveOptionalExistingDirectory(request.projectPath, workspaceRoot)
  const svgPath = await resolveOptionalPath(request.svgPath, workspaceRoot)
  const pptxPath = await resolveOptionalPath(request.pptxPath, workspaceRoot)
  const reviewPacketPath = await resolveOptionalPath(request.reviewPacketPath, workspaceRoot)

  const artifact: SciforgeCanvasArtifactMetadata = {
    artifactKind: request.artifactKind,
    ...(sourcePath ? { sourcePath } : {}),
    ...(outputPath ? { outputPath } : {}),
    ...(previewPath ? { previewPath } : {}),
    ...(renderedPagePath ? { renderedPagePath } : {}),
    ...(renderedFromPptxPath ? { renderedFromPptxPath } : {}),
    ...(request.renderedSlideIndex !== undefined ? { renderedSlideIndex: request.renderedSlideIndex } : {}),
    ...(manifestPath ? { manifestPath } : {}),
    ...(styleSpecPath ? { styleSpecPath } : {}),
    ...(referencePath ? { referencePath } : {}),
    ...(projectPath ? { projectPath } : {}),
    ...(svgPath ? { svgPath } : {}),
    ...(pptxPath ? { pptxPath } : {}),
    ...(request.slideIndex !== undefined ? { slideIndex: request.slideIndex } : {}),
    ...(request.title?.trim() ? { title: request.title.trim() } : {}),
    ...(request.caption?.trim() ? { caption: request.caption.trim() } : {}),
    ...(request.sourceTool?.trim() ? { sourceTool: request.sourceTool.trim() } : {}),
    ...(request.reviewScore ? { reviewScore: request.reviewScore } : {}),
    ...(reviewPacketPath ? { reviewPacketPath } : {})
  }

  if (request.artifactKind === 'scientific_plot' && !artifact.outputPath && !artifact.sourcePath) {
    throw new Error('scientific_plot artifacts require outputPath or sourcePath.')
  }
  if (request.artifactKind === 'ppt_slide' && !artifact.svgPath && !artifact.sourcePath && !artifact.outputPath) {
    throw new Error('ppt_slide artifacts require svgPath, outputPath, or sourcePath.')
  }
  if (request.artifactKind === 'ppt_export' && !artifact.pptxPath && !artifact.sourcePath) {
    throw new Error('ppt_export artifacts require pptxPath or sourcePath.')
  }

  const displayPath = displayPathForArtifact(artifact)
  if (displayPath && !IMAGE_EXTENSIONS.has(extensionFromName(displayPath))) {
    if (request.artifactKind !== 'ppt_export') {
      throw new Error(`Canvas can display PNG/JPEG/WebP/SVG artifacts only in v1: ${displayPath}`)
    }
    warnings.push('ppt_export will be represented as a canvas placeholder unless a PNG/SVG preview can be produced.')
  }

  return artifact
}

async function resolveOptionalPath(raw: string | undefined, workspaceRoot: string): Promise<string | undefined> {
  if (!raw?.trim()) return undefined
  return resolveOpenTargetPath(raw, workspaceRoot, { allowBasenameFallback: false })
}

async function resolveOptionalExistingDirectory(raw: string | undefined, workspaceRoot: string): Promise<string | undefined> {
  if (!raw?.trim()) return undefined
  const target = await resolveTargetPathWithinWorkspace(raw, workspaceRoot)
  const info = await stat(target)
  if (!info.isDirectory()) throw new Error('projectPath must be a directory.')
  return target
}

function displayPathForArtifact(artifact: SciforgeCanvasArtifactMetadata): string | undefined {
  if (artifact.previewPath) return artifact.previewPath
  if (artifact.renderedPagePath) return artifact.renderedPagePath
  if (artifact.artifactKind === 'ppt_slide') return artifact.svgPath ?? artifact.outputPath ?? artifact.sourcePath
  if (artifact.artifactKind === 'scientific_plot') return artifact.outputPath ?? artifact.sourcePath
  if (artifact.artifactKind === 'image') return artifact.sourcePath ?? artifact.outputPath
  return artifact.outputPath ?? artifact.sourcePath
}

async function prepareCanvasArtifactPreview(input: {
  artifact: SciforgeCanvasArtifactMetadata
  request: SciforgeCanvasInsertArtifactRequest
  paths: CanvasPaths
  warnings: string[]
}): Promise<SciforgeCanvasArtifactMetadata> {
  if (input.artifact.artifactKind !== 'ppt_export') return input.artifact
  if (!input.artifact.pptxPath) return input.artifact
  if (displayPathForArtifact(input.artifact)) return input.artifact

  try {
    const preview = await renderPptxSlidePreview({
      pptxPath: input.artifact.pptxPath,
      slideIndex: Math.max(0, Math.floor(input.request.slideIndex ?? 0)),
      paths: input.paths
    })
    input.warnings.push(`ppt_export slide ${preview.pageNumber} rendered to PNG preview for canvas review.`)
    return {
      ...input.artifact,
      previewPath: preview.pngPath,
      renderedPagePath: preview.pngPath,
      renderedFromPptxPath: input.artifact.pptxPath,
      renderedSlideIndex: preview.slideIndex
    }
  } catch (error) {
    input.warnings.push(`ppt_export preview rendering unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return input.artifact
  }
}

function buildShapeMeta(
  request: SciforgeCanvasInsertArtifactRequest,
  artifact: SciforgeCanvasArtifactMetadata
): JsonRecord {
  const meta: JsonRecord = {
    ...(request.shapeMeta ?? {}),
    sciforgeCanvasArtifact: true,
    sciforgeCanvasArtifactVersion: 1,
    artifactKind: artifact.artifactKind,
    sciforgeArtifact: artifact
  }
  if (request.anchorShapeId && !meta.cowartAnnotationSourceShapeId) {
    meta.cowartAnnotationSourceShapeId = request.anchorShapeId
  }
  if (request.annotationScreenshot?.trim() && !meta.cowartAnnotationScreenshot) {
    meta.cowartAnnotationScreenshot = request.annotationScreenshot.trim()
  }
  if (request.annotationScreenshot?.trim()) {
    meta.cowartGeneratedFromAnnotationEdit = true
  }
  return meta
}

async function insertImageArtifact(input: {
  snapshot: TldrawSnapshot
  paths: CanvasPaths
  artifact: SciforgeCanvasArtifactMetadata
  request: SciforgeCanvasInsertArtifactRequest
  pageId: string
  parentId: string
  anchorShape: JsonRecord | null
  shapeMeta: JsonRecord
  warnings: string[]
}): Promise<Extract<SciforgeCanvasInsertArtifactResult, { ok: true }>> {
  const sourcePath = displayPathForArtifact(input.artifact)
  if (!sourcePath) throw new Error('No displayable artifact path was provided.')
  const sourceStat = await stat(sourcePath)
  if (!sourceStat.isFile()) throw new Error(`Artifact path is not a file: ${sourcePath}`)
  if (sourceStat.size > MAX_IMAGE_BYTES) throw new Error(`Artifact is too large for canvas insertion: ${sourcePath}`)

  const ext = extensionFromName(sourcePath)
  const mimeType = mimeTypeForExtension(ext)
  if (!mimeType) throw new Error(`Unsupported image artifact extension: ${ext}`)
  const bytes = await readFile(sourcePath)
  const imageSize = readImageDimensions(sourcePath, bytes)
  const anchorBounds = input.anchorShape ? pageBoundsForShape(input.snapshot.store, input.anchorShape) : null
  const matchAnchor = input.request.matchAnchor !== false && anchorBounds
  const width = finiteNumber(input.request.displayWidth, matchAnchor ? anchorBounds.w : Math.min(imageSize.width, DEFAULT_IMAGE_WIDTH))
  const height = finiteNumber(
    input.request.displayHeight,
    matchAnchor ? anchorBounds.h : Math.round(width * (imageSize.height / imageSize.width))
  )
  const bounds = choosePlacement({
    store: input.snapshot.store,
    pageId: input.pageId,
    parentId: input.parentId,
    anchorShape: input.anchorShape,
    width,
    height,
    margin: Math.max(0, finiteNumber(input.request.margin, 40)),
    placement: input.request.placement ?? 'right'
  })

  const { fileName, filePath } = await uniqueFilePath(input.paths.assetsDir, input.request.fileName || basename(sourcePath))
  const assetId = uniqueRecordId(input.snapshot.store, 'asset', fileName)
  const shapeId = uniqueRecordId(input.snapshot.store, 'shape', fileName)
  const index = chooseIndex(input.snapshot.store, input.parentId)
  const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`
  const assetMeta = {
    ...(input.request.assetMeta ?? {}),
    sciforgeCanvasAssetFile: filePath,
    sciforgeCanvasSourcePath: sourcePath
  }

  input.snapshot.store[assetId] = {
    id: assetId,
    typeName: 'asset',
    type: 'image',
    props: {
      name: fileName,
      src: dataUrl,
      w: imageSize.width,
      h: imageSize.height,
      fileSize: sourceStat.size,
      mimeType,
      isAnimated: false
    },
    meta: assetMeta
  }
  input.snapshot.store[shapeId] = {
    id: shapeId,
    typeName: 'shape',
    type: 'image',
    parentId: input.parentId,
    index,
    x: bounds.x,
    y: bounds.y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: input.shapeMeta,
    props: {
      w: bounds.w,
      h: bounds.h,
      assetId,
      playing: true,
      url: '',
      crop: null,
      flipX: false,
      flipY: false,
      altText: input.request.altText?.trim() || input.artifact.title || 'SciForge canvas artifact'
    }
  }

  if (!input.request.dryRun) {
    await mkdir(input.paths.assetsDir, { recursive: true })
    await copyFile(sourcePath, filePath)
  }

  return {
    ok: true,
    status: 'inserted',
    canvasId: input.paths.canvasId,
    canvasDir: input.paths.canvasDir,
    canvasPath: input.paths.canvasPath,
    assetFile: filePath,
    assetId,
    shapeId,
    pageId: input.pageId,
    parentId: input.parentId,
    bounds,
    artifact: input.artifact,
    warnings: input.warnings,
    dryRun: Boolean(input.request.dryRun)
  }
}

function insertPlaceholderArtifact(input: {
  snapshot: TldrawSnapshot
  paths: CanvasPaths
  artifact: SciforgeCanvasArtifactMetadata
  request: SciforgeCanvasInsertArtifactRequest
  pageId: string
  parentId: string
  anchorShape: JsonRecord | null
  shapeMeta: JsonRecord
}): Extract<SciforgeCanvasInsertArtifactResult, { ok: true }> {
  const width = finiteNumber(input.request.displayWidth, PLACEHOLDER_WIDTH)
  const height = finiteNumber(input.request.displayHeight, PLACEHOLDER_HEIGHT)
  const bounds = choosePlacement({
    store: input.snapshot.store,
    pageId: input.pageId,
    parentId: input.parentId,
    anchorShape: input.anchorShape,
    width,
    height,
    margin: Math.max(0, finiteNumber(input.request.margin, 40)),
    placement: input.request.placement ?? 'right'
  })
  const shapeId = uniqueRecordId(input.snapshot.store, 'shape', input.artifact.title || 'ppt-export')
  input.snapshot.store[shapeId] = {
    id: shapeId,
    typeName: 'shape',
    type: 'frame',
    parentId: input.parentId,
    index: chooseIndex(input.snapshot.store, input.parentId),
    x: bounds.x,
    y: bounds.y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {
      ...input.shapeMeta,
      sciforgeCanvasPlaceholder: true
    },
    props: {
      w: bounds.w,
      h: bounds.h,
      name: input.artifact.title || 'PPTX export',
      color: 'violet'
    }
  }
  return {
    ok: true,
    status: 'inserted',
    canvasId: input.paths.canvasId,
    canvasDir: input.paths.canvasDir,
    canvasPath: input.paths.canvasPath,
    shapeId,
    pageId: input.pageId,
    parentId: input.parentId,
    bounds,
    artifact: input.artifact,
    warnings: ['ppt_export is represented as a canvas placeholder because no PPTX page preview is available.'],
    dryRun: Boolean(input.request.dryRun)
  }
}

async function discoverRecentCanvasArtifacts(input: {
  workspaceRoot: string
  canvasDir: string
  existingPaths: Set<string>
  maxAgeMs: number
  limit: number
  warnings: string[]
}): Promise<{ scanned: number; artifacts: SciforgeCanvasRecentArtifact[] }> {
  const cutoff = input.maxAgeMs > 0 ? Date.now() - input.maxAgeMs : 0
  const artifacts: SciforgeCanvasRecentArtifact[] = []
  let scanned = 0

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > RECENT_ARTIFACT_MAX_DEPTH || scanned >= RECENT_ARTIFACT_MAX_VISITED) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      input.warnings.push(`Could not scan ${relativePath(input.workspaceRoot, dir)}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    for (const entry of entries) {
      if (scanned >= RECENT_ARTIFACT_MAX_VISITED) break
      const entryPath = join(dir, entry.name)
      const relative = relativePath(input.workspaceRoot, entryPath)
      if (entry.isDirectory()) {
        if (shouldSkipRecentArtifactDir(input.workspaceRoot, input.canvasDir, entryPath, entry.name)) continue
        await walk(entryPath, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      scanned += 1
      const ext = extensionFromName(entry.name)
      if (!RECENT_ARTIFACT_EXTENSIONS.has(ext)) continue
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(entryPath)
      } catch {
        continue
      }
      if (cutoff > 0 && info.mtimeMs < cutoff) continue
      const artifact = await buildRecentArtifact(entryPath, relative, info.size, info.mtimeMs, input.existingPaths)
      artifacts.push(artifact)
    }
  }

  await walk(input.workspaceRoot, 0)
  artifacts.sort((left, right) => {
    if (left.alreadyOnCanvas !== right.alreadyOnCanvas) return left.alreadyOnCanvas ? 1 : -1
    return right.mtimeMs - left.mtimeMs
  })
  return {
    scanned,
    artifacts: artifacts.slice(0, input.limit)
  }
}

function shouldSkipRecentArtifactDir(
  workspaceRoot: string,
  canvasDir: string,
  dirPath: string,
  dirName: string
): boolean {
  if (SKIPPED_SCAN_DIRS.has(dirName)) return true
  const relative = relativePath(workspaceRoot, dirPath)
  if (relative === '.sciforge/canvases' || relative.startsWith('.sciforge/canvases/')) return true
  if (dirPath === canvasDir || dirPath.startsWith(`${canvasDir}/`)) return true
  return false
}

async function buildRecentArtifact(
  artifactPath: string,
  relative: string,
  size: number,
  mtimeMs: number,
  existingPaths: Set<string>
): Promise<SciforgeCanvasRecentArtifact> {
  const artifactKind = recentArtifactKind(artifactPath, relative)
  const manifestPath = await findRecentArtifactManifest(artifactPath)
  return {
    path: artifactPath,
    relativePath: relative,
    artifactKind,
    title: titleFromArtifactPath(artifactPath),
    size,
    mtimeMs,
    sourceTool: sourceToolForRecentArtifact(artifactKind, relative),
    ...(manifestPath ? { manifestPath } : {}),
    alreadyOnCanvas: existingPaths.has(artifactPath)
  }
}

function recentArtifactKind(artifactPath: string, relative: string): SciforgeCanvasArtifactKind {
  const ext = extensionFromName(artifactPath)
  const searchable = `${relative} ${basename(artifactPath)}`.toLowerCase()
  if (ext === '.pptx') return 'ppt_export'
  if (ext === '.svg' && /(?:ppt|slide|deck|presentation|幻灯|页面)/i.test(searchable)) return 'ppt_slide'
  if (/(?:chart|plot|figure|fig|heatmap|scatter|bar|line|graph|科研|图表|柱状|折线)/i.test(searchable)) {
    return 'scientific_plot'
  }
  if (relative.startsWith('.sciforge/figures/')) return 'scientific_plot'
  return 'image'
}

function sourceToolForRecentArtifact(kind: SciforgeCanvasArtifactKind, relative: string): string {
  if (kind === 'scientific_plot') return 'scientific_plotting_or_workspace_import'
  if (kind === 'ppt_slide' || kind === 'ppt_export') return 'ppt_master_or_workspace_import'
  if (relative.startsWith('.sciforge/')) return 'sciforge_workspace_import'
  return 'workspace_artifact_import'
}

async function findRecentArtifactManifest(artifactPath: string): Promise<string | undefined> {
  const ext = extname(artifactPath)
  const base = artifactPath.slice(0, artifactPath.length - ext.length)
  for (const candidate of [`${base}.manifest.json`, `${base}.json`, join(dirname(artifactPath), 'manifest.json')]) {
    if (await fileExists(candidate)) return candidate
  }
  return undefined
}

function titleFromArtifactPath(artifactPath: string): string {
  return basename(artifactPath, extname(artifactPath)).replace(/[-_]+/g, ' ').trim() || basename(artifactPath)
}

function relativePath(root: string, target: string): string {
  return pathRelative(root, target).split('\\').join('/') || '.'
}

function artifactPathsInSnapshot(snapshot: TldrawSnapshot): Set<string> {
  const paths = new Set<string>()
  for (const record of Object.values(snapshot.store)) {
    if (record?.typeName !== 'shape') continue
    const artifact = asRecord(asRecord(record.meta)?.sciforgeArtifact)
    if (!artifact) continue
    for (const key of [
      'outputPath',
      'sourcePath',
      'previewPath',
      'renderedPagePath',
      'renderedFromPptxPath',
      'manifestPath',
      'styleSpecPath',
      'referencePath',
      'svgPath',
      'pptxPath'
    ]) {
      const value = artifact[key]
      if (typeof value === 'string' && value.trim()) paths.add(value)
    }
  }
  return paths
}

function buildReviewPacket(input: {
  canvasId: string
  title: string
  snapshot: TldrawSnapshot
  selection: SciforgeCanvasSelectionState
}): SciforgeCanvasReviewPacket {
  const artifacts = Object.values(input.snapshot.store)
    .filter((record) => record?.typeName === 'shape' && asRecord(record.meta)?.sciforgeCanvasArtifact === true)
    .map((shape) => {
      const meta = asRecord(shape.meta)
      const artifact = asRecord(meta?.sciforgeArtifact) as SciforgeCanvasArtifactMetadata
      return {
        ...artifact,
        shapeId: String(shape.id),
        bounds: pageBoundsForShape(input.snapshot.store, shape)
      }
    })
  const annotations = Object.values(input.snapshot.store)
    .filter((record) => record?.typeName === 'shape' && asRecord(record.meta)?.cowartAnnotationArrow === true)
    .map((shape) => {
      const meta = asRecord(shape.meta)
      const props = asRecord(shape.props)
      return {
        shapeId: String(shape.id),
        bounds: pageBoundsForShape(input.snapshot.store, shape),
        text: plainTextFromRichText(props?.richText),
        color: typeof props?.color === 'string' ? props.color : undefined,
        sourceShapeId: typeof meta?.cowartAnnotationSourceShapeId === 'string'
          ? meta.cowartAnnotationSourceShapeId
          : undefined
      }
    })
  const modificationSuggestions = buildModificationSuggestions({ artifacts, annotations })
  return {
    version: 1,
    tool: 'sciforge_canvas_export_review_packet',
    createdAt: new Date().toISOString(),
    canvasId: input.canvasId,
    title: input.title,
    artifacts,
    annotations,
    selectedShapes: input.selection.selectedShapes,
    modificationSuggestions,
    adjustmentRequests: artifacts.map((artifact) => ({
      artifactKind: artifact.artifactKind,
      shapeId: artifact.shapeId,
      nextControlledTool: nextControlledToolForArtifact(artifact.artifactKind),
      reason: reasonForAdjustment(artifact.artifactKind)
    })),
    guardrails: [
      'Canvas review packets are advisory and do not mutate original artifacts.',
      'Scientific plot adjustments should be applied through scientific_plotting_render.',
      'PPT adjustments should remain review annotations in v1 unless a later SVG white-list edit path is enabled.'
    ]
  }
}

function buildModificationSuggestions(input: {
  artifacts: Array<SciforgeCanvasArtifactMetadata & { shapeId: string; bounds?: SciforgeCanvasBounds | null }>
  annotations: Array<{
    shapeId: string
    bounds?: SciforgeCanvasBounds | null
    text?: string
    color?: string
    sourceShapeId?: string
  }>
}): SciforgeCanvasReviewPacket['modificationSuggestions'] {
  return input.annotations.map((annotation) => {
    const target = findAnnotationTargetArtifact(annotation, input.artifacts)
    const instruction = annotation.text?.trim() && annotation.text.trim() !== '批注'
      ? annotation.text.trim()
      : target
        ? `Review the annotated area on ${labelForArtifact(target)} and propose a controlled visual/content adjustment.`
        : 'Review this annotation and ask the user to attach it to a specific canvas artifact before applying changes.'
    return {
      annotationShapeId: annotation.shapeId,
      ...(target ? {
        targetShapeId: target.shapeId,
        artifactKind: target.artifactKind,
        ...(target.slideIndex !== undefined ? { slideIndex: target.slideIndex } : {}),
        nextControlledTool: nextControlledToolForArtifact(target.artifactKind),
        safety: safetyForModification(target.artifactKind)
      } : {
        nextControlledTool: 'sciforge_canvas_get_selection',
        safety: 'No source artifact is linked yet; keep this as a review note until the user selects or anchors the intended target.'
      }),
      instruction,
      status: 'draft'
    }
  })
}

function findAnnotationTargetArtifact(
  annotation: {
    sourceShapeId?: string
    bounds?: SciforgeCanvasBounds | null
  },
  artifacts: Array<SciforgeCanvasArtifactMetadata & { shapeId: string; bounds?: SciforgeCanvasBounds | null }>
): (SciforgeCanvasArtifactMetadata & { shapeId: string; bounds?: SciforgeCanvasBounds | null }) | null {
  if (annotation.sourceShapeId) {
    const direct = artifacts.find((artifact) => artifact.shapeId === annotation.sourceShapeId)
    if (direct) return direct
  }
  if (artifacts.length === 1) return artifacts[0]
  if (!annotation.bounds) return null
  const ranked = artifacts
    .filter((artifact) => artifact.bounds)
    .map((artifact) => ({
      artifact,
      distance: rectDistance(annotation.bounds!, artifact.bounds!)
    }))
    .sort((a, b) => a.distance - b.distance)
  return ranked[0]?.artifact ?? null
}

function labelForArtifact(artifact: SciforgeCanvasArtifactMetadata): string {
  if (artifact.artifactKind === 'ppt_slide' || artifact.artifactKind === 'ppt_export') {
    return artifact.slideIndex !== undefined ? `PPT slide ${artifact.slideIndex + 1}` : 'the PPT page'
  }
  if (artifact.artifactKind === 'scientific_plot') return 'the scientific plot'
  return 'the image artifact'
}

function safetyForModification(kind: SciforgeCanvasArtifactKind): string {
  if (kind === 'scientific_plot') return 'Use controlled plotting tools only; do not change data semantics.'
  if (kind === 'ppt_slide' || kind === 'ppt_export') return 'Keep this as a review packet in v1; do not automatically rewrite ppt-master source files.'
  return 'Create a new before/after artifact; do not overwrite the original.'
}

function nextControlledToolForArtifact(kind: SciforgeCanvasArtifactKind): string {
  if (kind === 'scientific_plot') return 'scientific_plotting_render'
  if (kind === 'ppt_slide' || kind === 'ppt_export') return 'ppt_master_review_or_regenerate'
  return 'sciforge_canvas_insert_artifact'
}

function reasonForAdjustment(kind: SciforgeCanvasArtifactKind): string {
  if (kind === 'scientific_plot') return 'Convert visual annotations into controlled style/layout changes without altering data semantics.'
  if (kind === 'ppt_slide' || kind === 'ppt_export') return 'Keep annotations as a review packet in v1; do not automatically rewrite ppt-master source files.'
  return 'Use as before/after visual context.'
}

function plainTextFromRichText(value: unknown): string | undefined {
  if (!value) return undefined
  if (typeof value === 'string') return value
  const text: string[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const record = node as JsonRecord
    if (typeof record.text === 'string') text.push(record.text)
    if (Array.isArray(record.content)) record.content.forEach(walk)
  }
  walk(value)
  const joined = text.join(' ').replace(/\s+/g, ' ').trim()
  return joined || undefined
}

function findPageId(snapshot: TldrawSnapshot): string | null {
  return Object.values(snapshot.store).find((record) => record?.typeName === 'page')?.id as string | null ?? null
}

function pageBoundsForShape(store: Record<string, JsonRecord>, shape: JsonRecord | null): SciforgeCanvasBounds | null {
  if (!shape || shape.typeName !== 'shape') return null
  const local = localBoundsForShape(shape)
  if (!local) return null
  let x = finiteNumber(shape.x, 0) + local.x
  let y = finiteNumber(shape.y, 0) + local.y
  let parent = store[String(shape.parentId ?? '')]
  const visited = new Set([String(shape.id)])
  while (parent?.typeName === 'shape' && !visited.has(String(parent.id))) {
    visited.add(String(parent.id))
    x += finiteNumber(parent.x, 0)
    y += finiteNumber(parent.y, 0)
    parent = store[String(parent.parentId ?? '')]
  }
  return { x, y, w: local.w, h: local.h }
}

function localBoundsForShape(shape: JsonRecord): SciforgeCanvasBounds | null {
  if (!shape || shape.typeName !== 'shape') return null
  const props = asRecord(shape.props)
  if (shape.type === 'arrow') {
    const start = asRecord(props?.start) ?? { x: 0, y: 0 }
    const end = asRecord(props?.end) ?? { x: 1, y: 0 }
    const minX = Math.min(finiteNumber(start.x, 0), finiteNumber(end.x, 0))
    const minY = Math.min(finiteNumber(start.y, 0), finiteNumber(end.y, 0))
    const maxX = Math.max(finiteNumber(start.x, 0), finiteNumber(end.x, 0))
    const maxY = Math.max(finiteNumber(start.y, 0), finiteNumber(end.y, 0))
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
  }
  return {
    x: 0,
    y: 0,
    w: finiteNumber(props?.w, shape.type === 'text' ? 160 : 1),
    h: finiteNumber(props?.h, shape.type === 'text' ? 40 : 1)
  }
}

function choosePlacement(input: {
  store: Record<string, JsonRecord>
  pageId: string
  parentId: string
  anchorShape: JsonRecord | null
  width: number
  height: number
  margin: number
  placement: 'right' | 'left' | 'below'
}): SciforgeCanvasBounds {
  const anchorBounds = pageBoundsForShape(input.store, input.anchorShape)
  let x = anchorBounds ? anchorBounds.x + anchorBounds.w + input.margin : 0
  let y = anchorBounds ? anchorBounds.y : 0
  if (input.placement === 'left' && anchorBounds) x = anchorBounds.x - input.width - input.margin
  if (input.placement === 'below' && anchorBounds) {
    x = anchorBounds.x
    y = anchorBounds.y + anchorBounds.h + input.margin
  }
  const obstacles = getPageShapes(input.store, input.pageId)
    .filter((shape) => shape.parentId === input.parentId && shape.id !== input.anchorShape?.id)
    .map((shape) => pageBoundsForShape(input.store, shape))
    .filter((bounds): bounds is SciforgeCanvasBounds => Boolean(bounds))
  const stepX = Math.max(input.width + input.margin, 1)
  const stepY = Math.max(input.height + input.margin, 1)
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = { x, y, w: input.width, h: input.height }
    if (!obstacles.some((bounds) => rectsOverlap(candidate, bounds, input.margin / 2))) return candidate
    if (input.placement === 'below') y += stepY
    else if (input.placement === 'left') x -= stepX
    else x += stepX
  }
  return { x, y, w: input.width, h: input.height }
}

function getPageShapes(store: Record<string, JsonRecord>, pageId: string): JsonRecord[] {
  const shapes: JsonRecord[] = []
  const byParent = new Map<string, JsonRecord[]>()
  for (const record of Object.values(store)) {
    if (record?.typeName !== 'shape') continue
    const parentId = String(record.parentId ?? '')
    byParent.set(parentId, [...(byParent.get(parentId) ?? []), record])
  }
  const queue = [...(byParent.get(pageId) ?? [])]
  while (queue.length > 0) {
    const shape = queue.shift()!
    shapes.push(shape)
    queue.push(...(byParent.get(String(shape.id)) ?? []))
  }
  return shapes
}

function rectsOverlap(a: SciforgeCanvasBounds, b: SciforgeCanvasBounds, padding = 0): boolean {
  return !(
    a.x + a.w + padding <= b.x ||
    b.x + b.w + padding <= a.x ||
    a.y + a.h + padding <= b.y ||
    b.y + b.h + padding <= a.y
  )
}

function rectDistance(a: SciforgeCanvasBounds, b: SciforgeCanvasBounds): number {
  if (rectsOverlap(a, b)) return 0
  const ax = a.x + a.w / 2
  const ay = a.y + a.h / 2
  const bx = b.x + b.w / 2
  const by = b.y + b.h / 2
  return Math.hypot(ax - bx, ay - by)
}

function chooseIndex(store: Record<string, JsonRecord>, parentId: string): string {
  const indexes = Object.values(store)
    .filter((record) => record?.typeName === 'shape' && record.parentId === parentId && typeof record.index === 'string')
    .map((record) => String(record.index))
    .sort()
  return generateKeyBetween(indexes.at(-1) ?? null, null)
}

function uniqueRecordId(store: Record<string, JsonRecord>, prefix: 'shape' | 'asset', seed: string): string {
  const cleanSeed = sanitizeId(seed.replace(/\.[^.]+$/, ''), prefix)
  let candidate = `${prefix}:${cleanSeed}`
  let counter = 2
  while (store[candidate]) {
    candidate = `${prefix}:${cleanSeed}-${counter}`
    counter += 1
  }
  return candidate
}

async function uniqueFilePath(dir: string, requestedName: string): Promise<{ fileName: string; filePath: string }> {
  const safeName = sanitizeFileName(requestedName)
  const ext = extname(safeName)
  const base = safeName.slice(0, safeName.length - ext.length)
  let candidate = safeName
  let counter = 2
  while (true) {
    const filePath = join(dir, candidate)
    if (!(await fileExists(filePath))) return { fileName: candidate, filePath }
    candidate = `${base}-v${counter}${ext}`
    counter += 1
  }
}

function sanitizeFileName(name: string): string {
  const rawName = basename(name || 'artifact')
  const extension = extname(rawName) || '.png'
  const base = rawName
    .slice(0, rawName.length - extname(rawName).length)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base || 'artifact'}${extension}`
}

function readImageDimensions(filePath: string, buffer: Buffer): ImageDimensions {
  const ext = extensionFromName(filePath)
  if (ext === '.png' && buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if ((ext === '.jpg' || ext === '.jpeg') && buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) break
      const marker = buffer[offset + 1]
      const size = buffer.readUInt16BE(offset + 2)
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
      }
      offset += 2 + size
    }
  }
  if (ext === '.webp' && buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    if (buffer.toString('ascii', 12, 16) === 'VP8X') {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
    }
  }
  if (ext === '.svg') {
    const text = buffer.toString('utf8', 0, Math.min(buffer.length, 20_000))
    const width = parseSvgLength(text.match(/\bwidth=["']?([0-9.]+)/i)?.[1])
    const height = parseSvgLength(text.match(/\bheight=["']?([0-9.]+)/i)?.[1])
    if (width && height) return { width, height }
    const viewBox = text.match(/\bviewBox=["']?([0-9.\s-]+)/i)?.[1]?.trim().split(/\s+/).map(Number)
    if (viewBox && viewBox.length === 4 && Number.isFinite(viewBox[2]) && Number.isFinite(viewBox[3])) {
      return { width: Math.max(1, Math.round(viewBox[2])), height: Math.max(1, Math.round(viewBox[3])) }
    }
  }
  return { width: DEFAULT_IMAGE_WIDTH, height: Math.round(DEFAULT_IMAGE_WIDTH * 0.62) }
}

function parseSvgLength(raw: string | undefined): number | null {
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

function mimeTypeForExtension(ext: string): string | null {
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    default:
      return null
  }
}

async function renderPptxSlidePreview(input: {
  pptxPath: string
  slideIndex: number
  paths: CanvasPaths
}): Promise<PptxPreviewResult> {
  const tools = await detectPptRenderTools()
  let officeError: Error | null = null
  if (tools.sofficePath && tools.pdftoppmPath) {
    try {
      return await renderPptxSlidePreviewWithOffice(input, tools.sofficePath, tools.pdftoppmPath)
    } catch (error) {
      officeError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (tools.qlmanagePath) {
    try {
      return await renderPptxSlidePreviewWithQuickLook(input, tools.qlmanagePath)
    } catch (quickLookError) {
      if (officeError) {
        throw new Error(`LibreOffice preview failed: ${officeError.message}\nQuickLook preview failed: ${quickLookError instanceof Error ? quickLookError.message : String(quickLookError)}`)
      }
      throw quickLookError
    }
  }

  if (officeError) throw officeError
  throw new Error('requires soffice/libreoffice + pdftoppm, or macOS qlmanage for first-slide preview.')
}

async function renderPptxSlidePreviewWithOffice(
  input: {
    pptxPath: string
    slideIndex: number
    paths: CanvasPaths
  },
  sofficePath: string,
  pdftoppmPath: string
): Promise<PptxPreviewResult> {
  const render = await buildPptRenderPaths(input, 'office')
  if (await fileExists(render.pngPath)) {
    return {
      pngPath: render.pngPath,
      pdfPath: render.pdfPath,
      slideIndex: input.slideIndex,
      pageNumber: render.pageNumber
    }
  }

  await mkdir(render.renderDir, { recursive: true })
  await runBinary(sofficePath, [
    '--headless',
    '--convert-to',
    'pdf',
    '--outdir',
    render.renderDir,
    input.pptxPath
  ])

  const generatedPdf = await findFirstFileWithExtension(render.renderDir, '.pdf')
  if (!generatedPdf) throw new Error('soffice did not produce a PDF preview.')

  const prefix = join(render.renderDir, 'slide')
  await runBinary(pdftoppmPath, [
    '-png',
    '-r',
    String(PPT_PREVIEW_DPI),
    '-f',
    String(render.pageNumber),
    '-l',
    String(render.pageNumber),
    generatedPdf,
    prefix
  ])

  const generatedPng = await findGeneratedPng(render.renderDir)
  if (!generatedPng) throw new Error(`pdftoppm did not produce a PNG for slide ${render.pageNumber}.`)
  if (generatedPng !== render.pngPath) await rename(generatedPng, render.pngPath)
  return {
    pngPath: render.pngPath,
    pdfPath: generatedPdf,
    slideIndex: input.slideIndex,
    pageNumber: render.pageNumber
  }
}

async function renderPptxSlidePreviewWithQuickLook(
  input: {
    pptxPath: string
    slideIndex: number
    paths: CanvasPaths
  },
  qlmanagePath: string
): Promise<PptxPreviewResult> {
  if (input.slideIndex > 0) {
    throw new Error('QuickLook fallback only supports first-slide PPTX preview.')
  }
  const render = await buildPptRenderPaths(input, 'quicklook')
  if (await fileExists(render.pngPath)) {
    return {
      pngPath: render.pngPath,
      pdfPath: render.pdfPath,
      slideIndex: input.slideIndex,
      pageNumber: render.pageNumber
    }
  }

  await mkdir(render.renderDir, { recursive: true })
  await runBinary(qlmanagePath, [
    '-t',
    '-s',
    '1200',
    '-o',
    render.renderDir,
    input.pptxPath
  ])

  const generatedPng = await findGeneratedPng(render.renderDir)
  if (!generatedPng) throw new Error('qlmanage did not produce a PNG thumbnail.')
  if (generatedPng !== render.pngPath) await rename(generatedPng, render.pngPath)
  return {
    pngPath: render.pngPath,
    pdfPath: render.pdfPath,
    slideIndex: input.slideIndex,
    pageNumber: render.pageNumber
  }
}

async function buildPptRenderPaths(
  input: {
    pptxPath: string
    slideIndex: number
    paths: CanvasPaths
  },
  renderer: 'office' | 'quicklook'
): Promise<{
  renderDir: string
  pdfPath: string
  pngPath: string
  pageNumber: number
}> {
  const pptxInfo = await stat(input.pptxPath)
  if (!pptxInfo.isFile()) throw new Error(`PPTX path is not a file: ${input.pptxPath}`)

  const pageNumber = input.slideIndex + 1
  const basenameWithoutExt = basename(input.pptxPath, extname(input.pptxPath))
  const renderHash = createHash('sha1')
    .update(`${input.pptxPath}:${pptxInfo.mtimeMs}:${pptxInfo.size}:${pageNumber}:${renderer}`)
    .digest('hex')
    .slice(0, 12)
  const renderDir = join(
    input.paths.rendersDir,
    `${sanitizeId(basenameWithoutExt, 'deck')}-slide-${pageNumber}-${renderer}-${renderHash}`
  )
  return {
    renderDir,
    pdfPath: join(renderDir, `${basenameWithoutExt}.pdf`),
    pngPath: join(renderDir, `slide-${String(pageNumber).padStart(2, '0')}.png`),
    pageNumber
  }
}

async function detectPptRenderTools(): Promise<PptRenderTools> {
  if (process.env.SCIFORGE_CANVAS_DISABLE_PPT_RENDER === '1') return {}
  const sofficePath = await findExecutable([
    process.env.SCIFORGE_SOFFICE_BIN,
    process.env.SOFFICE_BIN,
    ...pathExecutableCandidates('soffice'),
    ...pathExecutableCandidates('libreoffice'),
    '/Applications/LibreOffice.app/Contents/MacOS/soffice'
  ])
  const pdftoppmPath = await findExecutable([
    process.env.SCIFORGE_PDFTOPPM_BIN,
    process.env.PDFTOPPM_BIN,
    ...pathExecutableCandidates('pdftoppm'),
    '/opt/homebrew/bin/pdftoppm',
    '/usr/local/bin/pdftoppm'
  ])
  const qlmanagePath = await findExecutable([
    process.env.SCIFORGE_QLMANAGE_BIN,
    process.env.QLMANAGE_BIN,
    ...pathExecutableCandidates('qlmanage'),
    '/usr/bin/qlmanage'
  ])
  return {
    ...(sofficePath ? { sofficePath } : {}),
    ...(pdftoppmPath ? { pdftoppmPath } : {}),
    ...(qlmanagePath ? { qlmanagePath } : {})
  }
}

function pathExecutableCandidates(name: string): string[] {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, name))
}

async function findExecutable(candidates: Array<string | undefined>): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Try next candidate.
    }
  }
  return undefined
}

async function runBinary(command: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(command, args, {
      timeout: PPT_RENDER_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024
    })
  } catch (error) {
    if (error && typeof error === 'object') {
      const record = error as { message?: string; stdout?: string; stderr?: string }
      const tail = [record.stdout, record.stderr]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.slice(-800))
        .join('\n')
      throw new Error(`${record.message ?? 'command failed'}${tail ? `\n${tail}` : ''}`)
    }
    throw error
  }
}

async function findFirstFileWithExtension(dir: string, extension: string): Promise<string | null> {
  const entries = await readdir(dir)
  const match = entries.find((entry) => extensionFromName(entry) === extension)
  return match ? join(dir, match) : null
}

async function findGeneratedPng(dir: string): Promise<string | null> {
  const entries = await readdir(dir)
  const pngs = entries
    .filter((entry) => extensionFromName(entry) === '.png')
    .sort((a, b) => a.localeCompare(b))
  return pngs[0] ? join(dir, pngs[0]) : null
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tempFile = `${filePath}.${process.pid}.${createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 8)}.tmp`
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tempFile, filePath)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' ? value as JsonRecord : null
}

function statusForInsertError(message: string): Extract<SciforgeCanvasInsertArtifactResult, { ok: false }>['status'] {
  if (message.includes('workspace')) return 'invalid_workspace'
  if (message.includes('not found') || message.includes('ENOENT')) return 'artifact_not_found'
  if (message.includes('Unsupported') || message.includes('display')) return 'unsupported_artifact'
  if (message.includes('write') || message.includes('save')) return 'canvas_write_failed'
  return 'invalid_request'
}

export const _sciforgeCanvasInternals = {
  createInitialCanvasSnapshot,
  readImageDimensions,
  sanitizeId,
  choosePlacement,
  pageBoundsForShape,
  buildReviewPacket,
  CANVAS_ROOT_RELATIVE
}
