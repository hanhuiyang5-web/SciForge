import { join, posix } from 'node:path'
import { resolveClawScheduleMcpCommand, type ClawScheduleMcpLaunchConfig } from './claw-schedule-mcp-config'

type JsonRecord = Record<string, unknown>

export type SciforgeCanvasMcpLaunchConfig = ClawScheduleMcpLaunchConfig

export const SCIFORGE_CANVAS_MCP_SERVER_NAME = 'sciforge_canvas'
export const SCIFORGE_CANVAS_MCP_FLAG = '--sciforge-canvas-mcp-server'

const SCIFORGE_CANVAS_MCP_NODE_ENTRY = 'out/main/sciforge-canvas-mcp-node-entry.js'
const ELECTRON_RUN_AS_NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' }

export function resolveSciforgeCanvasMcpNodeEntryPath(
  launch: SciforgeCanvasMcpLaunchConfig
): string {
  if (launch.appPath.includes('/') && !launch.appPath.includes('\\')) {
    return posix.join(launch.appPath, SCIFORGE_CANVAS_MCP_NODE_ENTRY)
  }
  return join(launch.appPath, SCIFORGE_CANVAS_MCP_NODE_ENTRY)
}

export function resolveSciforgeCanvasMcpCommand(
  launch: SciforgeCanvasMcpLaunchConfig,
  platform: NodeJS.Platform = process.platform
): string {
  return resolveClawScheduleMcpCommand(launch, platform)
}

export function buildSciforgeCanvasMcpArgs(
  launch: SciforgeCanvasMcpLaunchConfig,
  workspaceRoot?: string
): string[] {
  const args = [
    resolveSciforgeCanvasMcpNodeEntryPath(launch),
    SCIFORGE_CANVAS_MCP_FLAG
  ]
  const normalizedWorkspaceRoot = workspaceRoot?.trim()
  if (normalizedWorkspaceRoot) {
    args.push('--workspace-root', normalizedWorkspaceRoot)
  }
  return args
}

export function buildSciforgeCanvasMcpServerConfig(
  launch: SciforgeCanvasMcpLaunchConfig,
  workspaceRoot?: string
): JsonRecord {
  const normalizedWorkspaceRoot = workspaceRoot?.trim()
  const trustScope = normalizedWorkspaceRoot ? 'workspace' : 'user'
  return {
    enabled: true,
    transport: 'stdio',
    command: resolveSciforgeCanvasMcpCommand(launch),
    args: buildSciforgeCanvasMcpArgs(launch, normalizedWorkspaceRoot),
    env: ELECTRON_RUN_AS_NODE_ENV,
    trustScope,
    ...(normalizedWorkspaceRoot ? { trustedWorkspaceRoots: [normalizedWorkspaceRoot] } : {}),
    timeoutMs: 30_000
  }
}

export function buildSciforgeCanvasMcpConfigFragment(
  launch: SciforgeCanvasMcpLaunchConfig,
  workspaceRoot?: string
): JsonRecord {
  return {
    servers: {
      [SCIFORGE_CANVAS_MCP_SERVER_NAME]: buildSciforgeCanvasMcpServerConfig(launch, workspaceRoot)
    }
  }
}
