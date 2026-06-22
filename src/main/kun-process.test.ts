import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureLogger } from './logger'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultKunRuntimeSettings,
  defaultModelRouterSettings,
  defaultModelProviderSettings,
  defaultRuntimeGuardSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type AppSettingsV1
} from '../shared/app-settings'
import { KunConfigSchema } from '../../kun/src/config/kun-config.js'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp/deepseek-gui-test-app',
    getPath: () => '/tmp/deepseek-gui-test-user-data'
  }
}))

let tempRoot: string | null = null

function createSettings(binaryPath: string, port = 8899): AppSettingsV1 {
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 'small',
    provider: defaultModelProviderSettings(),
    modelRouter: {
      ...defaultModelRouterSettings(),
      runtimeApiKey: 'local-runtime-router-key'
    },
    agents: {
      kun: {
        ...defaultKunRuntimeSettings(port),
        binaryPath,
        autoStart: true
      }
    },
    workspaceRoot: '/tmp/workspace',
    log: { enabled: false, retentionDays: 7 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    schedule: defaultScheduleSettings(),
    guiUpdate: { channel: 'stable' },
    codePromptPrefix: ''
  }
}

function writeScript(name: string, content: string): string {
  if (!tempRoot) throw new Error('temp root not initialized')
  const path = join(tempRoot, name)
  writeFileSync(path, content, 'utf8')
  return path
}

async function readKunLog(): Promise<string> {
  if (!tempRoot) throw new Error('temp root not initialized')
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const logFile = readdirSync(tempRoot).find((entry) => entry.startsWith('kun-') && entry.endsWith('.log'))
    if (logFile) return readFileSync(join(tempRoot, logFile), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Expected a kun log file to be created')
}

async function listenOnPort(port: number): Promise<ReturnType<typeof createServer>> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return server
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function canBindPort(port: number): Promise<boolean> {
  const server = createServer()
  return new Promise((resolve) => {
    let settled = false
    const settle = (available: boolean): void => {
      if (settled) return
      settled = true
      server.removeAllListeners('error')
      resolve(available)
    }
    server.once('error', () => settle(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => settle(true))
    })
  })
}

async function findPortWithAvailableNext(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = await listenOnPort(0)
    const address = server.address() as AddressInfo
    const port = address.port
    await closeServer(server)
    if (port < 65535 && await canBindPort(port + 1)) return port
  }
  throw new Error('Expected to find a test port with an available successor')
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'kun-process-'))
  configureLogger({ dir: tempRoot, enabled: true, retentionDays: 7 })
})

