import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.mjs',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5179', headless: true, viewport: { width: 390, height: 844 } },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5179 --strictPort',
    url: 'http://127.0.0.1:5179',
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:55441',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + crypto.randomUUID(),
      VITE_MOBILE: '0',
      VITE_DEMO: '0'
    }
  },
  reporter: 'list'
})
