import { defineConfig } from 'tsup';
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/middlewares/cors.ts',
    'src/middlewares/cookies.ts',
    'src/middlewares/rateLimit.ts',
  ],
  format: ['esm', 'cjs'],
  minify: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  minifyWhitespace: true,
  clean: true,
  splitting: false,
  treeshake: true,
  tsconfig: 'tsconfig.build.json',
  sourcemap: false,
  target: 'node18',
  platform: 'node',
  external: [],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
