import { runSciforgeCanvasMcpServerFromArgv } from './sciforge-canvas-mcp-server'
import { SCIFORGE_CANVAS_MCP_FLAG } from './sciforge-canvas-mcp-config'

void runSciforgeCanvasMcpServerFromArgv(process.argv).then((handled) => {
  if (!handled) {
    console.error(`[sciforge-canvas-mcp] missing ${SCIFORGE_CANVAS_MCP_FLAG} launch flag`)
    process.exit(1)
  }
}).catch((error) => {
  console.error('[sciforge-canvas-mcp] server failed:', error)
  process.exit(1)
})
