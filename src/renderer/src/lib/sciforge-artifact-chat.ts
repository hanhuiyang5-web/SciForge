import {
  mergeMcpJsonConfig,
  type JsonRecord
} from './mcp-config'
import { isPptDeckRequest } from './ppt-master-chat'

export const SCIENTIFIC_PLOTTING_MCP_SERVER_ID = 'scientific_plotting'
export const SCIFORGE_CANVAS_MCP_SERVER_ID = 'sciforge_canvas'

type McpConfigResult =
  | { ok: true; config: JsonRecord }
  | { ok: false; message: string }

export type SciforgeArtifactMcpBootstrapInput = {
  text: string
  workspaceRoot?: string
  readConfig: () => Promise<{ content: string }>
  writeConfig: (content: string) => Promise<unknown>
  buildScientificPlottingConfig?: (workspaceRoot?: string) => Promise<McpConfigResult>
  buildSciforgeCanvasConfig?: (workspaceRoot?: string) => Promise<McpConfigResult>
  getToolDiagnostics?: () => Promise<{ mcpServers?: Array<Record<string, unknown>> } | null | undefined>
  waitTimeoutMs?: number
  pollIntervalMs?: number
}

export type SciforgeArtifactMcpBootstrapResult =
  | { status: 'skipped' }
  | { status: 'configured'; runtimeConnected: boolean; serverIds: string[] }
  | { status: 'unavailable'; message: string; serverIds: string[] }

const PLOT_REQUEST_RE =
  /(?:画|绘制|生成|创建|做|输出|plot|chart|figure|visuali[sz]e|draw|render).{0,32}(?:图|图表|数据图|科研图|柱状图|折线图|散点图|热图|plot|chart|figure|visualization)|(?:图|图表|数据图|科研图|柱状图|折线图|散点图|热图|plot|chart|figure).{0,32}(?:画|绘制|生成|创建|做|输出|plot|chart|figure|visuali[sz]e|draw|render)/i
const CANVAS_REVIEW_REQUEST_RE =
  /(?:按|按照|根据|基于|应用|处理|使用).{0,24}(?:标注|批注|注释|审改|画布|canvas).{0,40}(?:修改|改|调整|修订|重绘|更新|应用|生成|revision|revise|edit|update)|(?:修改|改|调整|修订|重绘|更新|revision|revise|edit|update).{0,40}(?:标注|批注|注释|审改|画布|canvas)|(?:标注|批注|注释|审改|画布|canvas).{0,40}(?:修改|改|调整|修订|重绘|更新|应用|生成|revision|revise|edit|update)/i
const IMAGE_LIKE_RE = /(?:图|图片|图表|科研图|plot|chart|figure|image|visualization)/i

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isScientificPlottingRequest(text: string): boolean {
  return PLOT_REQUEST_RE.test(text.trim())
}

export function isCanvasReviewRequest(text: string): boolean {
  return CANVAS_REVIEW_REQUEST_RE.test(text.trim())
}

export function shouldUseSciforgeArtifactFlow(text: string): boolean {
  return isScientificPlottingRequest(text) || isPptDeckRequest(text) || isCanvasReviewRequest(text)
}

export function buildSciforgeArtifactFlowPrompt(text: string): string {
  if (!shouldUseSciforgeArtifactFlow(text)) return text
  const isReviewRequest = isCanvasReviewRequest(text)
  const canvasReviewInstructions = isReviewRequest
    ? [
        '',
        '[SciForge Canvas review workflow]',
        '',
        '- Treat this as a canvas annotation/revision request.',
        '- First call `sciforge_canvas_get_selection`, then call `sciforge_canvas_export_review_packet` even when the visible selection is empty.',
        '- Use `modificationSuggestions`, `annotations`, and artifact metadata from the review packet to decide the target and next controlled tool.',
        '- Do not answer by only listing workspace files, and do not ask what to do next when the review packet contains annotations or modification suggestions.',
        '- For scientific/data plot or image artifacts, create a revised artifact as a new version, preserve the original, then insert the revised output beside the original with `sciforge_canvas_insert_artifact`.',
        '- For PPT artifacts, use the available `ppt_master_*` workflow when a structured PPT edit path exists; otherwise export the review packet and explain the specific PPT edit that still needs a controlled adapter.',
        '- If the annotation target is ambiguous, state exactly which annotation could not be matched and what selection is needed.'
      ]
    : []
  return [
    '[SciForge artifact workflow]',
    '',
    '- For structured scientific/data figures, prefer the `scientific_plotting_*` MCP tools over ad-hoc plotting scripts when those tools are available.',
    '- For PPT/presentation work, prefer the `ppt_master_*` MCP tools over hand-written python-pptx scripts when those tools are available.',
    '- Treat ppt-master skill implementation files under `~/.codex/skills/ppt-master/scripts/` as private implementation details. Do not read, cat, copy, or inspect those script files; use the `ppt_master_*` MCP tools and project files inside the workspace instead.',
    '- If `ppt_master_split_notes` reports missing notes for an SVG page, repair the workspace project notes mapping or `notes/total.md` slide headings to match `svg_output/*.svg`, then run `ppt_master_split_notes` once more. Do not investigate the splitter script.',
    '- If `ppt_master_quality_check` returns a non-zero exit code or reports `[ERROR]`, repair the workspace SVG files and rerun `ppt_master_quality_check` before `ppt_master_finalize_svg` or `ppt_master_export_pptx`. For example, replace forbidden `rgba()` colors with solid hex colors plus `fill-opacity`/`stroke-opacity`.',
    '- When a PPT deck has generated SVG pages, continue through `ppt_master_split_notes`, `ppt_master_quality_check`, `ppt_master_finalize_svg`, `ppt_master_export_pptx`, and then insert the final PPT/SVG artifact into SciForge Canvas.',
    '- After producing PNG/SVG/PPTX artifacts, place them on the SciForge Canvas with `sciforge_canvas_insert_artifact`.',
    '- If artifacts were produced outside the controlled MCP tools, call `sciforge_canvas_import_recent_artifacts` to import the latest workspace outputs before replying.',
    '- Keep original artifacts unchanged; use the canvas for review, annotations, before/after comparison, and review packet export.',
    ...canvasReviewInstructions,
    '',
    '---',
    '[Current user request]',
    text
  ].join('\n')
}

