import { defineConfig } from 'vitest/config';
import tsConfigPaths from 'vite-tsconfig-paths';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    // resolve the `src/*` path alias from tsconfig.json
    tsConfigPaths({ projects: ['./tsconfig.json'] }),
    // emitDecoratorMetadata is not supported by esbuild; SWC handles it
    swc.vite({ module: { type: 'es6' } }),
  ],
  test: {
    environment: 'node',
    // @keyv/redis (ESM) re-exports values from the CJS `keyv` package; force
    // them through the vite pipeline so named imports resolve correctly.
    server: {
      deps: {
        inline: [/@keyv\/redis/, /(^|\/)keyv($|\/)/, /cacheable/],
      },
    },
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
