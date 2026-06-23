import { describe, expect, it } from 'vitest'
import {
  SCIFORGE_CANVAS_MCP_FLAG,
  SCIFORGE_CANVAS_MCP_SERVER_NAME,
  buildSciforgeCanvasMcpArgs,
  buildSciforgeCanvasMcpConfigFragment,
  buildSciforgeCanvasMcpServerConfig,
  resolveSciforgeCanvasMcpCommand,
  resolveSciforgeCanvasMcpNodeEntryPath,
  type SciforgeCanvasMcpLaunchConfig
} from './sciforge-canvas-mcp-config'

const launch: SciforgeCanvasMcpLaunchConfig = {
  appPath: '/Applications/DeepSeek GUI.app',
  execPath: '/Applications/DeepSeek GUI.app/Contents/MacOS/DeepSeek GUI',
  isPackaged: true
}

describe('SciForge Canvas MCP config', () => {
  it('uses the canvas node entry and launch flag', () => {
    expect(resolveSciforgeCanvasMcpNodeEntryPath(launch)).toBe(
      '/Applications/DeepSeek GUI.app/out/main/sciforge-canvas-mcp-node-entry.js'
    )
    expect(buildSciforgeCanvasMcpArgs(launch, '/tmp/workspace')).toEqual([
      resolveSciforgeCanvasMcpNodeEntryPath(launch),
      SCIFORGE_CANVAS_MCP_FLAG,
      '--workspace-root',
      '/tmp/workspace'
    ])
  })

  it('builds a workspace-scoped server fragment', () => {
    const server = buildSciforgeCanvasMcpServerConfig(launch, '/tmp/workspace')
    expect(server).toMatchObject({
      enabled: true,
      transport: 'stdio',
      command: resolveSciforgeCanvasMcpCommand(launch),
      args: [
        resolveSciforgeCanvasMcpNodeEntryPath(launch),
        SCIFORGE_CANVAS_MCP_FLAG,
        '--workspace-root',
        '/tmp/workspace'
      ],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      trustScope: 'workspace',
      trustedWorkspaceRoots: ['/tmp/workspace'],
      timeoutMs: 30_000
    })
    expect(buildSciforgeCanvasMcpConfigFragment(launch, '/tmp/workspace')).toMatchObject({
      servers: {
        [SCIFORGE_CANVAS_MCP_SERVER_NAME]: server
      }
    })
  })
})
