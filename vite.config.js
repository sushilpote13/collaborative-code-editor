import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Cognito is imported by the auth screens up front. Rebuild the optimized
    // dependency cache on dev-server start so a browser cannot keep requesting
    // an aws-amplify bundle using a stale Vite version hash.
    force: true,
    include: ['aws-amplify', '@aws-amplify/auth', '@aws-amplify/core']
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true
      },
      "/socket.io": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
        ws: true
      }
    }
  }
})
