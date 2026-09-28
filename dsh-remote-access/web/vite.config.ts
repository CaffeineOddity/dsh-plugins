import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const root = path.dirname(fileURLToPath(import.meta.url))
const ui = path.resolve(root, '../../ui')

export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      '@ui': ui,
      react: path.join(ui, 'node_modules/react'),
      'react-dom': path.join(ui, 'node_modules/react-dom'),
      'react/jsx-runtime': path.join(ui, 'node_modules/react/jsx-runtime.js'),
      'react/jsx-dev-runtime': path.join(ui, 'node_modules/react/jsx-dev-runtime.js'),
      'lucide-react': path.join(ui, 'node_modules/lucide-react'),
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
  },
})
