import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PPT_MASTER_MCP_FLAG,
  PPT_MASTER_MCP_SERVER_NAME,
  buildPptMasterMcpEnv,
  buildPptMasterMcpConfigFragment,
  buildPptMasterMcpServerConfig,
  resolvePptMasterMcpNodeEntryPath
} from './ppt-master-mcp-config'

describe('ppt-master MCP config', () => {
  it('builds a workspace-scoped bundled MCP server config', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'ppt-master-mcp-config-'))
    const execPath = join(appPath, 'DeepSeek GUI')

    const config = buildPptMasterMcpServerConfig({ appPath, execPath, isPackaged: false }, '/tmp/workspace')

    expect(config).toMatchObject({
      enabled: true,
      transport: 'stdio',
      command: execPath,
      trustScope: 'workspace',
      trustedWorkspaceRoots: ['/tmp/workspace'],
      timeoutMs: 120_000
    })
    expect(config.args).toEqual([
      resolvePptMasterMcpNodeEntryPath({ appPath, execPath, isPackaged: false }),
      PPT_MASTER_MCP_FLAG
    ])
    expect(config.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1'
    })
  })

  it('wraps the server config in a ppt_master fragment', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'ppt-master-mcp-fragment-'))
    const execPath = join(appPath, 'DeepSeek GUI')

    const fragment = buildPptMasterMcpConfigFragment({ appPath, execPath, isPackaged: false })

    expect(Object.keys((fragment.servers as Record<string, unknown>))).toEqual([PPT_MASTER_MCP_SERVER_NAME])
  })

  it('injects the bundled Codex Python when available', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'ppt-master-mcp-home-'))
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
    await mkdir(join(bundledPython, '..'), { recursive: true })
    await writeFile(bundledPython, '#!/usr/bin/env python3\n')

    expect(buildPptMasterMcpEnv(homeDir)).toEqual({
      PPT_MASTER_PYTHON: bundledPython
    })
  })

  it('keeps the MCP env empty when bundled Python is unavailable', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'ppt-master-mcp-no-python-'))

    expect(buildPptMasterMcpEnv(homeDir)).toEqual({})
  })

  it('passes bundled Python through the generated server config', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'ppt-master-mcp-config-python-'))
    const homeDir = await mkdtemp(join(tmpdir(), 'ppt-master-mcp-config-home-'))
    const execPath = join(appPath, 'DeepSeek GUI')
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
    await mkdir(join(bundledPython, '..'), { recursive: true })
    await writeFile(bundledPython, '#!/usr/bin/env python3\n')

    const config = buildPptMasterMcpServerConfig({ appPath, execPath, homeDir, isPackaged: false })

    expect(config.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      PPT_MASTER_PYTHON: bundledPython
    })
  })

  it('does not require the external plugin workspace in packaged configs', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'ppt-master-mcp-packaged-'))
    const execPath = join(appPath, 'DeepSeek GUI')

    expect(() => buildPptMasterMcpServerConfig({ appPath, execPath, isPackaged: true })).not.toThrow()
  })
})
