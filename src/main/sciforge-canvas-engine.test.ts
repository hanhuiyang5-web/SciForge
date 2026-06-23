import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  exportSciforgeCanvasReviewPacket,
  importRecentSciforgeCanvasArtifacts,
  insertSciforgeCanvasArtifact,
  openOrCreateSciforgeCanvas,
  saveSciforgeCanvasSelection
} from './sciforge-canvas-engine'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJHeWQAAAABJRU5ErkJggg==',
  'base64'
)

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sciforge-canvas-test-'))
}

describe('SciForge Canvas engine', () => {
  it('creates a workspace canvas and inserts a scientific plot artifact with Cowart-compatible metadata', async () => {
    const workspaceRoot = await makeWorkspace()
    const plotPath = join(workspaceRoot, 'plot.png')
    const manifestPath = join(workspaceRoot, 'plot.manifest.json')
    await writeFile(plotPath, PNG_1X1)
    await writeFile(manifestPath, JSON.stringify({
      tool: 'scientific_plotting_render',
      outputPath: plotPath
    }))

    const opened = await openOrCreateSciforgeCanvas({ workspaceRoot, canvasId: 'paper-review' })
    expect(opened.ok).toBe(true)

    const inserted = await insertSciforgeCanvasArtifact({
      workspaceRoot,
      canvasId: 'paper-review',
      artifactKind: 'scientific_plot',
      outputPath: plotPath,
      manifestPath,
      styleSpecPath: manifestPath,
      referencePath: plotPath,
      reviewScore: {
        overall: 0.82,
        palette: 0.9,
        background: 0.95,
        axes: 0.7,
        grid: 0.8,
        layout: 0.84,
        marks: 0.77,
        warnings: ['axis weight differs']
      },
      title: 'Styled plot'
    })
    expect(inserted.ok).toBe(true)
    if (!inserted.ok) return
    expect(inserted.artifact.artifactKind).toBe('scientific_plot')
    expect(inserted.assetFile).toBeTruthy()
    await expect(stat(inserted.assetFile!)).resolves.toMatchObject({ size: PNG_1X1.length })

    const snapshot = JSON.parse(await readFile(inserted.canvasPath, 'utf8'))
    const shape = snapshot.store[inserted.shapeId]
    expect(shape.meta.sciforgeCanvasArtifact).toBe(true)
    expect(shape.meta.sciforgeArtifact.outputPath).toMatch(/plot\.png$/)
    expect(shape.meta.sciforgeArtifact.reviewScore.overall).toBe(0.82)
  })

  it('exports selected annotations and controlled next-tool recommendations', async () => {
    const workspaceRoot = await makeWorkspace()
    const plotPath = join(workspaceRoot, 'plot.png')
    await writeFile(plotPath, PNG_1X1)
    const inserted = await insertSciforgeCanvasArtifact({
      workspaceRoot,
      artifactKind: 'scientific_plot',
      outputPath: plotPath
    })
    expect(inserted.ok).toBe(true)
    if (!inserted.ok) return

    const snapshot = JSON.parse(await readFile(inserted.canvasPath, 'utf8'))
    snapshot.store['shape:annotation'] = {
      id: 'shape:annotation',
      typeName: 'shape',
      type: 'arrow',
      parentId: 'page:sciforge-canvas',
      index: 'b1',
      x: 12,
      y: 20,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {
        cowartAnnotationArrow: true,
        cowartAnnotationSourceShapeId: inserted.shapeId
      },
      props: {
        start: { x: 0, y: 0 },
        end: { x: 80, y: 20 },
        color: 'red',
        richText: { type: 'doc', content: [{ type: 'text', text: 'reduce marker size' }] }
      }
    }
    await writeFile(inserted.canvasPath, `${JSON.stringify(snapshot, null, 2)}\n`)
    await saveSciforgeCanvasSelection({
      workspaceRoot,
      selection: {
        selectedShapes: [{
          id: inserted.shapeId,
          type: 'image',
          isAiImageHolder: false
        }],
        updatedAt: '2026-06-22T00:00:00.000Z'
      }
    })

    const packet = await exportSciforgeCanvasReviewPacket({ workspaceRoot, title: 'Review' })
    expect(packet.ok).toBe(true)
    if (!packet.ok) return
    expect(packet.packet.artifacts).toHaveLength(1)
    expect(packet.packet.annotations[0]?.text).toBe('reduce marker size')
    expect(packet.packet.adjustmentRequests[0]).toMatchObject({
      artifactKind: 'scientific_plot',
      nextControlledTool: 'scientific_plotting_render'
    })
    expect(packet.packet.modificationSuggestions[0]).toMatchObject({
      annotationShapeId: 'shape:annotation',
      targetShapeId: inserted.shapeId,
      artifactKind: 'scientific_plot',
      instruction: 'reduce marker size',
      nextControlledTool: 'scientific_plotting_render',
      status: 'draft'
    })
  })

  it('sanitizes legacy arrow props before returning canvas snapshots', async () => {
    const workspaceRoot = await makeWorkspace()
    const plotPath = join(workspaceRoot, 'plot.png')
    await writeFile(plotPath, PNG_1X1)
    const inserted = await insertSciforgeCanvasArtifact({
      workspaceRoot,
      artifactKind: 'scientific_plot',
      outputPath: plotPath
    })
    expect(inserted.ok).toBe(true)
    if (!inserted.ok) return

    const snapshot = JSON.parse(await readFile(inserted.canvasPath, 'utf8'))
    snapshot.store['shape:legacy-annotation'] = {
      id: 'shape:legacy-annotation',
      typeName: 'shape',
      type: 'arrow',
      parentId: 'page:sciforge-canvas',
      index: 'b1',
      x: 12,
      y: 20,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {
        cowartAnnotationArrow: true,
        cowartAnnotationSourceShapeId: inserted.shapeId
      },
      props: {
        start: { type: 'point', x: 0, y: 0 },
        end: { type: 'point', x: 80, y: 20 },
        color: 'red',
        text: 'tighten layout'
      }
    }
    await writeFile(inserted.canvasPath, `${JSON.stringify(snapshot, null, 2)}\n`)

    const opened = await openOrCreateSciforgeCanvas({ workspaceRoot })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const openedSnapshot = opened.snapshot as { store: Record<string, { props?: Record<string, unknown> }> }
    const arrow = openedSnapshot.store['shape:legacy-annotation']
    const arrowProps = arrow.props ?? {}
    expect(arrowProps).not.toHaveProperty('text')
    expect(arrowProps.start as Record<string, unknown>).not.toHaveProperty('type')
    expect(arrowProps.end as Record<string, unknown>).not.toHaveProperty('type')
    expect(arrowProps.elbowMidPoint).toBe(0.5)

    const packet = await exportSciforgeCanvasReviewPacket({ workspaceRoot, title: 'Review' })
    expect(packet.ok).toBe(true)
    if (!packet.ok) return
    expect(packet.packet.modificationSuggestions[0]).toMatchObject({
      instruction: 'tighten layout',
      nextControlledTool: 'scientific_plotting_render'
    })
  })

  it('renders PPTX export pages into canvas previews when local office tools are available', async () => {
    const workspaceRoot = await makeWorkspace()
    const deckDir = join(workspaceRoot, 'deck')
    const binDir = join(workspaceRoot, 'bin')
    await mkdir(deckDir)
    await mkdir(binDir)
    const pptxPath = join(workspaceRoot, 'deck.pptx')
    await writeFile(pptxPath, 'pptx-bytes')

    const fakeSoffice = join(binDir, 'soffice')
    const fakePdftoppm = join(binDir, 'pdftoppm')
    await writeFile(fakeSoffice, `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
const outDir = args[args.indexOf('--outdir') + 1]
const source = args.at(-1)
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, path.basename(source, path.extname(source)) + '.pdf'), '%PDF-1.4\\n')
`)
    await writeFile(fakePdftoppm, `#!/usr/bin/env node
const fs = require('fs')
const png = '${PNG_1X1.toString('base64')}'
const prefix = process.argv.at(-1)
fs.writeFileSync(prefix + '-1.png', Buffer.from(png, 'base64'))
`)
    await chmod(fakeSoffice, 0o755)
    await chmod(fakePdftoppm, 0o755)

    const previousSoffice = process.env.SCIFORGE_SOFFICE_BIN
    const previousPdftoppm = process.env.SCIFORGE_PDFTOPPM_BIN
    const previousDisable = process.env.SCIFORGE_CANVAS_DISABLE_PPT_RENDER
    process.env.SCIFORGE_SOFFICE_BIN = fakeSoffice
    process.env.SCIFORGE_PDFTOPPM_BIN = fakePdftoppm
    delete process.env.SCIFORGE_CANVAS_DISABLE_PPT_RENDER
    try {
      const inserted = await insertSciforgeCanvasArtifact({
        workspaceRoot,
        artifactKind: 'ppt_export',
        pptxPath,
        projectPath: deckDir,
        slideIndex: 2,
        title: 'Exported deck'
      })
      expect(inserted.ok).toBe(true)
      if (!inserted.ok) return
      expect(inserted.assetId).toBeTruthy()
      expect(inserted.assetFile).toBeTruthy()
      expect(inserted.artifact.previewPath).toMatch(/slide-03\.png$/)
      expect(inserted.artifact.renderedSlideIndex).toBe(2)
      expect(inserted.warnings.join('\n')).toContain('rendered to PNG preview')
      const snapshot = JSON.parse(await readFile(inserted.canvasPath, 'utf8'))
      expect(snapshot.store[inserted.shapeId].type).toBe('image')
      expect(snapshot.store[inserted.shapeId].meta.sciforgeArtifact.renderedPagePath).toMatch(/slide-03\.png$/)
    } finally {
      restoreEnv('SCIFORGE_SOFFICE_BIN', previousSoffice)
      restoreEnv('SCIFORGE_PDFTOPPM_BIN', previousPdftoppm)
      restoreEnv('SCIFORGE_CANVAS_DISABLE_PPT_RENDER', previousDisable)
    }
  })

  it('imports recent workspace plot and PPTX artifacts into the canvas', async () => {
    const workspaceRoot = await makeWorkspace()
    const plotPath = join(workspaceRoot, 'financial_chart.png')
    const pptxPath = join(workspaceRoot, '年度总结报告.pptx')
    await writeFile(plotPath, PNG_1X1)
    await writeFile(pptxPath, 'pptx-bytes')

    const previousDisable = process.env.SCIFORGE_CANVAS_DISABLE_PPT_RENDER
    process.env.SCIFORGE_CANVAS_DISABLE_PPT_RENDER = '1'
    try {
      const imported = await importRecentSciforgeCanvasArtifacts({
        workspaceRoot,
        limit: 5
      })
      expect(imported.ok).toBe(true)
      if (!imported.ok) return
      expect(imported.imported).toBe(2)
      expect(imported.artifacts.map((artifact) => artifact.artifactKind).sort()).toEqual([
        'ppt_export',
        'scientific_plot'
      ])

      const snapshot = JSON.parse(await readFile(imported.canvasPath, 'utf8'))
      const shapes = Object.values(snapshot.store as Record<string, any>)
        .filter((record) => record.typeName === 'shape' && record.meta?.sciforgeCanvasArtifact)
      expect(shapes).toHaveLength(2)
      expect(shapes.some((shape) => String(shape.meta.sciforgeArtifact.outputPath).endsWith('financial_chart.png'))).toBe(true)
      expect(shapes.some((shape) => String(shape.meta.sciforgeArtifact.pptxPath).endsWith('年度总结报告.pptx'))).toBe(true)

      const second = await importRecentSciforgeCanvasArtifacts({
        workspaceRoot,
        limit: 5
      })
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.imported).toBe(0)
    } finally {
      restoreEnv('SCIFORGE_CANVAS_DISABLE_PPT_RENDER', previousDisable)
    }
  })

  it('represents PPTX exports as placeholders without requiring slide rendering', async () => {
    const workspaceRoot = await makeWorkspace()
    const deckDir = join(workspaceRoot, 'deck')
    await mkdir(deckDir)
    const pptxPath = join(workspaceRoot, 'deck.pptx')
    await writeFile(pptxPath, 'pptx-bytes')

    const previousDisable = process.env.SCIFORGE_CANVAS_DISABLE_PPT_RENDER
    process.env.SCIFORGE_CANVAS_DISABLE_PPT_RENDER = '1'
    try {
      const inserted = await insertSciforgeCanvasArtifact({
        workspaceRoot,
        artifactKind: 'ppt_export',
        pptxPath,
        projectPath: deckDir,
        title: 'Exported deck'
      })
      expect(inserted.ok).toBe(true)
      if (!inserted.ok) return
      expect(inserted.assetId).toBeUndefined()
      expect(inserted.artifact.artifactKind).toBe('ppt_export')
      const snapshot = JSON.parse(await readFile(inserted.canvasPath, 'utf8'))
      expect(snapshot.store[inserted.shapeId].type).toBe('frame')
      expect(snapshot.store[inserted.shapeId].meta.sciforgeCanvasPlaceholder).toBe(true)
    } finally {
      restoreEnv('SCIFORGE_CANVAS_DISABLE_PPT_RENDER', previousDisable)
    }
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
