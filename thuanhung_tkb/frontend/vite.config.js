import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4010',
    },
  },
  // Phase 32 UI tests. `environment: 'jsdom'` because the components
  // under test render to real DOM — there is no shallow-render layer
  // in this project, so there is nothing to configure beyond the
  // environment itself.
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{js,jsx}'],
    globals: true,
  },
});
