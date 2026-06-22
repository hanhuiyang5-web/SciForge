import { runPptMasterMcpServer } from './server.js';

void runPptMasterMcpServer().catch((error) => {
  console.error('[ppt-master-mcp] server failed:', error);
  process.exit(1);
});
