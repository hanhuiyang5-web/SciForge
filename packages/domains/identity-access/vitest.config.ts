import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@sciforge/collaboration-identity/testing': fileURLToPath(
        new URL('../../collaboration-identity/src/testing.ts', import.meta.url)
      ),
      '@sciforge/collaboration-identity': fileURLToPath(
        new URL('../../collaboration-identity/src/index.ts', import.meta.url)
      ),
      '@sciforge/collaboration-contracts/testing': fileURLToPath(
        new URL('../../collaboration-contracts/src/testing.ts', import.meta.url)
      ),
      '@sciforge/collaboration-contracts': fileURLToPath(
        new URL('../../collaboration-contracts/src/index.ts', import.meta.url)
      )
    }
  },
  test: {
    environment: 'node',
    include: [`${packageRoot}src/**/*.test.{ts,tsx}`]
  }
})
