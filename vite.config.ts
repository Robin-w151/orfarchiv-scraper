import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    ssr: true,
    lib: {
      entry: {
        scraper: './src/index.ts',
      },
      formats: ['es'],
      name: 'scraper',
    },
    rollupOptions: {
      output: {
        manualChunks: {},
      },
    },
    emptyOutDir: true,
  },
});
