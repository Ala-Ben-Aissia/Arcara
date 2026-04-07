import { defineConfig } from 'tsup';

export default defineConfig({
  // Entry point — the barrel export is the only public surface.
  entry: ['src/index.ts'],

  // Dual output: ESM (.js) for modern bundlers and Node ESM,
  // CJS (.cjs) for CommonJS consumers and older toolchains.
  format: ['esm', 'cjs'],

  // dts: true alone uses tsup's internal declaration bundler which can miss
  // module augmentation blocks (our `declare module 'node:http'` in types/index.ts).
  // Using the object form with `resolve: true` ensures all augmentations are
  // bundled into the output .d.ts correctly, and `only: true` on a separate
  // dts-specific pass runs tsc directly rather than the bundler for declarations.
  //
  // Why not just dts: true?
  // tsup's bundler-based dts emit re-exports types but can silently drop
  // ambient `declare module` blocks. We need those for consumer autocompletion.
  // Use tsup's dts resolver to preserve module augmentations in the
  // bundled declaration output. We still run `tsc` separately in the
  // build pipeline to generate authoritative .d.ts files, but enabling
  // `resolve` here avoids augmentation loss when tsup is used interactively.
  // Defer declaration generation to `tsc` (build:dts). Avoid tsup's dts
  // bundler to prevent it from emitting a partial/bundled index.d.ts
  // that may omit triple-slash references or augmentation blocks.
  dts: false,

  minify: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  minifyWhitespace: true,

  // Delete dist/ before each build — prevents stale artifacts.
  clean: true,

  // No code splitting: Arcara is a single-entry library, not an app.
  splitting: false,

  // Tree-shake dead code from output.
  treeshake: true,

  // Point tsup's tsc invocation at the build-specific config.
  // This excludes tests and disables declarationMap for the publish artifact.
  tsconfig: 'tsconfig.build.json',

  // Target Node 18 minimum — no downleveling of syntax Node 18 supports natively.
  target: 'node18',

  // Node platform — marks node: built-ins as external automatically.
  platform: 'node',

  // No runtime deps to externalize.
  external: [],

  // Output extensions:
  // - ESM  → .js   (standard for "type": "module" projects)
  // - CJS  → .cjs  (unambiguous require() extension, avoids conflicts in
  //                 projects with "type": "module" in their package.json)
  //
  // tsup also emits .d.ts for ESM and .d.cts for CJS automatically
  // when the above extensions are set — both are needed in the exports map.
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
