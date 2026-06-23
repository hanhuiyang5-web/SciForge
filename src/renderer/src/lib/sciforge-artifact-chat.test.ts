import { describe, expect, it, vi } from 'vitest'
import {
  SCIFORGE_CANVAS_MCP_SERVER_ID,
  SCIENTIFIC_PLOTTING_MCP_SERVER_ID,
  buildSciforgeArtifactFlowPrompt,
  diagnosticsHaveConnectedServers,
  ensureSciforgeArtifactMcpsForChat,
  isCanvasReviewRequest,
  isScientificPlottingRequest,
  shouldUseSciforgeArtifactFlow
} from './sciforge-artifact-chat'

describe('SciForge artifact chat bootstrap', () => {
  it('detects plotting and PPT artifact requests', () => {
    expect(isScientificPlottingRequest('帮我画一张图和做一个ppt')).toBe(true)
    expect(isScientificPlottingRequest('生成一个季度数据图表')).toBe(true)
    expect(isScientificPlottingRequest('你好')).toBe(false)
    expect(shouldUseSciforgeArtifactFlow('帮我做一个ppt')).toBe(true)
  })

  it('detects canvas annotation revision requests', () => {
    expect(isCanvasReviewRequest('按照我标注的内容修改图片')).toBe(true)
    expect(isCanvasReviewRequest('根据画布批注重绘这个图')).toBe(true)
    expect(isCanvasReviewRequest('把审改包里的意见应用一下')).toBe(true)
    expect(shouldUseSciforgeArtifactFlow('按照我标注的内容修改图片')).toBe(true)
    expect(isCanvasReviewRequest('你好')).toBe(false)
  })

  it('adds workflow instructions that require canvas insertion', () => {
    const prompt = buildSciforgeArtifactFlowPrompt('帮我画一张图')
    expect(prompt).toContain('scientific_plotting_*')
    expect(prompt).toContain('sciforge_canvas_insert_artifact')
    expect(prompt).toContain('sciforge_canvas_import_recent_artifacts')
    expect(prompt).toContain('[Current user request]')
  })

  it('adds review-packet instructions for canvas annotation revisions', () => {
    const prompt = buildSciforgeArtifactFlowPrompt('按照我标注的内容修改图片')
    expect(prompt).toContain('[SciForge Canvas review workflow]')
    expect(prompt).toContain('sciforge_canvas_get_selection')
    expect(prompt).toContain('sciforge_canvas_export_review_packet')
    expect(prompt).toContain('Do not answer by only listing workspace files')
    expect(prompt).toContain('insert the revised output beside the original')
  })

  it('guards PPT post-processing against inspecting private skill scripts', () => {
    const prompt = buildSciforgeArtifactFlowPrompt('帮我做一个 PPT')
    expect(prompt).toContain('~/.codex/skills/ppt-master/scripts/')
    expect(prompt).toContain('Do not read, cat, copy, or inspect those script files')
    expect(prompt).toContain('repair the workspace project notes mapping')
    expect(prompt).toContain('ppt_master_quality_check')
    expect(prompt).toContain('replace forbidden `rgba()` colors')
    expect(prompt).toContain('ppt_master_export_pptx')
  })

  it('configures plotting and canvas MCP servers for plotting requests', async () => {
    const writeConfig = vi.fn(async () => undefined)
    const result = await ensureSciforgeArtifactMcpsForChat({
      text: '帮我画一张图',
      workspaceRoot: '/tmp/workspace',
      readConfig: async () => ({ content: '{"servers":{}}' }),
      writeConfig,
      buildScientificPlottingConfig: async (workspaceRoot) => ({
        ok: true,
        config: {
          servers: {
            [SCIENTIFIC_PLOTTING_MCP_SERVER_ID]: {
              command: 'app',
              args: ['plotting', '--workspace-root', workspaceRoot],
              trustScope: 'workspace',
              trustedWorkspaceRoots: [workspaceRoot]
            }
          }
        }
      }),
      buildSciforgeCanvasConfig: async (workspaceRoot) => ({
        ok: true,
        config: {
          servers: {
            [SCIFORGE_CANVAS_MCP_SERVER_ID]: {
              command: 'app',
              args: ['canvas', '--workspace-root', workspaceRoot],
              trustScope: 'workspace',
              trustedWorkspaceRoots: [workspaceRoot]
            }
          }
        }
      }),
      getToolDiagnostics: async () => ({
        mcpServers: [
          { id: SCIENTIFIC_PLOTTING_MCP_SERVER_ID, status: 'connected' },
          { id: SCIFORGE_CANVAS_MCP_SERVER_ID, status: 'connected' }
        ]
      }),
      waitTimeoutMs: 1,
      pollIntervalMs: 1
    })

    expect(result).toEqual({
      status: 'configured',
      runtimeConnected: true,
      serverIds: [SCIENTIFIC_PLOTTING_MCP_SERVER_ID, SCIFORGE_CANVAS_MCP_SERVER_ID]
    })
    const writtenConfig = JSON.parse(String(writeConfig.mock.calls.at(0)?.at(0))) as Record<string, any>
    expect(writtenConfig.servers).toHaveProperty(SCIENTIFIC_PLOTTING_MCP_SERVER_ID)
    expect(writtenConfig.servers).toHaveProperty(SCIFORGE_CANVAS_MCP_SERVER_ID)
  })

  it('configures plotting and canvas MCP servers for image annotation revisions', async () => {
    const writeConfig = vi.fn(async () => undefined)
    const result = await ensureSciforgeArtifactMcpsForChat({
      text: '按照我标注的内容修改图片',
      workspaceRoot: '/tmp/workspace',
      readConfig: async () => ({ content: '{"servers":{}}' }),
      writeConfig,
      buildScientificPlottingConfig: async (workspaceRoot) => ({
        ok: true,
        config: {
          servers: {
            [SCIENTIFIC_PLOTTING_MCP_SERVER_ID]: {
              command: 'app',
              args: ['plotting', '--workspace-root', workspaceRoot],
              trustScope: 'workspace',
              trustedWorkspaceRoots: [workspaceRoot]
            }
          }
        }
      }),
      buildSciforgeCanvasConfig: async (workspaceRoot) => ({
        ok: true,
        config: {
          servers: {
            [SCIFORGE_CANVAS_MCP_SERVER_ID]: {
              command: 'app',
              args: ['canvas', '--workspace-root', workspaceRoot],
              trustScope: 'workspace',
              trustedWorkspaceRoots: [workspaceRoot]
            }
          }
        }
      }),
      getToolDiagnostics: async () => ({
        mcpServers: [
          { id: SCIENTIFIC_PLOTTING_MCP_SERVER_ID, status: 'connected' },
          { id: SCIFORGE_CANVAS_MCP_SERVER_ID, status: 'connected' }
        ]
      }),
      waitTimeoutMs: 1,
      pollIntervalMs: 1
    })

    expect(result).toEqual({
      status: 'configured',
      runtimeConnected: true,
      serverIds: [SCIENTIFIC_PLOTTING_MCP_SERVER_ID, SCIFORGE_CANVAS_MCP_SERVER_ID]
    })
    expect(writeConfig).toHaveBeenCalledTimes(1)
  })

  it('checks diagnostics for all required servers', () => {
    expect(diagnosticsHaveConnectedServers({
      mcpServers: [
        { id: SCIENTIFIC_PLOTTING_MCP_SERVER_ID, status: 'connected' },
        { id: SCIFORGE_CANVAS_MCP_SERVER_ID, status: 'error' }
      ]
    }, [SCIENTIFIC_PLOTTING_MCP_SERVER_ID, SCIFORGE_CANVAS_MCP_SERVER_ID])).toBe(false)
    expect(diagnosticsHaveConnectedServers({
      mcpServers: [
        { id: SCIENTIFIC_PLOTTING_MCP_SERVER_ID, status: 'connected' },
        { id: SCIFORGE_CANVAS_MCP_SERVER_ID, status: 'connected' }
      ]
    }, [SCIENTIFIC_PLOTTING_MCP_SERVER_ID, SCIFORGE_CANVAS_MCP_SERVER_ID])).toBe(true)
  })
})
