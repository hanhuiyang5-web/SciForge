import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@sciforge/collaboration-contracts': fileURLToPath(new URL('../collaboration-contracts/src/index.ts', import.meta.url)),
      '@sciforge/collaboration-provider-zulip/server': fileURLToPath(new URL('../collaboration-provider-zulip/src/server.ts', import.meta.url))
    }
  }
})
