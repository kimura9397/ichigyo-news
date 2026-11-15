import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // ビルド成果物は news-app/public に直接出力する。
    // これにより利用者はビルド不要で `node server.mjs` だけで新UIが動く。
    outDir: '../public',
    emptyOutDir: true,
  },
})
