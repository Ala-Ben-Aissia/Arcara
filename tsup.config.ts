import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/middlewares/cors.ts',
    'src/utils/static.ts',
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