afterEach(async () => {
  const module = await import('./kun-process')
  module.setKunUnexpectedExitHandler(null)
  await module.stopKunChildAndWait()
  configureLogger({ dir: '', enabled: true, retentionDays: 2 })
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('startKunChild', () => {
  it('waits for the explicit Kun ready marker before resolving', async () => {
    const script = writeScript(
      'ready-child.js',
      [
        "setTimeout(() => {",
        "  process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port: 8899 }) + '\\n')",
        "}, 50)",
        "setInterval(() => {}, 1_000)"
      ].join('\n')
    )
    const module = await import('./kun-process')
    await expect(module.startKunChild(createSettings(script))).resolves.toBeUndefined()
    expect(module.isKunChildRunning()).toBe(true)
    await module.stopKunChildAndWait()
    const logText = await readKunLog()
    expect(logText).toContain('KUN_READY')
    expect(logText).toContain('ready marker received on port 8899')
  })

  it('resolves from /health when the stdout ready marker is delayed', async () => {
    const script = writeScript(
      'health-child.js',
      [
        "const http = require('node:http')",
        "const portIndex = process.argv.indexOf('--port')",
        "const port = Number(process.argv[portIndex + 1])",
        "const server = http.createServer((req, res) => {",
        "  if (req.url === '/health') {",
        "    res.setHeader('content-type', 'application/json')",
        "    res.end(JSON.stringify({ status: 'ok', service: 'kun', mode: 'serve' }))",
        '    return',
        '  }',
        '  res.statusCode = 404',
        "  res.end('{}')",
        '})',
        "server.listen(port, '127.0.0.1')",
        "setTimeout(() => {",
        "  process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port }) + '\\n')",
        "}, 10_000)",
        "setInterval(() => {}, 1_000)"
      ].join('\n')
    )
    const module = await import('./kun-process')
    await expect(module.startKunChild(createSettings(script))).resolves.toBeUndefined()
    expect(module.isKunChildRunning()).toBe(true)
    await module.stopKunChildAndWait()
    const logText = await readKunLog()
    expect(logText).toContain('health probe confirmed ready on port 8899')
  })

  it('coalesces concurrent startup requests into one child process', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const counterPath = join(tempRoot, 'spawn-count.txt')
    const script = writeScript(
      'concurrent-child.js',
      [
        "const fs = require('node:fs')",
        `fs.appendFileSync(${JSON.stringify(counterPath)}, 'x')`,
        "setTimeout(() => {",
        "  process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port: 8899 }) + '\\n')",
        "}, 100)",
        "setInterval(() => {}, 1_000)"
      ].join('\n')
    )
    const module = await import('./kun-process')
    await expect(Promise.all([
      module.startKunChild(createSettings(script)),
      module.startKunChild(createSettings(script))
    ])).resolves.toEqual([undefined, undefined])

    expect(readFileSync(counterPath, 'utf8')).toBe('x')
    await module.stopKunChildAndWait()
  })

  it('notifies when a ready child exits unexpectedly', async () => {
    const script = writeScript(
      'crash-child.js',
      [
        "process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port: 8899 }) + '\\n')",
        "setTimeout(() => {",
        "  process.stderr.write('runtime exploded\\n')",
        '  process.exit(34)',
        '}, 80)'
      ].join('\n')
    )
    const module = await import('./kun-process')
    const unexpectedExit = new Promise<import('./kun-process').KunUnexpectedExitInfo>((resolve) => {
      module.setKunUnexpectedExitHandler(resolve)
    })

    await expect(module.startKunChild(createSettings(script))).resolves.toBeUndefined()
    const info = await unexpectedExit
    expect(info).toMatchObject({ code: 34, signal: null })
    expect(info.stderrTail).toContain('runtime exploded')
    expect(module.isKunChildRunning()).toBe(false)
  })

  it('does not notify unexpected exit handlers for intentional stops', async () => {
    const script = writeScript(
      'intentional-stop-child.js',
      [
        "process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port: 8899 }) + '\\n')",
        "setInterval(() => {}, 1_000)"
      ].join('\n')
    )
    const module = await import('./kun-process')
    const handler = vi.fn()
    module.setKunUnexpectedExitHandler(handler)

    await expect(module.startKunChild(createSettings(script))).resolves.toBeUndefined()
    await module.stopKunChildAndWait()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects when the child exits before reporting ready', async () => {
    const script = writeScript(
      'exit-child.js',
      [
        "process.stderr.write('bind failed on port 8899\\n')",
        'setTimeout(() => process.exit(23), 20)'
      ].join('\n')
    )
    const module = await import('./kun-process')
    await expect(module.startKunChild(createSettings(script))).rejects.toThrow(
      /Kun exited during startup with code 23[\s\S]*bind failed on port 8899/
    )
    expect(module.isKunChildRunning()).toBe(false)
    await module.stopKunChildAndWait()
    const logText = await readKunLog()
    expect(logText).toContain('bind failed on port 8899')
    expect(logText).toContain('exited with code 23')
  })

  it('passes only the local Model Router runtime key env to Kun', async () => {
    const previousDeepSeekApiKey = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'outer-upstream-secret'
    const script = writeScript(
      'env-child.js',
      [
        "if (process.env.DEEPSEEK_API_KEY !== undefined) {",
        "  process.stderr.write('leaked upstream key ' + String(process.env.DEEPSEEK_API_KEY) + '\\n')",
        '  process.exit(24)',
        '}',
        "if (process.env.KUN_MODEL_ROUTER_API_KEY !== 'local-runtime-router-key') {",
        "  process.stderr.write('unexpected router key ' + String(process.env.KUN_MODEL_ROUTER_API_KEY) + '\\n')",
        '  process.exit(24)',
        '}',
        "process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port: 8899 }) + '\\n')",
        "setInterval(() => {}, 1_000)"
      ].join('\n')
    )
    try {
      const module = await import('./kun-process')
      await expect(module.startKunChild(createSettings(script))).resolves.toBeUndefined()
      await module.stopKunChildAndWait()
    } finally {
      if (previousDeepSeekApiKey === undefined) {
        delete process.env.DEEPSEEK_API_KEY
      } else {
        process.env.DEEPSEEK_API_KEY = previousDeepSeekApiKey
      }
    }
  })

  it('fails closed when the Model Router runtime API key is missing', async () => {
    const script = writeScript(
      'unused-child.js',
      [
        "process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port: 8899 }) + '\\n')",
        "setInterval(() => {}, 1_000)"
      ].join('\n')
    )
    const settings = createSettings(script)
    settings.modelRouter = {
      ...defaultModelRouterSettings(),
      ...settings.modelRouter,
      runtimeApiKey: ''
    }
    const module = await import('./kun-process')

    await expect(module.startKunChild(settings)).rejects.toThrow(/Model Router runtime API key is required/)
    expect(module.isKunChildRunning()).toBe(false)
  })
})

describe('reclaimKunPort', () => {
  it('reports a port as unavailable when another listener owns it', async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    try {
      const address = server.address() as AddressInfo
      const module = await import('./kun-process')

      await expect(module.reclaimKunPort(address.port)).resolves.toEqual({
        ok: false,
        message: `port ${address.port} is in use`
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('allows non-positive ports so Kun can request an ephemeral port', async () => {
    const module = await import('./kun-process')

    await expect(module.reclaimKunPort(0)).resolves.toEqual({ ok: true })
  })
})

describe('resolveAvailableKunPort', () => {
  it('uses the next bindable port after the preferred port is occupied', async () => {
    const preferredPort = await findPortWithAvailableNext()
    const server = await listenOnPort(preferredPort)
    try {
      const module = await import('./kun-process')

      await expect(module.resolveAvailableKunPort(preferredPort)).resolves.toEqual({
        port: preferredPort + 1,
        changed: true,
        message: `port ${preferredPort} is in use`
      })
    } finally {
      await closeServer(server)
    }
  })

  it('falls back to an ephemeral port for non-positive preferences', async () => {
    const module = await import('./kun-process')

    const resolved = await module.resolveAvailableKunPort(0)
    expect(resolved.changed).toBe(true)
    expect(resolved.port).toBeGreaterThan(0)
  })
})

describe('resolveKunDataDir', () => {
  it('expands Windows-style home-relative data directories', async () => {
    const module = await import('./kun-process')

    expect(module.resolveKunDataDir({ dataDir: '~\\deepseek\\kun' })).toBe(join(homedir(), 'deepseek', 'kun'))
  })

  it('does not expand non-home tilde prefixes', async () => {
    const module = await import('./kun-process')

    expect(module.resolveKunDataDir({ dataDir: '~other\\kun' })).toBe('~other\\kun')
  })
})

describe('syncGuiManagedKunConfig', () => {
  it('creates GUI-managed config with attachments enabled for image paste/upload', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const module = await import('./kun-process')

    await module.syncGuiManagedKunConfig(tempRoot, defaultKunRuntimeSettings())

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.serve.storage).toMatchObject({ backend: 'hybrid' })
    expect(parsed.serve.tokenEconomy).toMatchObject({
      enabled: false,
      compressToolDescriptions: true,
      compressToolResults: true,
      conciseResponses: true,
      historyHygiene: {
        maxToolResultLines: 320,
        maxToolResultBytes: 32768,
        maxToolResultTokens: 8000,
        maxToolArgumentStringBytes: 8192,
        maxToolArgumentStringTokens: 2000,
        maxArrayItems: 80
      }
    })
    expect(parsed.contextCompaction).toMatchObject({
      defaultSoftThreshold: 16000,
      defaultHardThreshold: 24000,
      summaryMode: 'heuristic'
    })
    expect(parsed.models.profiles['deepseek-v4-pro']).toMatchObject({
      contextWindowTokens: 1_000_000,
      contextCompaction: {
        softThreshold: 980_000,
        hardThreshold: 990_000
      }
    })
    expect(parsed.models.profiles['deepseek-v4-flash']).toMatchObject({
      aliases: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-gui-router'],
      contextWindowTokens: 1_000_000,
      contextCompaction: {
        softThreshold: 980_000,
        hardThreshold: 990_000
      }
    })
    expect(parsed.runtime.toolStorm).toMatchObject({ enabled: true, windowSize: 8, threshold: 3 })
    expect(parsed.runtime.toolArgumentRepair).toMatchObject({ maxStringBytes: 524288 })
    expect(parsed.capabilities.attachments).toMatchObject({ enabled: true })
    expect(parsed.capabilities.web).toMatchObject({ enabled: true, fetchEnabled: true })
    expect(parsed.capabilities.mcp.search).toMatchObject({ enabled: false, mode: 'auto' })
  })

  it('adds the built-in schedule MCP server to Kun runtime capabilities', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const module = await import('./kun-process')
    const settings = createSettings('/tmp/fake-kun-child.js')
    settings.schedule.internal.port = 9788
    settings.schedule.internal.secret = 'top-secret'

    await module.syncGuiManagedKunConfig(tempRoot, defaultKunRuntimeSettings(), {
      scheduleMcp: {
        settings,
        launch: {
          appPath: '/tmp/deepseek-gui-test-app',
          execPath: '/tmp/electron',
          isPackaged: false
        }
      }
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.mcp.enabled).toBe(true)
    expect(parsed.capabilities.mcp.servers.gui_schedule).toMatchObject({
      enabled: true,
      transport: 'stdio',
      command: '/tmp/electron',
      args: [
        '/tmp/deepseek-gui-test-app/out/main/claw-schedule-mcp-node-entry.js',
        '--gui-schedule-mcp-server',
        '--base-url',
        'http://127.0.0.1:9788',
        '--secret',
        'top-secret'
      ],
      env: {
        ELECTRON_RUN_AS_NODE: '1'
      },
      trustScope: 'user'
    })
  })

  it('adds GUI project and configured global skill roots to Kun runtime capabilities', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const module = await import('./kun-process')
    const settings = createSettings('/tmp/fake-kun-child.js')
    const workspaceRoot = join(tempRoot, 'workspace')
    const extraRoot = join(tempRoot, 'extra-skills')
    settings.workspaceRoot = workspaceRoot
    settings.claw.skills.extraDirs = [extraRoot]
    mkdirSync(join(workspaceRoot, '.codex', 'skills'), { recursive: true })

    await module.syncGuiManagedKunConfig(tempRoot, defaultKunRuntimeSettings(), {
      scheduleMcp: {
        settings,
        launch: {
          appPath: '/tmp/deepseek-gui-test-app',
          execPath: '/tmp/electron',
          isPackaged: false
        }
      }
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.skills.enabled).toBe(true)
    expect(parsed.capabilities.skills.legacySkillMd).toBe(true)
    expect(parsed.capabilities.skills.roots).toEqual(expect.arrayContaining([
      join(workspaceRoot, '.codex', 'skills'),
      extraRoot
    ]))
  })

  it('writes GUI-managed MCP search settings without removing existing servers', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      legacyTopLevelFlag: true,
      contextCompaction: {
        modelProfiles: {
          'custom-model': {
            contextWindowTokens: 128000
          }
        }
      },
      models: {
        profiles: {
          'user-model': {
            contextWindowTokens: 96000,
            contextCompaction: {
              softThreshold: 86000
            }
          },
          'deepseek-v4-pro': {
            contextCompaction: {
              softThreshold: 970000
            }
          }
        }
      },
      runtime: {
        customRuntimeFlag: true,
        toolStorm: {
          customStormFlag: 'keep'
        }
      },
      serve: {
        legacyServeFlag: true,
        apiKey: 'sk-legacy-direct-provider',
        baseUrl: 'https://api.deepseek.com/beta',
        endpointFormat: 'chat_completions',
        model: 'deepseek-chat',
        tokenEconomy: {
          customTokenEconomyFlag: 'keep',
          historyHygiene: {
            customHistoryFlag: true
          }
        }
      },
      capabilities: {
        mcp: {
          enabled: true,
          servers: {
            github: {
              transport: 'stdio',
              command: 'github-mcp',
              trustScope: 'user'
            }
          }
        },
        web: {
          enabled: true,
          fetchEnabled: true
        }
      }
    }), 'utf8')
    const module = await import('./kun-process')

    await module.syncGuiManagedKunConfig(tempRoot, {
      ...defaultKunRuntimeSettings(),
      storage: {
        backend: 'hybrid',
        sqlitePath: '/tmp/kun-index.sqlite3'
      },
      contextCompaction: {
        defaultSoftThreshold: 32000,
        defaultHardThreshold: 64000,
        summaryMode: 'model',
        summaryTimeoutMs: 30000,
        summaryMaxTokens: 1600,
        summaryInputMaxBytes: 131072
      },
      runtimeTuning: {
        toolArgumentRepair: {
          maxStringBytes: 262144
        }
      },
      mcpSearch: {
        enabled: true,
        mode: 'search',
        autoThresholdToolCount: 12,
        topKDefault: 4,
        topKMax: 9,
        minScore: 0.2
      },
      tokenEconomy: {
        enabled: true,
        compressToolDescriptions: false,
        compressToolResults: true,
        conciseResponses: false,
        historyHygiene: {
          maxToolResultLines: 100,
          maxToolResultBytes: 16384,
          maxToolResultTokens: 4000,
          maxToolArgumentStringBytes: 4096,
          maxToolArgumentStringTokens: 1000,
          maxArrayItems: 40
        }
      }
    }, {
      runtimeGuards: {
        ...defaultRuntimeGuardSettings(),
        toolStorm: {
          enabled: false,
          windowSize: 12,
          softThreshold: 4,
          hardThreshold: 8
        }
      }
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(KunConfigSchema.safeParse(parsed).success).toBe(true)
    expect(parsed.legacyTopLevelFlag).toBeUndefined()
    expect(parsed.serve.legacyServeFlag).toBeUndefined()
    expect(parsed.serve.apiKey).toBeUndefined()
    expect(parsed.serve.baseUrl).toBeUndefined()
    expect(parsed.serve.endpointFormat).toBeUndefined()
    expect(parsed.serve.model).toBeUndefined()
    expect(parsed.serve.storage).toMatchObject({
      backend: 'hybrid',
      sqlitePath: '/tmp/kun-index.sqlite3'
    })
    expect(parsed.serve.tokenEconomy).toMatchObject({
      enabled: true,
      compressToolDescriptions: false,
      compressToolResults: true,
      conciseResponses: false,
      historyHygiene: {
        maxToolResultLines: 100,
        maxToolResultBytes: 16384,
        maxToolResultTokens: 4000,
        maxToolArgumentStringBytes: 4096,
        maxToolArgumentStringTokens: 1000,
        maxArrayItems: 40
      }
    })
    expect(parsed.serve.tokenEconomy.customTokenEconomyFlag).toBeUndefined()
    expect(parsed.serve.tokenEconomy.historyHygiene.customHistoryFlag).toBeUndefined()
    expect(parsed.contextCompaction).toMatchObject({
      defaultSoftThreshold: 32000,
      defaultHardThreshold: 64000,
      summaryMode: 'model',
      summaryTimeoutMs: 30000,
      summaryMaxTokens: 1600,
      summaryInputMaxBytes: 131072
    })
    expect(parsed.contextCompaction.modelProfiles['custom-model']).toMatchObject({
      contextWindowTokens: 128000
    })
    expect(parsed.models.profiles['user-model']).toMatchObject({
      contextWindowTokens: 96000,
      contextCompaction: {
        softThreshold: 86000
      }
    })
    expect(parsed.models.profiles['deepseek-v4-pro']).toMatchObject({
      contextWindowTokens: 1_000_000,
      contextCompaction: {
        softThreshold: 970_000,
        hardThreshold: 990_000
      }
    })
    expect(parsed.runtime.toolStorm).toMatchObject({
      enabled: false,
      windowSize: 12,
      threshold: 4
    })
    expect(parsed.runtime.toolStorm.customStormFlag).toBeUndefined()
    expect(parsed.runtime.customRuntimeFlag).toBeUndefined()
    expect(parsed.runtime.toolArgumentRepair).toMatchObject({ maxStringBytes: 262144 })
    expect(parsed.capabilities.attachments).toMatchObject({ enabled: true })
    expect(parsed.capabilities.mcp.servers.github.command).toBe('github-mcp')
    expect(parsed.capabilities.web.fetchEnabled).toBe(true)
    expect(parsed.capabilities.mcp.search).toMatchObject({
      enabled: true,
      mode: 'search',
      autoThresholdToolCount: 12,
      topKDefault: 4,
      topKMax: 9,
      minScore: 0.2
    })
  })

  it('imports GUI-managed MCP servers into runtime capabilities', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const mcpConfigPath = join(tempRoot, 'mcp.json')
    writeFileSync(mcpConfigPath, JSON.stringify({
      servers: {
        'stata-mcp': {
          command: 'uvx',
          args: ['stata-mcp'],
          env: {
            STATA_CLI: 'D:\\stata\\StataMP-64.exe'
          },
          enabled: true,
          disabled: false
        },
        'docs-mcp': {
          url: 'https://mcp.example.test/mcp',
          headers: {
            Authorization: 'Bearer docs-token'
          }
        }
      }
    }), 'utf8')
    const module = await import('./kun-process')

    await module.syncGuiManagedKunConfig(tempRoot, defaultKunRuntimeSettings(), {
      mcpConfigPath
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.mcp.enabled).toBe(true)
    expect(parsed.capabilities.mcp.servers['stata-mcp']).toMatchObject({
      enabled: true,
      transport: 'stdio',
      command: 'uvx',
      args: ['stata-mcp'],
      env: {
        STATA_CLI: 'D:\\stata\\StataMP-64.exe'
      },
      trustScope: 'user'
    })
    expect(parsed.capabilities.mcp.servers['docs-mcp']).toMatchObject({
      enabled: true,
      transport: 'streamable-http',
      url: 'https://mcp.example.test/mcp',
      headers: {
        Authorization: 'Bearer docs-token'
      },
      trustScope: 'user'
    })
  })

  it('lets GUI-managed MCP server updates override stale runtime config snapshots', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const mcpConfigPath = join(tempRoot, 'mcp.json')
    writeFileSync(configPath, JSON.stringify({
      capabilities: {
        mcp: {
          enabled: true,
          servers: {
            ppt_master: {
              enabled: true,
              transport: 'stdio',
              command: 'npm',
              args: ['--workspace', 'sciforge-ppt-master-mcp-service', 'run', 'start'],
              env: {},
              trustScope: 'user'
            }
          }
        }
      }
    }), 'utf8')
    writeFileSync(mcpConfigPath, JSON.stringify({
      servers: {
        ppt_master: {
          enabled: true,
          transport: 'stdio',
          command: 'npm',
          args: ['--workspace', 'sciforge-ppt-master-mcp-service', 'run', 'start'],
          env: {
            PPT_MASTER_PYTHON: '/opt/codex/python3'
          },
          trustScope: 'user'
        }
      }
    }), 'utf8')
    const module = await import('./kun-process')

    await module.syncGuiManagedKunConfig(tempRoot, defaultKunRuntimeSettings(), {
      mcpConfigPath
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.mcp.servers.ppt_master.env).toEqual({
      PPT_MASTER_PYTHON: '/opt/codex/python3'
    })
  })

  it('replaces unparsable historical Kun config with a valid GUI-managed config', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    writeFileSync(configPath, '{ legacy config', 'utf8')
    const module = await import('./kun-process')

    await module.syncGuiManagedKunConfig(tempRoot, defaultKunRuntimeSettings())

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    expect(KunConfigSchema.safeParse(parsed).success).toBe(true)
  })

  it('does not enable MCP when the capability is explicitly disabled', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      capabilities: {
        mcp: {
          enabled: false
        }
      }
    }), 'utf8')
    const module = await import('./kun-process')

    await module.syncGuiManagedKunConfig(tempRoot, defaultKunRuntimeSettings(), {
      scheduleMcp: {
        settings: createSettings('/tmp/fake-kun-child.js'),
        launch: {
          appPath: '/tmp/deepseek-gui-test-app',
          execPath: '/tmp/electron',
          isPackaged: false
        }
      }
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.mcp.enabled).toBe(false)
    expect(parsed.capabilities.mcp.servers.gui_schedule).toMatchObject({
      transport: 'stdio',
      command: '/tmp/electron',
      args: [
        '/tmp/deepseek-gui-test-app/out/main/claw-schedule-mcp-node-entry.js',
        '--gui-schedule-mcp-server',
        '--base-url',
        'http://127.0.0.1:8788'
      ],
      env: {
        ELECTRON_RUN_AS_NODE: '1'
      }
    })
  })

  it('does not override an explicitly disabled attachment capability', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      capabilities: {
        attachments: {
          enabled: false,
          maxImageBytes: 1024
        }
      }
    }), 'utf8')
    const module = await import('./kun-process')

    await module.syncGuiManagedKunConfig(tempRoot, defaultKunRuntimeSettings())

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.attachments).toMatchObject({
      enabled: false,
      maxImageBytes: 1024
    })
  })

  it('does not override explicitly disabled web fetch capability', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      capabilities: {
        web: {
          enabled: false,
          fetchEnabled: false,
          searchEnabled: true,
          provider: 'custom-search'
        }
      }
    }), 'utf8')
    const module = await import('./kun-process')

    await module.syncGuiManagedKunConfig(tempRoot, defaultKunRuntimeSettings())

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.web).toMatchObject({
      enabled: false,
      fetchEnabled: false,
      searchEnabled: true,
      provider: 'custom-search'
    })
  })
})
