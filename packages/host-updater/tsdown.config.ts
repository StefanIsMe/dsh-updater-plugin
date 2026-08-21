import { defineConfig } from 'tsdown'

/**
 * Package-local host build for @deepseek-ai/dsh-host-updater.
 * The root workspace tsdown pass builds every package and is red on this
 * machine (pre-existing type errors elsewhere), so this package builds itself
 * with the same host-face settings (entry lib/types, outDir lib, esm).
 * Typert artifacts are NOT regenerated here — they are produced by
 * scripts/typert-repair.mjs when missing.
 */
export default defineConfig({
  entry: ['lib/types/{index,invariant,tools}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
