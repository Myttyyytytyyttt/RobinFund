import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // IDKit resolves its wasm-bindgen binary relative to import.meta.url.
    // Vite's dependency pre-bundle moves the JS into .vite/deps without
    // copying the sibling .wasm, so the request falls through to index.html.
    exclude: ['@worldcoin/idkit-core'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Permite importar los .md reales de ../docs como ?raw (fuente única de verdad)
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
})
