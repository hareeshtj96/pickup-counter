import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Component tests run in jsdom with HTTP mocked at the fetch level. The real
// API is covered by the backend's PostgreSQL integration suite.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
