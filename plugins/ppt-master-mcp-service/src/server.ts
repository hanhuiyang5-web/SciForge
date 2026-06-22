import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createPptMasterService, type PptMasterService } from './service.js';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
} as const;

const OPEN_WORLD_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
} as const;

type ToolRegistrar = {
  registerTool(
    name: string,
    config: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ): void;
};

function textResult(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structuredContent ? { structuredContent } : {})
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true
  };
}

function jsonText(title: string, value: unknown): string {
  return `${title}\n\n${JSON.stringify(value, null, 2)}`;
}

async function safeTool<T>(label: string, action: () => Promise<T>) {
  try {
    const result = await action();
    return textResult(jsonText(label, result), { result: result as Record<string, unknown> });
  } catch (error) {
    return errorResult(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function registerPptMasterTools(registrar: ToolRegistrar, service: PptMasterService): void {
  registrar.registerTool('ppt_master_status', {
    title: 'ppt-master Status',
    description: 'Report local ppt-master skill discovery status, required script paths, and hard workflow guardrails.',
    annotations: READ_ONLY_ANNOTATIONS
  }, async () => safeTool('ppt-master status', () => service.status()));

  registrar.registerTool('ppt_master_project_status', {
    title: 'ppt-master Project Status',
    description: 'Inspect a ppt-master project directory for sources, specs, SVG folders, notes, and PPTX exports.',
    inputSchema: {
      projectPath: z.string().trim().min(1)
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, async ({ projectPath }) => safeTool('ppt-master project status', () => service.projectStatus({
    projectPath: String(projectPath)
  })));

  registrar.registerTool('ppt_master_convert_source', {
    title: 'ppt-master Convert Source',
    description: 'Convert one source document or URL to Markdown with ppt-master conversion scripts.',
    inputSchema: {
      source: z.string().trim().min(1),
      kind: z.enum(['pdf', 'doc', 'excel', 'ppt', 'web']).optional(),
      cwd: z.string().trim().min(1).optional()
    },
    annotations: OPEN_WORLD_ANNOTATIONS
  }, async ({ source, kind, cwd }) => safeTool('ppt-master source conversion', () => service.convertSource({
    source: String(source),
    kind: kind as 'pdf' | 'doc' | 'excel' | 'ppt' | 'web' | undefined,
    ...(cwd ? { cwd: String(cwd) } : {})
  })));

  registrar.registerTool('ppt_master_init_project', {
    title: 'ppt-master Init Project',
    description: 'Create a ppt-master project in a SciForge workspace and optionally import already-staged source files with --move.',
    inputSchema: {
      workspaceRoot: z.string().trim().min(1),
      deckSlug: z.string().trim().min(1).optional(),
      projectPath: z.string().trim().min(1).optional(),
      format: z.string().trim().min(1).optional(),
      sourcePaths: z.array(z.string().trim().min(1)).optional()
    },
    annotations: WRITE_ANNOTATIONS
  }, async ({ workspaceRoot, deckSlug, projectPath, format, sourcePaths }) =>
    safeTool('ppt-master project init', () => service.initProject({
      workspaceRoot: String(workspaceRoot),
      ...(deckSlug ? { deckSlug: String(deckSlug) } : {}),
      ...(projectPath ? { projectPath: String(projectPath) } : {}),
      ...(format ? { format: String(format) } : {}),
      sourcePaths: Array.isArray(sourcePaths) ? sourcePaths.map(String) : undefined
    })));

  registrar.registerTool('ppt_master_sciforge_intake', {
    title: 'ppt-master SciForge Intake',
    description: 'Bundle SciForge paper/document refs, existing figure assets, write drafts, quoted selections, and Model Router scientific evidence into ppt-master sources.',
    inputSchema: {
      workspaceRoot: z.string().trim().min(1),
      projectPath: z.string().trim().min(1).optional(),
      deckSlug: z.string().trim().min(1).optional(),
      title: z.string().trim().min(1).optional(),
      audience: z.string().trim().min(1).optional(),
      stylePreset: z.string().trim().min(1).optional().describe('Defaults to auto. Use sciforge_research only when the caller explicitly wants the research UI Kit; styling still does not reinterpret scientific data.'),
      thread: z.object({
        id: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).optional()
      }).optional(),
      task: z.object({
        id: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).optional()
      }).optional(),
      sourceFiles: z.array(z.object({
        path: z.string().trim().min(1),
        title: z.string().trim().min(1).optional(),
        kind: z.string().trim().min(1).optional(),
        mimeType: z.string().trim().min(1).optional(),
        modelRouterObject: z.boolean().optional()
      })).optional(),
      quotedSelections: z.array(z.object({
        sourceTitle: z.string().trim().min(1).optional(),
        sourceFilePath: z.string().trim().min(1).optional(),
        location: z.string().trim().min(1).optional(),
        text: z.string().min(1)
      })).optional(),
      writeMarkdown: z.object({
        path: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).optional(),
        content: z.string().min(1)
      }).optional(),
      modelRouterEvidence: z.array(z.object({
        source: z.string().trim().min(1).optional(),
        modality: z.string().trim().min(1).optional(),
        model: z.string().trim().min(1).optional(),
        summary: z.string().trim().min(1).optional(),
          text: z.string().min(1)
        })).optional(),
      figures: z.array(z.object({
        path: z.string().trim().min(1).describe('Workspace-relative or absolute path to an existing presentation figure asset, such as PNG/SVG/PDF.'),
        title: z.string().trim().min(1).optional(),
        caption: z.string().trim().min(1).optional(),
        source: z.string().trim().min(1).optional(),
        evidenceIds: z.array(z.string().trim().min(1)).optional(),
        altText: z.string().trim().min(1).optional(),
        kind: z.string().trim().min(1).optional()
      })).optional().describe('Existing SciForge-generated figure assets to copy into the ppt-master project. Raw scientific modality files are not accepted here.'),
      notes: z.string().optional(),
      importSources: z.boolean().optional()
    },
    annotations: WRITE_ANNOTATIONS
  }, async (args) => safeTool('ppt-master SciForge intake', () => service.sciforgeIntake(args as never)));

  registrar.registerTool('ppt_master_split_notes', {
    title: 'ppt-master Split Speaker Notes',
    description: 'Run total_md_split.py for one ppt-master project. Run this before finalize/export.',
    inputSchema: {
      projectPath: z.string().trim().min(1)
    },
    annotations: WRITE_ANNOTATIONS
  }, async ({ projectPath }) => safeTool('ppt-master split notes', () => service.splitNotes({
    projectPath: String(projectPath)
  })));

  registrar.registerTool('ppt_master_quality_check', {
    title: 'ppt-master SVG Quality Check',
    description: 'Run svg_quality_checker.py against svg_output before post-processing.',
    inputSchema: {
      projectPath: z.string().trim().min(1)
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, async ({ projectPath }) => safeTool('ppt-master quality check', () => service.qualityCheck({
    projectPath: String(projectPath)
  })));

  registrar.registerTool('ppt_master_finalize_svg', {
    title: 'ppt-master Finalize SVG',
    description: 'Run finalize_svg.py for icon/image embedding and PPT-safe SVG post-processing.',
    inputSchema: {
      projectPath: z.string().trim().min(1)
    },
    annotations: WRITE_ANNOTATIONS
  }, async ({ projectPath }) => safeTool('ppt-master finalize SVG', () => service.finalizeSvg({
    projectPath: String(projectPath)
  })));

  registrar.registerTool('ppt_master_export_pptx', {
    title: 'ppt-master Export PPTX',
    description: 'Run svg_to_pptx.py for a ppt-master project after split/finalize steps.',
    inputSchema: {
      projectPath: z.string().trim().min(1),
      svgSnapshot: z.boolean().optional(),
      transition: z.string().trim().min(1).optional(),
      animation: z.string().trim().min(1).optional(),
      animationTrigger: z.enum(['on-click', 'with-previous', 'after-previous']).optional(),
      autoAdvanceSeconds: z.number().positive().optional()
    },
    annotations: WRITE_ANNOTATIONS
  }, async ({ projectPath, svgSnapshot, transition, animation, animationTrigger, autoAdvanceSeconds }) =>
    safeTool('ppt-master export PPTX', () => service.exportPptx({
      projectPath: String(projectPath),
      svgSnapshot: Boolean(svgSnapshot),
      ...(transition ? { transition: String(transition) } : {}),
      ...(animation ? { animation: String(animation) } : {}),
      ...(animationTrigger ? { animationTrigger: animationTrigger as 'on-click' | 'with-previous' | 'after-previous' } : {}),
      ...(typeof autoAdvanceSeconds === 'number' ? { autoAdvanceSeconds } : {})
    })));
}

export async function runPptMasterMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: 'sciforge-ppt-master', version: '0.1.0' },
    { capabilities: { logging: {} } }
  );
  registerPptMasterTools(server as unknown as ToolRegistrar, createPptMasterService());
  await server.connect(new StdioServerTransport());
}
