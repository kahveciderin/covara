import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  mode: 'development',
  define: {
    'process.env.NODE_ENV': '"development"',
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  resolve: {
    alias: {
      'covara/client/react': path.resolve(__dirname, '../../dist/client/react.js'),
      'covara/client': path.resolve(__dirname, '../../dist/client/index.js'),
    },
  },
});