export async function ensureSciforgeArtifactMcpsForChat(
  input: SciforgeArtifactMcpBootstrapInput
): Promise<SciforgeArtifactMcpBootstrapResult> {
  const needsCanvasReview = isCanvasReviewRequest(input.text)
  const needsPlotting = isScientificPlottingRequest(input.text) ||
    (needsCanvasReview && IMAGE_LIKE_RE.test(input.text))
  const needsCanvas = needsPlotting || isPptDeckRequest(input.text) || needsCanvasReview
  const serverIds = [
    ...(needsPlotting ? [SCIENTIFIC_PLOTTING_MCP_SERVER_ID] : []),
    ...(needsCanvas ? [SCIFORGE_CANVAS_MCP_SERVER_ID] : [])
  ]
  if (serverIds.length === 0) return { status: 'skipped' }

  const missingBuilders: string[] = []
  if (needsPlotting && !input.buildScientificPlottingConfig) missingBuilders.push(SCIENTIFIC_PLOTTING_MCP_SERVER_ID)
  if (needsCanvas && !input.buildSciforgeCanvasConfig) missingBuilders.push(SCIFORGE_CANVAS_MCP_SERVER_ID)
  if (missingBuilders.length > 0) {
    return {
      status: 'unavailable',
      serverIds,
      message: `Missing MCP config bridge for ${missingBuilders.join(', ')}.`
    }
  }

  const current = await input.readConfig()
  let nextConfig = current.content
  let changed = false

  for (const buildConfig of [
    needsPlotting ? input.buildScientificPlottingConfig : undefined,
    needsCanvas ? input.buildSciforgeCanvasConfig : undefined
  ]) {
    if (!buildConfig) continue
    const result = await buildConfig(input.workspaceRoot?.trim() || undefined)
    if (!result.ok) {
      return {
        status: 'unavailable',
        serverIds,
        message: result.message
      }
    }
    const merged = mergeMcpJsonConfig(nextConfig, result.config)
    nextConfig = merged.text
    changed = changed || merged.changed
  }

  if (changed) await input.writeConfig(nextConfig)

  const runtimeConnected = input.getToolDiagnostics
    ? await waitForMcpServers(input, serverIds)
    : true

  return {
    status: 'configured',
    runtimeConnected,
    serverIds
  }
}

async function waitForMcpServers(
  input: SciforgeArtifactMcpBootstrapInput,
  serverIds: string[]
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, input.waitTimeoutMs ?? 45_000)
  const pollIntervalMs = Math.max(250, input.pollIntervalMs ?? 1_000)
  do {
    try {
      if (diagnosticsHaveConnectedServers(await input.getToolDiagnostics?.(), serverIds)) return true
    } catch {
      /* Runtime can be restarting while the config change is being applied. */
    }
    if (Date.now() >= deadline) break
    await wait(pollIntervalMs)
  } while (true)
  return false
}

export function diagnosticsHaveConnectedServers(
  diagnostics: { mcpServers?: Array<Record<string, unknown>> } | null | undefined,
  serverIds: string[]
): boolean {
  const connected = new Set(
    (diagnostics?.mcpServers ?? [])
      .filter((server) => server.status === 'connected')
      .map((server) => typeof server.id === 'string' ? server.id : '')
  )
  return serverIds.every((id) => connected.has(id))
}
