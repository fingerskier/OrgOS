import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Dedicated test config so the dev/build vite.config.ts (with its proxy) is
// left untouched. Vitest prefers this file when present and does not read
// vite.config.ts, so the react() plugin is declared here as well.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
