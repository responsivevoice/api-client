import { defineConfig } from 'tsdown';
import { bannerFor } from './banner.ts';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'index.browser': 'src/index.browser.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  minify: false,
  outDir: 'dist',
  target: 'node16',
  banner: bannerFor(import.meta.url),
});
