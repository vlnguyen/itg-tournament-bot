import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    // Lets `vite dev` run standalone against the Nest API during frontend
    // work, without needing the whole process rebuilt for every change.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
