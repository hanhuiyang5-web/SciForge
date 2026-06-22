import assert from 'node:assert/strict';
import test from 'node:test';
import { registerPptMasterTools } from './server.js';
import type { PptMasterService } from './service.js';

test('registers the staged ppt-master MCP tool surface with safety annotations', () => {
  const registered: Array<{ name: string; config: Record<string, unknown> }> = [];
  const service = {
    status: async () => ({}),
    projectStatus: async () => ({}),
    convertSource: async () => ({}),
    initProject: async () => ({}),
    sciforgeIntake: async () => ({}),
    splitNotes: async () => ({}),
    qualityCheck: async () => ({}),
    finalizeSvg: async () => ({}),
    exportPptx: async () => ({})
  } as unknown as PptMasterService;

  registerPptMasterTools({
    registerTool(name, config) {
      registered.push({ name, config });
    }
  }, service);

  assert.deepEqual(registered.map((tool) => tool.name), [
    'ppt_master_status',
    'ppt_master_project_status',
    'ppt_master_convert_source',
    'ppt_master_init_project',
    'ppt_master_sciforge_intake',
    'ppt_master_split_notes',
    'ppt_master_quality_check',
    'ppt_master_finalize_svg',
    'ppt_master_export_pptx'
  ]);
  assert.equal((registered.find((tool) => tool.name === 'ppt_master_status')?.config.annotations as { readOnlyHint?: boolean }).readOnlyHint, true);
  assert.equal((registered.find((tool) => tool.name === 'ppt_master_convert_source')?.config.annotations as { openWorldHint?: boolean }).openWorldHint, true);
  assert.equal((registered.find((tool) => tool.name === 'ppt_master_sciforge_intake')?.config.annotations as { readOnlyHint?: boolean }).readOnlyHint, false);
  const intakeSchema = registered.find((tool) => tool.name === 'ppt_master_sciforge_intake')?.config.inputSchema as Record<string, unknown>;
  assert.ok(intakeSchema.stylePreset);
  assert.ok(intakeSchema.figures);
});
