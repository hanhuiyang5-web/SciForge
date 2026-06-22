import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { resolveClawScheduleMcpCommand, type ClawScheduleMcpLaunchConfig } from './claw-schedule-mcp-config'

type JsonRecord = Record<string, unknown>

export const PPT_MASTER_MCP_SERVER_NAME = 'ppt_master'
export const PPT_MASTER_MCP_WORKSPACE_NAME = 'sciforge-ppt-master-mcp-service'
export const PPT_MASTER_MCP_FLAG = '--ppt-master-mcp-server'

const PPT_MASTER_MCP_NODE_ENTRY = 'out/main/ppt-master-mcp-node-entry.js'
const ELECTRON_RUN_AS_NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' }

export type PptMasterMcpLaunchConfig = ClawScheduleMcpLaunchConfig & {
  homeDir?: string
}

export function resolvePptMasterMcpPluginDir(launch: PptMasterMcpLaunchConfig): string {
  return join(launch.appPath, 'plugins', 'ppt-master-mcp-service')
}

export function resolvePptMasterMcpNodeEntryPath(launch: PptMasterMcpLaunchConfig): string {
  if (launch.appPath.includes('/') && !launch.appPath.includes('\\')) {
    return posix.join(launch.appPath, PPT_MASTER_MCP_NODE_ENTRY)
  }
  return join(launch.appPath, PPT_MASTER_MCP_NODE_ENTRY)
}

export function resolvePptMasterMcpCommand(
  launch: PptMasterMcpLaunchConfig,
  platform: NodeJS.Platform = process.platform
): string {
  return resolveClawScheduleMcpCommand(launch, platform)
}

export function buildPptMasterMcpArgs(launch: PptMasterMcpLaunchConfig): string[] {
  return [
    resolvePptMasterMcpNodeEntryPath(launch),
    PPT_MASTER_MCP_FLAG
  ]
}

export function buildPptMasterMcpServerConfig(
  launch: PptMasterMcpLaunchConfig,
  workspaceRoot?: string
): JsonRecord {
  const normalizedWorkspaceRoot = workspaceRoot?.trim()
  const trustScope = normalizedWorkspaceRoot ? 'workspace' : 'user'
  const env = {
    ...ELECTRON_RUN_AS_NODE_ENV,
    ...buildPptMasterMcpEnv(launch.homeDir ?? homedir())
  }
  return {
    enabled: true,
    transport: 'stdio',
    command: resolvePptMasterMcpCommand(launch),
    args: buildPptMasterMcpArgs(launch),
    env,
    trustScope,
    ...(normalizedWorkspaceRoot ? { trustedWorkspaceRoots: [normalizedWorkspaceRoot] } : {}),
    timeoutMs: 120_000
  }
}

export function buildPptMasterMcpEnv(homeDir: string): JsonRecord {
  const bundledPython = join(
    homeDir,
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'python',
    'bin',
    'python3'
  )
  if (!existsSync(bundledPython)) return {}
  return {
    PPT_MASTER_PYTHON: bundledPython
  }
}

export function buildPptMasterMcpConfigFragment(
  launch: PptMasterMcpLaunchConfig,
  workspaceRoot?: string
): JsonRecord {
  return {
    servers: {
      [PPT_MASTER_MCP_SERVER_NAME]: buildPptMasterMcpServerConfig(launch, workspaceRoot)
    }
  }
}
