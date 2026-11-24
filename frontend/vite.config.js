import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

// Dev server notes
// - /api and /socket.io are proxied to the backend so the browser talks to ONE
//   origin. That is what makes phones on the LAN work: no "localhost" API URL,
//   no mixed content, and same-site cookies for token refresh.
// - Phones need HTTPS for the camera (QR scanner) and crypto APIs. Run
//   `npm run cert` once, then `npm run dev:lan` and open https://<your-LAN-IP>:5173.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backend = env.VITE_DEV_BACKEND_URL || 'http://127.0.0.1:8000'
  const certDir = path.resolve(process.cwd(), '.cert')
  const keyFile = path.join(certDir, 'key.pem')
  const certFile = path.join(certDir, 'cert.pem')
  const useHttps = env.VITE_DEV_HTTPS === 'true' && fs.existsSync(keyFile) && fs.existsSync(certFile)

  return {
    plugins: [
      tailwindcss(),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
    ],
    server: {
      host: env.VITE_DEV_HOST === 'lan' ? true : 'localhost',
      port: 5173,
      https: useHttps ? { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) } : undefined,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/socket.io': { target: backend, ws: true, changeOrigin: true },
      },
    },
    preview: {
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/socket.io': { target: backend, ws: true, changeOrigin: true },
      },
    },
  }
})
