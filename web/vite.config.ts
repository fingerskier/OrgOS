import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const target = 'http://localhost:8787'
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target, changeOrigin: true },
      '/events': { target, changeOrigin: true },
      '/projections': { target, changeOrigin: true },
      '/stream': { target, changeOrigin: true },
    },
  },
})
