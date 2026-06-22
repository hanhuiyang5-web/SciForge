import { runPptMasterMcpServer } from '../../plugins/ppt-master-mcp-service/src/server'
import { PPT_MASTER_MCP_FLAG } from './ppt-master-mcp-config'

void (async () => {
  if (!process.argv.includes(PPT_MASTER_MCP_FLAG)) {
    console.error(`[ppt-master-mcp] missing ${PPT_MASTER_MCP_FLAG} launch flag`)
    process.exit(1)
  }
  await runPptMasterMcpServer()
})().catch((error) => {
  console.error('[ppt-master-mcp] server failed:', error)
  process.exit(1)
})
