import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/middlewares/cors.ts',
    'src/middlewares/static.ts',
    'src/middlewares/cookies.ts',
    'src/middlewares/logger.ts',
    'src/middlewares/rateLimit.ts',
  ],
  format: ['esm'],
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  target: 'node18',
  platform: 'node',
  esbuildOptions(options) {
    // Keep output wrapped so uncaught exceptions don't print one giant line snippet,
    // while preserving full minification.
    options.lineLimit = 120;
  },
  external: [
    'node:http',
    'node:stream',
    'node:buffer',
    'node:querystring',
    'node:url',
    'node:fs',
    'node:path',
  ],
});
